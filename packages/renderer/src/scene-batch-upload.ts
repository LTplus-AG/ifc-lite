/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';
import type { RenderPipeline } from './pipeline.js';
import { mergeGeometry } from './scene-geometry.js';
import { BATCH_CONSTANTS } from './constants.js';
import { quantizeInterleaved } from './quantize.js';
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
    origin?: [number, number, number];
    quantized: boolean;
    lod: boolean;
  },
  bucketKey?: string,
): BatchedMesh {
  // Use ONE shared scene origin for every batch (set from the first batch's
  // world bbox centre). A per-batch origin would make abutting elements in
  // different colour batches diverge by a few f32 ULP at building-scale world
  // coords → seam/end-cap z-fighting. A shared origin makes every coincident
  // world point relativize identically → no seam z-fight, and the model
  // sits at most ±(model extent) from it (f32-precise at building scale).
  const merged = mergeGeometry(meshDataArray, options.origin);
  const expressIds = meshDataArray.map((m) => m.expressId);
  // Parallel to `expressIds` (same index = same source piece) so picking
  // can scope each batch ENTRY to its own model — batches group by colour,
  // not by model, so distinct models sharing an expressId+colour can be
  // co-batched (see BatchedMesh.modelIndices doc).
  const modelIndices = meshDataArray.map((m) => m.modelIndex);

  // Create vertex buffer (interleaved positions + normals)
  // Use mappedAtCreation to avoid a separate writeBuffer IPC round-trip
  // (significant win on Chrome/Dawn where each writeBuffer is a Mojo IPC call)
  // Quantized path (issue #1682 phase 6): 12-byte lattice records instead
  // of the 28-byte f32 layout. Falls back to f32 when the batch exceeds
  // the u16 lattice range. Order note: the LOD build further down reads
  // merged.vertexData (the CPU f32 copy) and produces INDICES only, which
  // are valid for either vertex format.
  // This function allocates a RUN of GPU buffers (vertex, index, uniform,
  // and — when LOD1 qualifies — a second index buffer). `device.createBuffer`
  // genuinely throws in production (scene.ts:2057 / index.ts:168 document a
  // real "createBuffer failed, size (...) is too large" RangeError), so every
  // buffer created earlier in the run must be destroyed before a later throw
  // propagates — otherwise it is orphaned: allocated, never referenced again,
  // never freed. Same paired-allocation idiom as `appendChunkToNode` /
  // `DeviationPipeline.uploadBvh` (see paired-buffer-leak.test.ts), generalised
  // to a run of N instead of a pair.
  const allocated: GPUBuffer[] = [];
  const createTracked = (desc: GPUBufferDescriptor): GPUBuffer => {
    const buffer = device.createBuffer(desc);
    allocated.push(buffer);
    return buffer;
  };
  try {
    let quantized: { min: [number, number, number]; step: number } | undefined;
    let vertexBuffer: GPUBuffer;
    const quantizedData = options.quantized
      ? quantizeInterleaved(
          merged.vertexData,
          BATCH_CONSTANTS.BYTES_PER_VERTEX / 4,
        )
      : null;
    if (quantizedData) {
      vertexBuffer = createTracked({
        size: Math.max(4, quantizedData.vertexData.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Uint8Array(vertexBuffer.getMappedRange()).set(
        new Uint8Array(quantizedData.vertexData),
      );
      vertexBuffer.unmap();
      quantized = { min: quantizedData.quantMin, step: quantizedData.step };
    } else {
      vertexBuffer = createTracked({
        size: merged.vertexData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(vertexBuffer.getMappedRange()).set(merged.vertexData);
      vertexBuffer.unmap();
    }

    // Create index buffer
    const indexBuffer = createTracked({
      size: merged.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint32Array(indexBuffer.getMappedRange()).set(merged.indices);
    indexBuffer.unmap();

    // Create uniform buffer for this batch
    const uniformBuffer = createTracked({
      size: pipeline.getUniformBufferSize(),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(),
      entries: [
        {
          binding: 0,
          resource: { buffer: uniformBuffer },
        },
      ],
    });

    // LOD1 (issue #1682 phase 5): simplified second index range over the SAME
    // vertex buffer. Bucket-owned batches only (`bucketKey` present) — the
    // transient streaming fragments and partial/overlay sub-batches never pay
    // the build. Positions in `merged.vertexData` are relative to the batch
    // origin, which is fine: clustering is translation-invariant as long as
    // the cell size comes from the same-space bounds extent.
    let lod1IndexBuffer: GPUBuffer | undefined;
    let lod1IndexCount: number | undefined;
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
      const lodIndices = simplifyIndicesByClustering(
        merged.vertexData,
        BATCH_CONSTANTS.BYTES_PER_VERTEX / 4,
        merged.indices,
        cellSize,
      );
      if (lodIndices) {
        lod1IndexBuffer = createTracked({
          size: lodIndices.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true,
        });
        new Uint32Array(lod1IndexBuffer.getMappedRange()).set(lodIndices);
        lod1IndexBuffer.unmap();
        lod1IndexCount = lodIndices.length;
      }
    }

    return {
      id: options.id,
      colorKey: options.colorKey,
      vertexBuffer,
      indexBuffer,
      indexCount: merged.indices.length,
      color,
      expressIds,
      bindGroup,
      uniformBuffer,
      bounds: merged.bounds,
      modelIndices,
      // Per-batch local frame: positions are stored relative to this; the draw
      // loop applies model = translate(origin) so they land in world space.
      origin: merged.origin,
      ...(lod1IndexBuffer ? { lod1IndexBuffer, lod1IndexCount } : {}),
      ...(quantized ? { quantized } : {}),
    };
  } catch (error) {
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
