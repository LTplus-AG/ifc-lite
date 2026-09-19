/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh, Mesh } from './types.js';
import type { InstancedOccurrence, InstancedTemplateCpu, InstancedTemplateGPU } from './scene-instance-types.js';
import type { TexturedMesh } from './scene.js';
import { destroyGpuResources } from './scene-geometry.js';
import { cloneOverrides } from './scene-derived-batches.js';
import { foldOccurrenceWorldBox, INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import { composeInstancedOverrideColor } from './instanced-override-color.js';

interface RecoveryBucket {
  key: string;
  meshData: MeshData[];
  batchedMesh: BatchedMesh | null;
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
  meshes: Mesh[];
  batchedMeshes: BatchedMesh[];
  buckets: Map<string, RecoveryBucket>;
  coldBuckets: Set<string>;
  texturedMeshes: TexturedMesh[];
  sharedTextures: Map<number, { texture: GPUTexture; refs: number }>;
  rgbaTexturePool: { clear(): void };
  texturedDevice?: GPUDevice;
  instancedTemplates: (InstancedTemplateGPU | undefined)[];
  liveInstancedTemplates: InstancedTemplateGPU[];
  instancedTemplateCpu: (InstancedTemplateCpu | undefined)[];
  instancedEntityMap: Map<number, InstancedOccurrence[]>;
  instancedSelected: Set<number>;
  instancedOverrideColors: ReadonlyMap<number, readonly [number, number, number, number]> | null;
  instancedGhosted: Set<number>;
  lastGhostAlpha: number;
  instancedDevice?: GPUDevice;
  cachedMaxBufferSize: number;
  lastDrawnFrame: Map<number, number>;
  residencyRestoreQueue: Set<string>;
  meshDataMap: Map<number, MeshData[]>;
  colorOverrides: ReadonlyMap<number, readonly [number, number, number, number]> | null;
  appearanceAccessState?: unknown;
  drainColdTier(): Promise<void>;
  dropAllPartialCaches(): void;
  destroyOverrideBatches(): void;
  releaseTexturedMeshTexture(mesh: Pick<TexturedMesh, 'texture' | 'sharedTextureKey'>): void;
  bindAppearanceAccess(device: GPUDevice, pipeline: RenderPipeline): unknown;
  createBatchedMesh(
    meshes: MeshData[], color: [number, number, number, number],
    device: GPUDevice, pipeline: RenderPipeline, bucketKey?: string,
  ): BatchedMesh;
  createTexturedMesh(mesh: MeshData, device: GPUDevice, pipeline: RenderPipeline): void;
  setColorOverrides(
    colors: ReadonlyMap<number, readonly [number, number, number, number]>,
    device: GPUDevice,
    pipeline: RenderPipeline,
  ): void;
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

export async function prepareSceneDeviceRecovery(host: SceneRecoveryHost): Promise<SceneDeviceRecoveryPreparation> {
  const initialBlocker = recoveryBlocker(host);
  if (initialBlocker) return initialBlocker;
  await host.drainColdTier();
  const lateBlocker = recoveryBlocker(host);
  if (lateBlocker) return lateBlocker;
  return host.coldBuckets.size > 0 ? { ok: false, reason: 'cold-restore-failed' } : { ok: true };
}

export function discardSceneGpuResourcesForRecovery(host: SceneRecoveryHost): void {
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
  host.destroyOverrideBatches();
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
      vertexBuffer = device.createBuffer({ size: vertexData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
      new Uint8Array(vertexBuffer.getMappedRange()).set(new Uint8Array(vertexData)); vertexBuffer.unmap();
      indexBuffer = device.createBuffer({ size: cpu.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
      new Uint32Array(indexBuffer.getMappedRange()).set(cpu.indices); indexBuffer.unmap();
      instanceBuffer = device.createBuffer({ size: cpu.instanceData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
      new Uint8Array(instanceBuffer.getMappedRange()).set(new Uint8Array(cpu.instanceData)); instanceBuffer.unmap();
      host.instancedTemplates[slot] = {
        modelIndex: cpu.modelIndex, vertexBuffer, indexBuffer, indexCount: cpu.indices.length,
        instanceBuffer, instanceCount: cpu.instanceData.byteLength / INSTANCE_STRIDE_BYTES,
        bounds: null, maxOccRadius: 0, selectedCount: 0,
      };
    } catch (error) {
      vertexBuffer?.destroy(); indexBuffer?.destroy(); instanceBuffer?.destroy();
      throw error;
    }
  }
  for (const [eid, occurrences] of host.instancedEntityMap) {
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
    const batches = host.batchedMeshes.filter((batch) => batch.gpuResident === false);
    host.batchedMeshes = batches;
    for (const bucket of host.buckets.values()) {
      if (bucket.batchedMesh?.gpuResident === false || bucket.meshData.length === 0) continue;
      const batch = host.createBatchedMesh(bucket.meshData, bucket.meshData[0].color, device, pipeline, bucket.key);
      bucket.batchedMesh = batch;
      batches.push(batch);
    }
    const textured = new Set<MeshData>();
    for (const pieces of host.meshDataMap.values()) {
      for (const piece of pieces) if (hasRenderableTexture(piece)) textured.add(piece);
    }
    for (const piece of textured) host.createTexturedMesh(piece, device, pipeline);
    restoreInstancedTemplates(host, device);
    if (host.colorOverrides) host.setColorOverrides(cloneOverrides(host.colorOverrides), device, pipeline);
    else restoreInstancedAppearance(host, device);
  } catch (error) {
    discardSceneGpuResourcesForRecovery(host);
    throw error;
  }
}
