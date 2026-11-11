/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Between a finished scene and its snapshot: capture on the way out, GPU
 * staging and piece assignment on the way back in. Scene owns the state; these
 * read what it hands them and publish nothing.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';
import type { RenderPipeline } from './pipeline.js';
import type { SceneCaptureDrop, SceneSnapshot, SceneSnapshotBatch } from './scene-snapshot.js';
import { createStaticGpuBuffer } from './gpu-static-upload.js';
import { meshUniformArena, type MeshUniformSlot } from './mesh-uniform-arena.js';
import { destroyGpuResources } from './scene-geometry.js';

export interface MergedBatchBytes {
  vertexData: ArrayBuffer | Float32Array;
  indices: Uint32Array;
  lod1Indices?: Uint32Array;
}

/** What the capture needs to read off Scene once finalize has swapped. */
export interface FinishedSceneView {
  policy: string;
  pristine: boolean;
  nextSplitId: number;
  /** The queued piece a bucket's placed copy came from. */
  sourceOf: (piece: MeshData) => MeshData;
  sharedFrameOrigins: Iterable<[number, [number, number, number]]>;
  activeBuckets: Iterable<[string, string]>;
  buckets: Iterable<{ key: string; meshData: MeshData[]; batchedMesh: BatchedMesh | null; vertexBytes: number }>;
}

/**
 * Keeps the arrays one finalize already merged, until the swap proves they are
 * what the scene draws. Holds them by reference: nothing is copied or read back.
 */
export class FinishedBatchCapture {
  private readonly ordinals = new Map<MeshData, number>();
  private readonly merged = new Map<string, { batchId: number; bytes: MergedBatchBytes }>();
  /** The mesh each piece was split from, by ordinal; a mesh's pieces are consecutive. */
  readonly sources: MeshData[] = [];

  constructor(readonly onCaptured: (snapshot: SceneSnapshot, sources: readonly MeshData[]) => void, readonly onDropped?: (reason: SceneCaptureDrop) => void) {}

  get hasPieces(): boolean { return this.ordinals.size > 0; }

  notePiece(piece: MeshData, source: MeshData): void {
    this.ordinals.set(piece, this.ordinals.size);
    this.sources.push(source);
  }

  noteMerged(key: string, batchId: number, bytes: MergedBatchBytes): void { this.merged.set(key, { batchId, bytes }); }

  /** The snapshot, or null when the scene is not exactly the captured pieces merged once. */
  build(scene: FinishedSceneView): SceneSnapshot | null {
    if (!scene.pristine || this.ordinals.size === 0) return null;
    const batches: SceneSnapshotBatch[] = [];
    let pieces = 0;
    for (const bucket of scene.buckets) {
      const batch = bucket.batchedMesh;
      if (!batch || bucket.meshData.length === 0) {
        if (batch || bucket.meshData.length > 0) return null;
        continue;
      }
      const merged = this.merged.get(bucket.key);
      if (!merged || merged.batchId !== batch.id || batch.expressIds.length !== bucket.meshData.length) return null;
      const ordinals = new Uint32Array(bucket.meshData.length);
      for (let i = 0; i < ordinals.length; i++) {
        const ordinal = this.ordinals.get(scene.sourceOf(bucket.meshData[i]));
        if (ordinal === undefined || bucket.meshData[i].modelIndex) return null;
        ordinals[i] = ordinal;
      }
      pieces += ordinals.length;
      const { vertexData, indices, lod1Indices } = merged.bytes;
      batches.push({
        key: bucket.key, color: batch.color,
        ...(batch.finish ? { finish: batch.finish } : {}),
        ...(batch.origin ? { origin: batch.origin } : {}),
        ...(batch.bounds ? { bounds: batch.bounds } : {}),
        ...(batch.quantized ? { quantized: batch.quantized } : {}),
        ...(batch.modelIndices?.[0] !== undefined ? { modelIndex: batch.modelIndices[0] } : {}),
        vertexBytes: bucket.vertexBytes,
        expressIds: Uint32Array.from(batch.expressIds),
        ordinals,
        vertexData: vertexData instanceof ArrayBuffer ? new Uint8Array(vertexData) : new Uint8Array(vertexData.buffer, vertexData.byteOffset, vertexData.byteLength),
        indices,
        ...(lod1Indices ? { lod1Indices } : {}),
      });
    }
    if (pieces !== this.ordinals.size) return null;
    return { policy: scene.policy, pieceCount: pieces, nextSplitId: scene.nextSplitId,
      sharedFrameOrigins: [...scene.sharedFrameOrigins], activeBuckets: [...scene.activeBuckets], batches };
  }
}

