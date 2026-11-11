/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';
import type { RenderPipeline } from './pipeline.js';
import { mergeGeometry } from './scene-geometry.js';
import { BATCH_CONSTANTS } from './constants.js';
import { latticeCollapsesGeometry, quantizeInterleaved, QUANT_BYTES_PER_VERTEX, QUANT_STEP, type LatticeFrame } from './quantize.js';
import { batchCollapseVerdict, recordsDescribe, type MeshRecords } from '@ifc-lite/geometry/gpu-records';
import { perfTally } from '@ifc-lite/load-trace';
import { createStaticGpuBuffer } from './gpu-static-upload.js';
import type { MergedBatchBytes } from './scene-snapshot-batches.js';
import { meshUniformArena, type MeshUniformSlot } from './mesh-uniform-arena.js';
import type { BatchQuantization } from './scene-derived-batches.js';
import {
  simplifyIndicesByClustering,
  lodCellSizeForBounds,
  LOD_MIN_TRIANGLES,
} from './lod-simplify.js';

/** Stage a complete GPU batch. No Scene state changes until this succeeds. */
export function createSceneBatch(
  meshDataArray: MeshData[],
  color: [number, number, number, number],
  device: GPUDevice,
  pipeline: RenderPipeline,
  options: {
    id: number;
    colorKey: string;
    /** Already validated by Scene before this GPU allocation boundary. */
    origin: [number, number, number];
    /** See `BatchQuantization`; derived batches pass their source's decision (#4832). */
    quantized: BatchQuantization;
    lod: boolean;
    /** Handed the exact arrays this batch uploads (scene-snapshot-batches.ts). */
    onMerged?: (bytes: MergedBatchBytes) => void;
    /** Encode against this shared lattice origin when it fits (a streamed bucket's fragments). */
    lattice?: LatticeFrame;
    /** The vertex buffer can be copied from (a fragment a finalize may assemble from). */
    copySource?: boolean;
  },
  bucketKey?: string,
): BatchedMesh {
  // Use ONE shared scene origin for every batch (set from the first batch's
  // world bbox centre). A per-batch origin would make abutting elements in
  // different colour batches diverge by a few f32 ULP at building-scale world
  // coords → seam/end-cap z-fighting. A shared origin makes every coincident
  // world point relativize identically → no seam z-fight, and the model
  // sits at most ±(model extent) from it (f32-precise at building scale).
  const recorded = bucketKey === undefined && options.quantized === 'auto' && options.lattice?.min
    ? fromRecords(meshDataArray, options.origin, options.lattice.min) : null;
  const merged = recorded?.merged ?? mergeGeometry(meshDataArray, options.origin);
  const expressIds = meshDataArray.map((m) => m.expressId);
  // Parallel to `expressIds` (same index = same source piece) so picking
  // can scope each batch ENTRY to its own model — batches group by colour,
  // not by model, so distinct models sharing an expressId+colour can be
  // co-batched (see BatchedMesh.modelIndices doc).
  const modelIndices = meshDataArray.map((m) => m.modelIndex);

  // Create vertex buffer (interleaved positions + normals) through
  // `createStaticGpuBuffer` — never `mappedAtCreation`, which on Chromium pins
  // a hidden shared-memory copy of the whole buffer for its lifetime (#5429).
  // Quantized path (issue #1682 phase 6): 12-byte lattice records instead
  // of the 28-byte f32 layout. Falls back to f32 when the batch exceeds
  // the u16 lattice range. Order note: the LOD build further down reads
  // merged.vertexData (the CPU f32 copy) and produces INDICES only, which
  // are valid for either vertex format.
  // This function allocates a RUN of GPU buffers (vertex, index, uniform,
  // and — when LOD1 qualifies — a second index buffer). A GPU call in the run
  // can still throw synchronously (Safari throws `InvalidStateError` on a
  // lost device; a test or host shim may throw anything), so every
  // buffer created earlier in the run must be destroyed before a later throw
  // propagates — otherwise it is orphaned: allocated, never referenced again,
  // never freed. Same paired-allocation idiom as `appendChunkToNode` /
  // `DeviationPipeline.uploadBvh` (see paired-buffer-leak.test.ts), generalised
  // to a run of N instead of a pair.
  const allocated: GPUBuffer[] = [];
  let uniformSlot: MeshUniformSlot | undefined;
  const track = (buffer: GPUBuffer): GPUBuffer => {
    allocated.push(buffer);
    return buffer;
  };
  try {
    let quantized: { min: [number, number, number]; step: number } | undefined;
    let vertexBuffer: GPUBuffer;
    // `auto` also stays f32 when the ~1 mm lattice would collapse an entity's
    // shape (#9068); `required` keeps its source batch's decision (#4832).
    const quantizedData = recorded ? recorded.quantized : options.quantized === 'required' || (options.quantized === 'auto'
      && !latticeCollapsesGeometry(merged.vertexData, BATCH_CONSTANTS.BYTES_PER_VERTEX / 4, merged.indices))
      ? quantizeInterleaved(
          merged.vertexData,
          BATCH_CONSTANTS.BYTES_PER_VERTEX / 4,
          options.lattice,
        )
      : null;
    if (!quantizedData && options.quantized === 'required') {
      // A subset of a quantized batch always fits its lattice range, so this
      // cannot happen unless the derived batch was built from pieces outside
      // its source batch. Say so: a partial sub-batch drawn instead of its
      // source would otherwise resolve coplanar faces differently, silently.
      console.warn(
        `[Scene] derived batch ${options.colorKey} could not inherit its source batch's quantization; ` +
        'its partial-batch depth will not match the base geometry (#4832).',
      );
    }
    const vertexUsage = GPUBufferUsage.VERTEX | (options.copySource ? GPUBufferUsage.COPY_SRC : 0);
    if (quantizedData) {
      vertexBuffer = track(createStaticGpuBuffer(device, quantizedData.vertexData, vertexUsage));
      quantized = { min: quantizedData.quantMin, step: quantizedData.step };
    } else {
      vertexBuffer = track(createStaticGpuBuffer(device, merged.vertexData, vertexUsage));
    }

    // Create index buffer
    const indexBuffer = track(createStaticGpuBuffer(device, merged.indices, GPUBufferUsage.INDEX));

    const uniform = createBatchUniform(device, pipeline);
    uniformSlot = uniform.uniformSlot;
    const bindGroup = uniform.bindGroup;

    // LOD1 (issue #1682 phase 5): simplified second index range over the SAME
    // vertex buffer. Bucket-owned batches only (`bucketKey` present) — the
    // transient streaming fragments and partial/overlay sub-batches never pay
    // the build. Positions in `merged.vertexData` are relative to the batch
    // origin, which is fine: clustering is translation-invariant as long as
    // the cell size comes from the same-space bounds extent.
    let lod1IndexBuffer: GPUBuffer | undefined;
    let lod1IndexCount: number | undefined;
    let lodIndices: Uint32Array | null | undefined;
    if (
      options.lod &&
      bucketKey !== undefined &&
      merged.bounds &&
      merged.indices.length >= LOD_MIN_TRIANGLES * 3
    ) {
      const cellSize = lodCellSizeForBounds(
        merged.bounds.min,
        merged.bounds.max,
      );
      lodIndices = simplifyIndicesByClustering(
        merged.vertexData,
        BATCH_CONSTANTS.BYTES_PER_VERTEX / 4,
        merged.indices,
        cellSize,
      );
      if (lodIndices) {
        lod1IndexBuffer = track(createStaticGpuBuffer(device, lodIndices, GPUBufferUsage.INDEX));
        lod1IndexCount = lodIndices.length;
      }
    }
    options.onMerged?.({ vertexData: quantizedData?.vertexData ?? merged.vertexData, indices: merged.indices, ...(lodIndices ? { lod1Indices: lodIndices } : {}) });

    return {
      id: options.id,
      colorKey: options.colorKey,
      vertexBuffer,
      indexBuffer,
      indexCount: merged.indices.length,
      color,
      // #5582: every piece in a bucket shares its material (the colour key
      // folds it in — see Scene.colorKey), so the first piece speaks for all.
      ...(meshDataArray[0]?.material ? { finish: meshDataArray[0].material } : {}),
      expressIds,
      bindGroup,
      uniformSlot,
      bounds: merged.bounds,
      modelIndices,
      // Per-batch local frame: positions are stored relative to this; the draw
      // loop applies model = translate(origin) so they land in world space.
      origin: merged.origin,
      ...(lod1IndexBuffer ? { lod1IndexBuffer, lod1IndexCount } : {}),
      ...(quantized ? { quantized } : {}),
    };
  } catch (error) {
    uniformSlot?.release();
    for (const buffer of allocated) {
      try {
        buffer.destroy();
      } catch (disposeError) {
        console.warn('[Scene] batch rollback disposal failed', disposeError);
      }
    }
    throw error;
  }
}

