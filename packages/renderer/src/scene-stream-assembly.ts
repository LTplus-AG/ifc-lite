/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build a streamed bucket's final batch from the fragments that already drew
 * its meshes, instead of merging, checking, quantizing and uploading them all a
 * second time.
 *
 * While a model streams, each append uploads its meshes as throwaway fragment
 * batches, grouped by the bucket each mesh joined. Finalize then rebuilds every
 * streamed bucket from its meshes (`createSceneBatch`). The rebuild's vertex
 * records are exactly the concatenation of that bucket's fragments' records
 * when (a) the fragments hold exactly the bucket's meshes, whole and in order,
 * (b) they share the frame origin the rebuild would choose, and (c) they share
 * one encoding: f32, or quantized against one lattice origin. The vertex
 * buffer is then a GPU copy of the fragments' buffers. Only the indices are
 * rebased on the CPU (they are fragment-local), and the bucket's LOD1 is built
 * from a positions-and-entity gather, the only part of the merged records it
 * reads. Anything else falls back to the full rebuild.
 *
 * Output: the indices, bounds, LOD1, entity lane and normals are those of the
 * rebuild. Quantized positions are encoded against the shared lattice origin
 * rather than the batch's own minimum, which decodes to the same exact
 * positions (see `LatticeFrame`). The rebuild quantizes when no entity loses
 * over 1% of its area on the lattice (#9068) and the extent fits; every
 * fragment passing that check implies the union passes it (per entity, the
 * collapsed share of a union is at most the largest share of its parts), and
 * fitting one lattice origin implies fitting the batch's own.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { perfCount, perfTally } from '@ifc-lite/load-trace';
import type { BatchedMesh } from './types.js';
import type { RenderPipeline } from './pipeline.js';
import type { LatticeFrame } from './quantize.js';
import { QUANT_BYTES_PER_VERTEX } from './quantize.js';
import { BATCH_CONSTANTS } from './constants.js';
import { TopologyMemo } from './scene-precision.js';
import { colorSaltByte, entityLaneOf, packEntityLane } from './scene-geometry.js';
import { createBatchUniform } from './scene-batch-upload.js';
import type { BatchQuantization } from './scene-derived-batches.js';
import type { MergedBatchBytes } from './scene-snapshot-batches.js';
import { createStaticGpuBuffer } from './gpu-static-upload.js';
import type { MeshUniformSlot } from './mesh-uniform-arena.js';
import { LOD_MIN_TRIANGLES, lodCellSizeForBounds, simplifyIndicesByClustering } from './lod-simplify.js';

/** What one fragment uploaded: whole registered meshes, in upload order. */
interface FragmentRun {
  readonly fragment: BatchedMesh;
  readonly meshes: readonly MeshData[];
  /** Each mesh's colour salt in the entity lane when uploaded: an in-place recolour that keeps its bucket still changes it. */
  readonly salts: Uint8Array;
  /** The vertex bytes it uploaded, kept only while a snapshot capture needs every final batch's bytes. */
  readonly bytes?: ArrayBuffer | Float32Array;
}

export interface AssembleOptions {
  id: number;
  colorKey: string;
  /** The frame `createSceneBatch` would have used for these meshes. */
  origin: [number, number, number];
  quantized: BatchQuantization;
  lod: boolean;
  /** A snapshot capture's sink: handed the assembled batch's bytes, which needs every run's kept bytes. */
  onMerged?: (bytes: MergedBatchBytes) => void;
}

/** Per-stream bookkeeping, from a stream's first append to its finalize swap. */
export class StreamAssembly {
  /**
   * Topology verdicts for the stream. Each streamed mesh is asked the same
   * (mesh, frame) question by its append's validation and routing, its
   * fragment's upload, the finalize re-group and its final batch; a per-append
   * memo (#8241) still scanned it three more times. Dropped at the swap and by
   * every in-place geometry edit.
   */
  topology: TopologyMemo | null = null;
  private readonly lattices = new Map<string, LatticeFrame>();
  /** Keyed by the run's first mesh. */
  private readonly runs = new Map<MeshData, FragmentRun>();
  /** The fragments each pending finalize retires, oldest first: a synchronous finalize can run inside an async one's window. */
  private readonly finalizing: ReadonlySet<BatchedMesh>[] = [];
  /** A fragment's uploaded vertex bytes while a capture is armed, until `record` takes them. */
  private readonly kept = new WeakMap<BatchedMesh, ArrayBuffer | Float32Array>();

  streamTopology(): TopologyMemo {
    return (this.topology ??= new TopologyMemo());
  }

  /** The lattice origin every fragment of `bucketKey` encodes against when it fits. */
  latticeFor(bucketKey: string): LatticeFrame {
    let lattice = this.lattices.get(bucketKey);
    if (!lattice) this.lattices.set(bucketKey, (lattice = {}));
    return lattice;
  }

  /** Record a fragment uploaded from these registered meshes, whole and in this order (with its kept bytes, if any). */
  record(fragment: BatchedMesh, meshes: readonly MeshData[]): void {
    const bytes = this.kept.get(fragment);
    this.kept.delete(fragment);
    if (meshes.length > 0) this.runs.set(meshes[0], { fragment, meshes, salts: Uint8Array.from(meshes, (mesh) => colorSaltByte(mesh.color)), bytes });
  }

  keepBytes(fragment: BatchedMesh, bytes: ArrayBuffer | Float32Array): void { this.kept.set(fragment, bytes); }

  /** Positions changed in place: no fragment's bytes, nor any verdict, can be trusted. */
  invalidate(): void {
    this.runs.clear();
    this.topology = null;
  }

  /** Fragments a finalize may assemble from: the ones it is about to retire. */
  beginFinalize(fragments: readonly BatchedMesh[]): ReadonlySet<BatchedMesh> {
    const retiring = new Set(fragments);
    this.finalizing.push(retiring);
    return retiring;
  }

  /** At the finalize swap: forget the retired fragments and the stream's verdicts. */
  endFinalize(retiring: ReadonlySet<BatchedMesh> | undefined = this.finalizing[this.finalizing.length - 1]): void {
    const at = retiring ? this.finalizing.indexOf(retiring) : -1;
    if (at < 0) return;
    this.finalizing.splice(at, 1);
    for (const [mesh, run] of this.runs) if (retiring!.has(run.fragment)) this.runs.delete(mesh);
    if (this.finalizing.length > 0) return; // the stream's verdicts serve the pending one
    this.topology = null;
  }

  clear(): void {
    this.runs.clear();
    this.lattices.clear();
    this.finalizing.length = 0;
    this.topology = null;
  }

  /**
   * The final batch for `meshes`, assembled from live fragments, or `null` when
   * they do not provably reproduce the full rebuild (the caller rebuilds then).
   */
  assemble(
    meshes: readonly MeshData[], color: [number, number, number, number],
    device: GPUDevice, pipeline: RenderPipeline, options: AssembleOptions,
  ): BatchedMesh | null {
    if (this.finalizing.length === 0) return null; // only a finalize assembles, from the fragments it retires
    const runs = this.cover(meshes);
    const miss = !runs ? 'uncovered' : encodingMiss(runs, options) ?? (options.onMerged && runs.some((run) => !run.bytes) ? 'capture' : null);
    if (miss || !runs) {
      perfCount(`render.finalize.rebuilt.${miss}`);
      return null;
    }
    const quantized = runs[0].fragment.quantized;
    const stride = quantized ? QUANT_BYTES_PER_VERTEX : BATCH_CONSTANTS.BYTES_PER_VERTEX;

    let vertexCount = 0;
    let indexCount = 0;
    for (const mesh of meshes) {
      vertexCount += mesh.positions.length / 3;
      indexCount += mesh.indices.length;
    }
    const indices = new Uint32Array(indexCount);
    let base = 0;
    let at = 0;
    for (const mesh of meshes) {
      const source = mesh.indices;
      for (let i = 0; i < source.length; i++) indices[at + i] = source[i] + base;
      at += source.length;
      base += mesh.positions.length / 3;
    }
    const bounds = unionBounds(runs);

    const allocated: GPUBuffer[] = [];
    let uniformSlot: MeshUniformSlot | undefined;
    const track = (buffer: GPUBuffer): GPUBuffer => { allocated.push(buffer); return buffer; };
    try {
      const vertexBytes = vertexCount * stride;
      const vertexBuffer = track(device.createBuffer({
        size: Math.max(4, Math.ceil(vertexBytes / 4) * 4),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }));
      const encoder = device.createCommandEncoder();
      let offset = 0;
      for (const { fragment, meshes: own } of runs) {
        let bytes = 0;
        for (const mesh of own) bytes += (mesh.positions.length / 3) * stride;
        if (bytes > 0) encoder.copyBufferToBuffer(fragment.vertexBuffer, 0, vertexBuffer, offset, bytes);
        offset += bytes;
      }
      device.queue.submit([encoder.finish()]);
      perfTally('gpu.assembleCopy', offset);
      const indexBuffer = track(createStaticGpuBuffer(device, indices, GPUBufferUsage.INDEX));
      const uniform = createBatchUniform(device, pipeline);
      uniformSlot = uniform.uniformSlot;

      let lod1IndexBuffer: GPUBuffer | undefined;
      let lod1IndexCount: number | undefined;
      let lodIndices: Uint32Array | null = null;
      if (options.lod && indices.length >= LOD_MIN_TRIANGLES * 3) {
        const cellSize = lodCellSizeForBounds(bounds.min, bounds.max);
        lodIndices = simplifyIndicesByClustering(positionsAndLanes(meshes, vertexCount, options.origin), 4, indices, cellSize, 3);
        if (lodIndices) {
          lod1IndexBuffer = track(createStaticGpuBuffer(device, lodIndices, GPUBufferUsage.INDEX));
          lod1IndexCount = lodIndices.length;
        }
      }
      perfTally('render.finalize.assembled', vertexCount, 'vertices');
      // The capture stores what the GPU copy holds: the same bytes, concatenated on the CPU.
      options.onMerged?.({ vertexData: concatBytes(runs, vertexBytes, stride, !!quantized), indices,
        ...(lod1IndexBuffer ? { lod1Indices: lodIndices! } : {}) });

      return {
        id: options.id,
        colorKey: options.colorKey,
        vertexBuffer,
        indexBuffer,
        indexCount,
        color,
        ...(meshes[0]?.material ? { finish: meshes[0].material } : {}), // #5582, as createSceneBatch
        expressIds: meshes.map((mesh) => mesh.expressId),
        bindGroup: uniform.bindGroup,
        uniformSlot,
        bounds,
        modelIndices: meshes.map((mesh) => mesh.modelIndex),
        origin: options.origin,
        ...(lod1IndexBuffer ? { lod1IndexBuffer, lod1IndexCount } : {}),
        ...(quantized ? { quantized: { min: quantized.min, step: quantized.step } } : {}),
      };
    } catch (error) {
      uniformSlot?.release();
      for (const buffer of allocated) {
        try {
          buffer.destroy();
        } catch (disposeError) {
          console.warn('[Scene] assembled batch rollback disposal failed', disposeError);
        }
      }
      throw error;
    }
  }

  /** The live fragment runs that concatenate to exactly `meshes`, or `null`. */
  private cover(meshes: readonly MeshData[]): FragmentRun[] | null {
    if (this.finalizing.length === 0 || meshes.length === 0) return null;
    const live = (fragment: BatchedMesh) => this.finalizing.some((retiring) => retiring.has(fragment));
    const out: FragmentRun[] = [];
    let i = 0;
    while (i < meshes.length) {
      const run = this.runs.get(meshes[i]);
      if (!run || !live(run.fragment) || run.fragment.gpuResident === false || !run.fragment.bounds
        || i + run.meshes.length > meshes.length) return null;
      for (let k = 0; k < run.meshes.length; k++) {
        if (run.meshes[k] !== meshes[i + k] || run.salts[k] !== colorSaltByte(meshes[i + k].color)) return null;
      }
      out.push(run);
      i += run.meshes.length;
    }
    return out;
  }
}

/**
 * Why the runs cannot stand in for the rebuild, or `null` when they can: every
 * run must be in the rebuild's frame and in the encoding the rebuild would pick.
 */
function encodingMiss(runs: readonly FragmentRun[], options: AssembleOptions): string | null {
  const lattice = runs[0].fragment.quantized;
  // `auto` with f32 fragments: the rebuild might still quantize the union.
  if (options.quantized === 'auto' ? !lattice : options.quantized !== 'off' || lattice) return 'f32';
  const [ox, oy, oz] = options.origin;
  for (const { fragment } of runs) {
    const o = fragment.origin;
    if (!o || o[0] !== ox || o[1] !== oy || o[2] !== oz) return 'frame';
    const q = fragment.quantized;
    if (lattice) {
      if (!q) return 'f32';
      if (q.step !== lattice.step || q.min[0] !== lattice.min[0] || q.min[1] !== lattice.min[1] || q.min[2] !== lattice.min[2]) return 'lattice';
    } else if (q) return 'lattice';
  }
  return null;
}

/** Each run's kept vertex bytes, in run order: what `assemble` copies on the GPU. */
function concatBytes(runs: readonly FragmentRun[], vertexBytes: number, stride: number, quantized: boolean): ArrayBuffer | Float32Array {
  const out = new Uint8Array(vertexBytes);
  let offset = 0;
  for (const { meshes, bytes } of runs) {
    let length = 0;
    for (const mesh of meshes) length += (mesh.positions.length / 3) * stride;
    const source = bytes instanceof ArrayBuffer ? new Uint8Array(bytes, 0, length) : new Uint8Array(bytes!.buffer, bytes!.byteOffset, length);
    out.set(source, offset);
    offset += length;
  }
  return quantized ? out.buffer : new Float32Array(out.buffer);
}

function unionBounds(runs: readonly FragmentRun[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { fragment: { bounds } } of runs) {
    if (!bounds) continue; // `cover` admits only bounded fragments
    for (let axis = 0; axis < 3; axis++) {
      if (bounds.min[axis] < min[axis]) min[axis] = bounds.min[axis];
      if (bounds.max[axis] > max[axis]) max[axis] = bounds.max[axis];
    }
  }
  return { min, max };
}

/** The position and entity lane of each merged record (`mergeGeometry`'s arithmetic), 4 floats per vertex. */
function positionsAndLanes(meshes: readonly MeshData[], vertexCount: number, origin: readonly [number, number, number]): Float32Array {
  const out = new Float32Array(vertexCount * 4);
  const lanes = new Uint32Array(out.buffer);
  let w = 0;
  for (const mesh of meshes) {
    const p = mesh.positions;
    const dox = (mesh.origin ? mesh.origin[0] : 0) - origin[0];
    const doy = (mesh.origin ? mesh.origin[1] : 0) - origin[1];
    const doz = (mesh.origin ? mesh.origin[2] : 0) - origin[2];
    const perVertex = mesh.entityIds;
    const { entityId, saltByte } = entityLaneOf(mesh);
    for (let i = 0, n = p.length / 3; i < n; i++) {
      out[w] = p[i * 3] + dox;
      out[w + 1] = p[i * 3 + 1] + doy;
      out[w + 2] = p[i * 3 + 2] + doz;
      lanes[w + 3] = packEntityLane(perVertex ? perVertex[i] : entityId, saltByte);
      w += 4;
    }
  }
  return out;
}
