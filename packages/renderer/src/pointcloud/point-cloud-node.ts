/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU resources for one point cloud asset.
 *
 * Phase 1+ supports multi-chunk assets: streaming sources push chunks
 * into a node one at a time, each becoming its own GPU vertex buffer.
 * Each chunk is drawn with one draw call sharing the asset's bind group.
 */

import type { PointCloudAsset } from '@ifc-lite/geometry';
import type { PointRenderPipeline } from './point-pipeline.js';
import { POINT_VERTEX_BYTES } from './point-pipeline.js';

export interface PointCloudGpuChunk {
  vertexBuffer: GPUBuffer;
  /**
   * Per-point signed-distance buffer. Always allocated alongside the
   * vertex buffer (4 bytes per point) so the compute pass and splat
   * pipeline can both bind it without a "deviation present?" branch.
   * Initialised to zeros — `Renderer.computeDeviations` overwrites.
   */
  deviationBuffer: GPUBuffer;
  pointCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

/** Inputs to a single chunk upload. */
export interface PointCloudChunkInput {
  positions: Float32Array;
  /** RGB in 0..1; undefined → defaults to gray. */
  colors?: Float32Array;
  /** Per-point u8 LAS classification; undefined → 0. */
  classifications?: Uint8Array;
  /** Per-point u16 intensity; undefined → 0. */
  intensities?: Uint16Array;
  pointCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface PointCloudNodeMeta {
  expressId: number;
  ifcType?: string;
  modelIndex?: number;
}

export interface PointCloudNode {
  meta: PointCloudNodeMeta;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  chunks: PointCloudGpuChunk[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  pointCount: number;
}

/** Build an empty node — chunks are appended via `appendChunkToNode`. */
export function createNode(
  device: GPUDevice,
  pipeline: PointRenderPipeline,
  meta: PointCloudNodeMeta,
): PointCloudNode {
  void device;
  const uniformBuffer = pipeline.createUniformBuffer();
  const bindGroup = pipeline.createBindGroup(uniformBuffer);
  return {
    meta,
    uniformBuffer,
    bindGroup,
    chunks: [],
    bounds: {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    },
    pointCount: 0,
  };
}

/**
 * Per-page-session counter for the vertex-buffer class-byte
 * diagnostic. Mirrors the host-side log in `pointCloudIngest.ts`
 * so the two can be cross-checked: if the host log shows non-zero
 * classes but the vertex log shows all 0, the packing path is
 * dropping them.
 */
const DEBUG_VERTEX_CLASS_LOG_LIMIT = 3;
let debugVertexClassLogs = 0;

/** Convert a renderer-agnostic chunk into a GPU vertex buffer + metadata. */
export function appendChunkToNode(
  device: GPUDevice,
  node: PointCloudNode,
  chunk: PointCloudChunkInput,
): PointCloudGpuChunk {
  const count = chunk.pointCount;
  const bytes = new ArrayBuffer(count * POINT_VERTEX_BYTES);
  const f32 = new Float32Array(bytes);
  const u8 = new Uint8Array(bytes);
  const u32 = new Uint32Array(bytes);
  const positions = chunk.positions;
  const colors = chunk.colors;
  const classes = chunk.classifications;
  const intensities = chunk.intensities;
  const expressId = node.meta.expressId >>> 0;

  for (let i = 0; i < count; i++) {
    const fOff = i * 6;
    f32[fOff] = positions[i * 3];
    f32[fOff + 1] = positions[i * 3 + 1];
    f32[fOff + 2] = positions[i * 3 + 2];

    const byteOff = i * POINT_VERTEX_BYTES + 12;
    if (colors) {
      u8[byteOff] = clamp01(colors[i * 3]) * 255;
      u8[byteOff + 1] = clamp01(colors[i * 3 + 1]) * 255;
      u8[byteOff + 2] = clamp01(colors[i * 3 + 2]) * 255;
    } else {
      u8[byteOff] = 200;
      u8[byteOff + 1] = 200;
      u8[byteOff + 2] = 200;
    }
    u8[byteOff + 3] = classes ? classes[i] : 0;

    // intensity at offset +16, low 16 bits of a u32
    u32[i * 6 + 4] = intensities ? intensities[i] & 0xffff : 0;
    u32[i * 6 + 5] = expressId;
  }

  // Sanity-check the packed buffer: read back the class byte for
  // the first few vertices so the console shows exactly what the
  // splat shader will see at `rgbAndClass.a * 255`. Catches the
  // case where the chunk had non-trivial classes but they got
  // zeroed during packing (e.g. a buffer-view mismatch).
  if (debugVertexClassLogs < DEBUG_VERTEX_CLASS_LOG_LIMIT && classes) {
    debugVertexClassLogs++;
    const sample: number[] = [];
    for (let i = 0; i < Math.min(8, count); i++) {
      sample.push(u8[i * POINT_VERTEX_BYTES + 15]);
    }
    console.log(
      `[pointcloud-debug] vertex-buffer chunk #${debugVertexClassLogs}: `
      + `packed class bytes (offset +15) first8=[${sample.join(',')}]`,
    );
  }

  const vertexBuffer = device.createBuffer({
    size: bytes.byteLength,
    // STORAGE so the deviation compute shader can read positions
    // straight from the vertex buffer (avoids a duplicate copy).
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
  });
  device.queue.writeBuffer(vertexBuffer, 0, bytes);

  // Pre-allocate the per-point deviation buffer (zero-initialised).
  // Bound as a vertex attribute by the splat pipeline AND as a
  // storage buffer by the deviation compute pass.
  const deviationBuffer = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // Zero-init explicitly — WebGPU spec doesn't promise zeroed buffers
  // and some implementations skip the initial clear when STORAGE is set.
  device.queue.writeBuffer(deviationBuffer, 0, new Float32Array(count));

  const gpuChunk: PointCloudGpuChunk = {
    vertexBuffer,
    deviationBuffer,
    pointCount: count,
    bbox: chunk.bbox,
  };
  node.chunks.push(gpuChunk);
  node.pointCount += count;
  growBounds(node.bounds, chunk.bbox);
  return gpuChunk;
}

/** One-shot upload — produces a node with a single GPU chunk. */
export function uploadAssetToGpu(
  device: GPUDevice,
  pipeline: PointRenderPipeline,
  asset: PointCloudAsset,
): PointCloudNode {
  const node = createNode(device, pipeline, {
    expressId: asset.expressId,
    ifcType: asset.ifcType,
    modelIndex: asset.modelIndex,
  });
  appendChunkToNode(device, node, {
    positions: asset.chunk.positions,
    colors: asset.chunk.colors,
    classifications: asset.chunk.classifications,
    intensities: asset.chunk.intensities,
    pointCount: asset.chunk.pointCount,
    bbox: asset.chunk.bbox,
  });
  return node;
}

export function destroyNode(node: PointCloudNode): void {
  for (const chunk of node.chunks) {
    chunk.vertexBuffer.destroy();
    chunk.deviationBuffer.destroy();
  }
  node.uniformBuffer.destroy();
  node.chunks = [];
  node.pointCount = 0;
}

function growBounds(
  bounds: { min: [number, number, number]; max: [number, number, number] },
  bbox: { min: [number, number, number]; max: [number, number, number] },
): void {
  if (bbox.min[0] < bounds.min[0]) bounds.min[0] = bbox.min[0];
  if (bbox.min[1] < bounds.min[1]) bounds.min[1] = bbox.min[1];
  if (bbox.min[2] < bounds.min[2]) bounds.min[2] = bbox.min[2];
  if (bbox.max[0] > bounds.max[0]) bounds.max[0] = bbox.max[0];
  if (bbox.max[1] > bounds.max[1]) bounds.max[1] = bbox.max[1];
  if (bbox.max[2] > bounds.max[2]) bounds.max[2] = bbox.max[2];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