const NO_F32_VERTICES = new Float32Array(0);

/**
 * A streamed fragment straight from its meshes' GPU records, when every mesh
 * carries records for exactly this frame and lattice origin and the batch
 * provably quantizes: their concatenation is what `mergeGeometry` +
 * `quantizeInterleaved` would write (gpu-records-parity.test.ts). Only the
 * indices are rebased. `null` sends the fragment through the merge.
 */
function fromRecords(meshes: readonly MeshData[], origin: readonly [number, number, number], pin: readonly [number, number, number]): {
  merged: { vertexData: Float32Array; indices: Uint32Array; bounds: { min: [number, number, number]; max: [number, number, number] }; origin: [number, number, number] };
  quantized: { vertexData: ArrayBuffer; quantMin: [number, number, number]; step: number };
} | null {
  const records: MeshRecords[] = [];
  let bytes = 0, indexCount = 0;
  for (const mesh of meshes) {
    const r = mesh.gpuRecords;
    if (!r || !recordsDescribe(r, mesh) || r.frame[0] !== origin[0] || r.frame[1] !== origin[1] || r.frame[2] !== origin[2]
      || r.pin[0] !== pin[0] || r.pin[1] !== pin[1] || r.pin[2] !== pin[2]) return null;
    records.push(r);
    bytes += r.records.byteLength;
    indexCount += mesh.indices.length;
  }
  if (records.length === 0 || batchCollapseVerdict(records) !== 'quantize') return null;
  const vertexData = new Uint8Array(bytes);
  const indices = new Uint32Array(indexCount);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let at = 0, base = 0, written = 0;
  for (let m = 0; m < meshes.length; m++) {
    const r = records[m], source = meshes[m].indices;
    vertexData.set(new Uint8Array(r.records), at);
    at += r.records.byteLength;
    for (let i = 0; i < source.length; i++) indices[written + i] = source[i] + base;
    written += source.length;
    base += r.records.byteLength / QUANT_BYTES_PER_VERTEX;
    for (let axis = 0; axis < 3; axis++) {
      if (r.worldMin[axis] < min[axis]) min[axis] = r.worldMin[axis];
      if (r.worldMax[axis] > max[axis]) max[axis] = r.worldMax[axis];
    }
  }
  perfTally('render.stream.records', base, 'vertices');
  return {
    merged: { vertexData: NO_F32_VERTICES, indices, bounds: { min, max }, origin: [origin[0], origin[1], origin[2]] },
    quantized: { vertexData: vertexData.buffer, quantMin: [pin[0], pin[1], pin[2]], step: QUANT_STEP },
  };
}

