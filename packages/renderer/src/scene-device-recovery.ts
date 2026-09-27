/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh, Mesh } from './types.js';
import type { InstancedOccurrence, InstancedTemplateCpu, InstancedTemplateGPU } from './scene-instance-types.js';
import type { TexturedMesh } from './scene.js';
import { destroyGpuResources, splitMeshDataForBufferLimit } from './scene-geometry.js';
import { cloneOverrides } from './scene-derived-batches.js';
import { foldOccurrenceWorldBox, INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import { composeInstancedOverrideColor } from './instanced-override-color.js';
import { BATCH_CONSTANTS } from './constants.js';
import { createSceneBatchShell } from './scene-batch-upload.js';
import { createStaticGpuBuffer } from './gpu-static-upload.js';

export interface RecoveryBucket {
  key: string;
  meshData: MeshData[];
  batchedMesh: BatchedMesh | null;
  vertexBytes: number;
}

interface WorldBox {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface SceneRecoveryHost {
  geometryReleased: boolean;
  ephemeralStreamingMode: boolean;
  finalizeInProgress: boolean;
  streamingFragments: BatchedMesh[];
  pendingBatchKeys: Set<string>;
  appearanceController?: { hasActiveDrafts(): boolean };
  appearanceBuckets?: { forget(): void };
  authoredGeneration: number;
  authoredPreparations: { invalidate(): void };
  meshes: Mesh[];
  batchedMeshes: BatchedMesh[];
  buckets: Map<string, RecoveryBucket>;
  meshDataBucket: Map<MeshData, RecoveryBucket>;
  activeBucketKey: Map<string, string>;
  dirtyBuckets: Set<string>;
  nextSplitId: number;
  nextBatchId: number;
  coldBuckets: Set<string>;
  texturedMeshes: TexturedMesh[];
  sharedTextures: Map<number, { texture: GPUTexture; refs: number }>;
  rgbaTexturePool: { clear(): void };
  texturedDevice?: GPUDevice;
  instancedTemplates: (InstancedTemplateGPU | undefined)[];
  liveInstancedTemplates: InstancedTemplateGPU[];
  instancedTemplateCpu: (InstancedTemplateCpu | undefined)[];
  instancedEntityMap: Map<number, InstancedOccurrence[]>;
  instanceSuppression: { has(expressId: number): boolean };
  instancedSelected: Set<number>;
  instancedOverrideColors: ReadonlyMap<number, readonly [number, number, number, number]> | null;
  instancedOverridden: Set<number>;
  instancedHasTransparent: boolean;
  instancedGhosted: Set<number>;
  lastGhostAlpha: number;
  instancedDevice?: GPUDevice;
  cachedMaxBufferSize: number;
  lastDrawnFrame: Map<number, number>;
  residencyRestoreQueue: Set<string>;
  meshDataMap: Map<number, MeshData[]>;
  colorOverrides: ReadonlyMap<number, readonly [number, number, number, number]> | null;
  appearanceAccessState?: unknown;
  modelTranslations: { registerDrawable<T>(drawable: T, modelIndex: number): T };
  dropAllPartialCaches(): void;
  releaseColorOverrideGpu(): void;
  releaseTexturedMeshTexture(mesh: Pick<TexturedMesh, 'texture' | 'sharedTextureKey'>): void;
  bindAppearanceAccess(device: GPUDevice, pipeline: RenderPipeline): unknown;
  createBatchedMesh(
    meshes: MeshData[], color: [number, number, number, number],
    device: GPUDevice, pipeline: RenderPipeline, bucketKey?: string,
  ): BatchedMesh;
  createTexturedMesh(mesh: MeshData, device: GPUDevice, pipeline: RenderPipeline): void;
  setColorOverrides(colors: Map<number, [number, number, number, number]>, device: GPUDevice, pipeline: RenderPipeline): void;
  writeInstanceFlags(device: GPUDevice, eid: number): void;
  writeInstanceColor(device: GPUDevice, eid: number, color: readonly [number, number, number, number]): void;
  writeOriginalInstanceColors(device: GPUDevice, eid: number, alpha: number): void;
  unionInstancedWorldAabb(
    eid: number, view: DataView, offset: number,
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): WorldBox;
  refreshLiveInstancedTemplates(): void;
}

export type SceneDeviceRecoveryPreparation =
  | { ok: true }
  | { ok: false; reason: 'cpu-geometry-released' | 'scene-not-settled' | 'unsupported-authored-meshes' | 'cold-restore-failed' };

function recoveryBlocker(host: SceneRecoveryHost): Exclude<SceneDeviceRecoveryPreparation, { ok: true }> | null {
  if (host.geometryReleased || host.ephemeralStreamingMode) {
    return { ok: false, reason: 'cpu-geometry-released' };
  }
  if (
    host.finalizeInProgress || host.streamingFragments.length > 0 || host.pendingBatchKeys.size > 0 ||
    host.appearanceController?.hasActiveDrafts()
  ) {
    return { ok: false, reason: 'scene-not-settled' };
  }
  if (host.meshes.some((mesh) => !mesh.hydrated)) {
    return { ok: false, reason: 'unsupported-authored-meshes' };
  }
  return null;
}

export function prepareSceneDeviceRecovery(host: SceneRecoveryHost): SceneDeviceRecoveryPreparation {
  const initialBlocker = recoveryBlocker(host);
  if (initialBlocker) return initialBlocker;
  // Cold buckets already carry GPU-free shells and remain provider-restorable.
  // Warming them here would defeat the host-residency budget during recovery.
  return { ok: true };
}

export function discardSceneGpuResourcesForRecovery(
  host: SceneRecoveryHost,
): void {
  // Fence detached authoring transactions before any old-device handle dies.
  // Their commit validation will release the staged buffers instead of
  // publishing them into the recovered scene.
  host.authoredGeneration++;
  host.authoredPreparations.invalidate();
  const evicted = new Set<BatchedMesh>();
  for (const bucket of host.buckets.values()) {
    if (bucket.batchedMesh?.gpuResident === false) evicted.add(bucket.batchedMesh);
  }
  for (const mesh of host.meshes) destroyGpuResources(mesh);
  host.meshes = [];
  for (const batch of host.batchedMeshes) if (!evicted.has(batch)) destroyGpuResources(batch);
  host.batchedMeshes = [...evicted];
  for (const bucket of host.buckets.values()) {
    if (!bucket.batchedMesh || !evicted.has(bucket.batchedMesh)) bucket.batchedMesh = null;
  }
  host.dropAllPartialCaches();
  host.releaseColorOverrideGpu();
  for (const mesh of host.texturedMeshes) {
    mesh.vertexBuffer.destroy(); mesh.indexBuffer.destroy(); mesh.uniformBuffer.destroy();
    host.releaseTexturedMeshTexture(mesh);
  }
  host.texturedMeshes = [];
  for (const entry of host.sharedTextures.values()) entry.texture.destroy();
  host.sharedTextures.clear(); host.rgbaTexturePool.clear(); host.texturedDevice = undefined;
  for (const template of host.instancedTemplates) {
    template?.vertexBuffer.destroy(); template?.indexBuffer.destroy(); template?.instanceBuffer.destroy();
  }
  host.instancedTemplates = new Array(host.instancedTemplateCpu.length);
  host.liveInstancedTemplates = [];
  host.instancedDevice = undefined;
  host.cachedMaxBufferSize = 0;
  host.lastDrawnFrame.clear();
  host.residencyRestoreQueue.clear();
}

const bucketVertexBytes = (parts: readonly MeshData[]) => parts.reduce(
  (sum, part) => sum + (part.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX,
  0,
);

function nextRecoveryBucketKey(host: SceneRecoveryHost, base: string): string {
  let key: string;
  do key = `${base}#${host.nextSplitId++}`;
  while (host.buckets.has(key));
  return key;
}

/** Split a newly hydrated cold bucket against the replacement adapter limit
 * before any GPU upload. Each returned shell can then restore independently. */
export function repartitionHydratedRecoveryBucket(
  host: SceneRecoveryHost, key: string, bucket: RecoveryBucket, shell: BatchedMesh,
): string[] {
  const chunks = splitMeshDataForBufferLimit(bucket.meshData, host.cachedMaxBufferSize);
  if (chunks.length <= 1) return [key];
  const hash = key.lastIndexOf('#'), baseKey = hash >= 0 ? key.slice(0, hash) : key;
  const shells: BatchedMesh[] = [], keys: string[] = [];
  host.buckets.delete(key);
  for (let index = 0; index < chunks.length; index++) {
    const targetKey = nextRecoveryBucketKey(host, baseKey);
    const parts = chunks[index];
    const target = index === 0 ? bucket : { key: targetKey, meshData: [], batchedMesh: null, vertexBytes: 0 };
    const nextShell = host.modelTranslations.registerDrawable(
      createSceneBatchShell(parts, shell, host.nextBatchId++, targetKey), parts[0].modelIndex ?? 0,
    );
    target.key = targetKey; target.meshData = parts; target.batchedMesh = nextShell;
    target.vertexBytes = bucketVertexBytes(parts); host.buckets.set(targetKey, target);
    for (const part of parts) host.meshDataBucket.set(part, target);
    shells.push(nextShell); keys.push(targetKey);
  }
  const shellIndex = host.batchedMeshes.indexOf(shell);
  if (shellIndex >= 0) host.batchedMeshes.splice(shellIndex, 1, ...shells);
  else host.batchedMeshes.push(...shells);
  host.lastDrawnFrame.delete(shell.id); host.activeBucketKey.set(baseKey, keys.at(-1)!);
  host.appearanceBuckets?.forget();
  return keys;
}

function restoreFlatBuckets(
  host: SceneRecoveryHost,
  device: GPUDevice,
  pipeline: RenderPipeline,
): void {
  const maxBufferSize = Math.floor(
    (device.limits?.maxBufferSize ?? BATCH_CONSTANTS.FALLBACK_MAX_BUFFER_SIZE) *
      BATCH_CONSTANTS.BUFFER_SIZE_SAFETY_FACTOR,
  );
  host.cachedMaxBufferSize = maxBufferSize;
  const restored: BatchedMesh[] = [];
  host.batchedMeshes = restored;
  let repartitioned = false;

  // Recovery can repartition and replace entries, so iterate a stable snapshot.
  const originalBuckets = Array.from(host.buckets);
  for (const [originalKey, bucket] of originalBuckets) {
    if (bucket.meshData.length === 0) {
      if (bucket.batchedMesh?.gpuResident === false) restored.push(bucket.batchedMesh);
      continue;
    }
    const chunks = splitMeshDataForBufferLimit(bucket.meshData, maxBufferSize);
    if (chunks.length === 1) {
      if (bucket.batchedMesh?.gpuResident === false) {
        restored.push(bucket.batchedMesh);
      } else {
        const batch = host.createBatchedMesh(chunks[0], chunks[0][0].color, device, pipeline, originalKey);
        bucket.batchedMesh = batch;
        restored.push(batch);
      }
      continue;
    }

    repartitioned = true;
    const evicted = bucket.batchedMesh?.gpuResident === false;
    const evictedShell = bucket.batchedMesh;
    const dirty = host.dirtyBuckets.has(originalKey);
    const hash = originalKey.lastIndexOf('#');
    const baseKey = hash >= 0 ? originalKey.slice(0, hash) : originalKey;
    const staged: Array<{ key: string; parts: MeshData[]; batch: BatchedMesh }> = [];
    try {
      for (const parts of chunks) {
        const key = nextRecoveryBucketKey(host, baseKey);
        const batch = evicted
          ? host.modelTranslations.registerDrawable(
              createSceneBatchShell(parts, evictedShell!, host.nextBatchId++, key),
              parts[0].modelIndex ?? 0,
            )
          : host.createBatchedMesh(parts, parts[0].color, device, pipeline, key);
        staged.push({ key, parts, batch });
      }
    } catch (error) {
      // None of the staged batches is reachable from the scene yet, so the
      // outer recovery cleanup cannot see it. Release successful allocations
      // here and leave the original CPU bucket intact for the automatic retry.
      if (!evicted) for (const entry of staged) destroyGpuResources(entry.batch);
      throw error;
    }

    // Commit only after every replacement exists. Until this point the source
    // bucket and every meshDataBucket edge still describe the complete model.
    host.buckets.delete(originalKey);
    host.dirtyBuckets.delete(originalKey);
    for (let index = 0; index < staged.length; index++) {
      const { key, parts, batch } = staged[index];
      const target = index === 0 ? bucket : { key, meshData: [], batchedMesh: null, vertexBytes: 0 };
      target.key = key;
      target.meshData = parts;
      target.vertexBytes = bucketVertexBytes(parts);
      target.batchedMesh = batch;
      host.buckets.set(key, target);
      for (const part of parts) host.meshDataBucket.set(part, target);
      if (dirty) host.dirtyBuckets.add(key);
      restored.push(batch);
    }
    host.activeBucketKey.set(baseKey, staged.at(-1)!.key);
  }
  if (repartitioned) host.appearanceBuckets?.forget();
}

function restoreInstancedTemplates(host: SceneRecoveryHost, device: GPUDevice): void {
  host.instancedDevice = device;
  host.instancedTemplates = new Array(host.instancedTemplateCpu.length);
  for (let slot = 0; slot < host.instancedTemplateCpu.length; slot++) {
    const cpu = host.instancedTemplateCpu[slot];
    if (!cpu) continue;
    let vertexBuffer: GPUBuffer | undefined, indexBuffer: GPUBuffer | undefined, instanceBuffer: GPUBuffer | undefined;
    try {
      const vertexData = new ArrayBuffer((cpu.positions.length / 3) * 28);
      const floats = new Float32Array(vertexData);
      for (let i = 0; i < cpu.positions.length / 3; i++) {
        const offset = i * 7;
        floats[offset] = cpu.positions[i * 3]; floats[offset + 1] = cpu.positions[i * 3 + 1]; floats[offset + 2] = cpu.positions[i * 3 + 2];
        floats[offset + 3] = cpu.normals[i * 3] ?? 0; floats[offset + 4] = cpu.normals[i * 3 + 1] ?? 0; floats[offset + 5] = cpu.normals[i * 3 + 2] ?? 0;
      }
      vertexBuffer = createStaticGpuBuffer(device, vertexData, GPUBufferUsage.VERTEX);
      indexBuffer = createStaticGpuBuffer(device, cpu.indices, GPUBufferUsage.INDEX);
      instanceBuffer = createStaticGpuBuffer(device, cpu.instanceData, GPUBufferUsage.VERTEX);
      host.instancedTemplates[slot] = {
        modelIndex: cpu.modelIndex, vertexBuffer, indexBuffer, indexCount: cpu.indices.length,
        instanceBuffer, instanceCount: cpu.instanceData.byteLength / INSTANCE_STRIDE_BYTES,
        canonicalAnchors: cpu.canonicalAnchors,
        bounds: null, maxOccRadius: 0, selectedCount: 0,
      };
    } catch (error) {
      vertexBuffer?.destroy(); indexBuffer?.destroy(); instanceBuffer?.destroy();
      throw error;
    }
  }
  for (const [eid, occurrences] of host.instancedEntityMap) {
    if (host.instanceSuppression.has(eid)) continue;
    for (const occurrence of occurrences) {
      const cpu = host.instancedTemplateCpu[occurrence.templateIndex];
      const template = host.instancedTemplates[occurrence.templateIndex];
      if (!cpu || !template || !Number.isFinite(cpu.localMin[0])) continue;
      const world = host.unionInstancedWorldAabb(
        eid, new DataView(cpu.instanceData), occurrence.byteOffset,
        cpu.localMin[0], cpu.localMin[1], cpu.localMin[2], cpu.localMax[0], cpu.localMax[1], cpu.localMax[2],
      );
      foldOccurrenceWorldBox(template, world);
      if (host.instancedSelected.has(eid)) template.selectedCount++;
    }
  }
  host.refreshLiveInstancedTemplates();
}

function hasRenderableTexture(mesh: MeshData): boolean {
  return Boolean(mesh.uvs) && Boolean(mesh.texture || (mesh.textureRef && mesh.textureBitmap));
}

function restoreInstancedAppearance(host: SceneRecoveryHost, device: GPUDevice): void {
  for (const eid of host.instancedEntityMap.keys()) {
    host.writeInstanceFlags(device, eid);
    const override = host.instancedOverrideColors?.get(eid);
    if (override) {
      host.writeInstanceColor(device, eid, composeInstancedOverrideColor(override, host.instancedGhosted.has(eid), host.lastGhostAlpha));
    } else if (host.instancedGhosted.has(eid)) {
      host.writeOriginalInstanceColors(device, eid, host.lastGhostAlpha);
    }
  }
}

export function restoreSceneGpuResourcesAfterRecovery(
  host: SceneRecoveryHost,
  device: GPUDevice,
  pipeline: RenderPipeline,
): void {
  try {
    if (host.appearanceAccessState) host.bindAppearanceAccess(device, pipeline);
    restoreFlatBuckets(host, device, pipeline);
    const textured = new Set<MeshData>();
    for (const pieces of host.meshDataMap.values()) {
      for (const piece of pieces) if (hasRenderableTexture(piece)) textured.add(piece);
    }
    for (const piece of textured) host.createTexturedMesh(piece, device, pipeline);
    restoreInstancedTemplates(host, device);
    if (host.colorOverrides) {
      const instanced = host.instancedOverrideColors;
      const overridden = host.instancedOverridden;
      const transparent = host.instancedHasTransparent;
      host.setColorOverrides(cloneOverrides(host.colorOverrides), device, pipeline);
      host.instancedOverrideColors = instanced;
      host.instancedOverridden = overridden;
      host.instancedHasTransparent = transparent;
    }
    restoreInstancedAppearance(host, device);
  } catch (error) {
    discardSceneGpuResourcesForRecovery(host);
    throw error;
  }
}