/** Create every batch's GPU resources; on a throw, free what was created. */
export function stageSnapshotBatches(snapshot: SceneSnapshot, device: GPUDevice, pipeline: RenderPipeline, firstBatchId: number): BatchedMesh[] {
  const staged: BatchedMesh[] = [];
  let loose: GPUBuffer[] = [];
  let looseSlot: MeshUniformSlot | undefined;
  const track = (buffer: GPUBuffer): GPUBuffer => { loose.push(buffer); return buffer; };
  try {
    for (const source of snapshot.batches) {
      loose = [];
      looseSlot = undefined;
      const vertexBuffer = track(createStaticGpuBuffer(device, source.vertexData, GPUBufferUsage.VERTEX));
      const indexBuffer = track(createStaticGpuBuffer(device, source.indices, GPUBufferUsage.INDEX));
      const lod1IndexBuffer = source.lod1Indices ? track(createStaticGpuBuffer(device, source.lod1Indices, GPUBufferUsage.INDEX)) : undefined;
      const uniformSlot = looseSlot = meshUniformArena(device, pipeline.getUniformBufferSize()).allocate();
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(), entries: [
        { binding: 0, resource: { buffer: uniformSlot.buffer, offset: uniformSlot.offset, size: uniformSlot.size } },
      ] });
      const expressIds = Array.from(source.expressIds);
      staged.push({
        id: firstBatchId + staged.length, colorKey: source.key, vertexBuffer, indexBuffer,
        indexCount: source.indices.length, color: source.color,
        ...(source.finish ? { finish: source.finish } : {}),
        expressIds, bindGroup, uniformSlot,
        ...(source.bounds ? { bounds: source.bounds } : {}),
        modelIndices: expressIds.map(() => source.modelIndex),
        ...(source.origin ? { origin: source.origin } : {}),
        ...(lod1IndexBuffer ? { lod1IndexBuffer, lod1IndexCount: source.lod1Indices!.length } : {}),
        ...(source.quantized ? { quantized: source.quantized } : {}),
      });
      loose = [];
      looseSlot = undefined;
    }
    return staged;
  } catch (error) {
    looseSlot?.release();
    for (const buffer of loose) buffer.destroy();
    for (const batch of staged) destroyGpuResources(batch);
    throw error;
  }
}

/**
 * Each batch's pieces in merge order, from the load's own pieces. Null when
 * they are not the pieces the snapshot was merged from.
 */
export function assignSnapshotPieces(snapshot: SceneSnapshot, pieces: readonly MeshData[]): Map<string, MeshData[]> | null {
  if (pieces.length !== snapshot.pieceCount) return null;
  const seen = new Uint8Array(pieces.length);
  const assigned = new Map<string, MeshData[]>();
  for (const batch of snapshot.batches) {
    const parts: MeshData[] = [];
    let indexCount = 0;
    for (let i = 0; i < batch.ordinals.length; i++) {
      const ordinal = batch.ordinals[i];
      const piece = pieces[ordinal];
      if (!piece || seen[ordinal] || piece.expressId !== batch.expressIds[i]) return null;
      seen[ordinal] = 1;
      indexCount += piece.indices.length;
      parts.push(piece);
    }
    if (indexCount !== batch.indices.length) return null;
    assigned.set(batch.key, parts);
  }
  return assigned;
}

/**
 * The snapshot with its piece ordinals moved from the order the pieces were
 * queued in to the order `target` lists their meshes, which is the order a
 * reopen decodes and hydrates them in. `sources[ordinal]` is each piece's mesh,
 * as the capture reported it. Meshes of `target` that were never queued (a
 * hidden type) are skipped, as a hydrating reopen skips them. Null when
 * `target` is missing a queued mesh, so hydration could only refuse the result.
 */
export function reorderSnapshotPieces(snapshot: SceneSnapshot, sources: readonly MeshData[], target: readonly MeshData[]): SceneSnapshot | null {
  if (sources.length !== snapshot.pieceCount) return null;
  const firstOrdinal = new Map<MeshData, number>();
  for (let i = 0; i < sources.length; i++) {
    const known = firstOrdinal.get(sources[i]);
    if (known === undefined) firstOrdinal.set(sources[i], i);
    else if (sources[i - 1] !== sources[i]) return null; // a mesh queued twice
  }
  const moved = new Map<MeshData, number>();
  let next = 0;
  for (const mesh of target) {
    const first = firstOrdinal.get(mesh);
    if (first === undefined || moved.has(mesh)) continue;
    moved.set(mesh, next);
    let end = first;
    while (end < sources.length && sources[end] === mesh) end++;
    next += end - first;
  }
  if (next !== sources.length) return null;
  const remap = new Uint32Array(sources.length);
  for (let i = 0; i < sources.length; i++) remap[i] = moved.get(sources[i])! + (i - firstOrdinal.get(sources[i])!);
  return { ...snapshot, batches: snapshot.batches.map((batch) => ({ ...batch, ordinals: batch.ordinals.map((o) => remap[o]) })) };
}