/**
 * A batch's uniform block: a slice of the shared per-device arena, so the frame
 * uploads every drawn batch in one write (mesh-uniform-arena.ts). The caller
 * owns the slot, and releases it if the rest of the batch fails.
 */
export function createBatchUniform(device: GPUDevice, pipeline: RenderPipeline): { uniformSlot: MeshUniformSlot; bindGroup: GPUBindGroup } {
  const uniformSlot = meshUniformArena(device, pipeline.getUniformBufferSize()).allocate();
  try {
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(),
      entries: [{ binding: 0, resource: { buffer: uniformSlot.buffer, offset: uniformSlot.offset, size: uniformSlot.size } }],
    });
    return { uniformSlot, bindGroup };
  } catch (error) {
    uniformSlot.release();
    throw error;
  }
}

/** Repartition an evicted batch without allocating replacement GPU buffers. */
export function createSceneBatchShell(
  meshDataArray: MeshData[],
  source: BatchedMesh,
  id: number,
  colorKey: string,
): BatchedMesh {
  const merged = mergeGeometry(meshDataArray, source.origin);
  return {
    id,
    colorKey,
    vertexBuffer: source.vertexBuffer,
    indexBuffer: source.indexBuffer,
    indexCount: merged.indices.length,
    color: meshDataArray[0].color,
    ...(meshDataArray[0]?.material ? { finish: meshDataArray[0].material } : {}), // #5582
    expressIds: meshDataArray.map((mesh) => mesh.expressId),
    modelIndices: meshDataArray.map((mesh) => mesh.modelIndex),
    bounds: merged.bounds,
    origin: merged.origin,
    gpuResident: false,
  };
}
