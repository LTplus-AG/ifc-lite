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
import { PointCloudSpatialIndex } from './point-cloud-spatial-index.js';

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
  /**
   * CPU spatial index over this node's points (issue #1860), so the
   * measure tool can snap to real scan points even though `chunks`
   * above holds only opaque GPU buffers. Built incrementally in
   * `appendChunkToNode`, alongside the GPU upload.
   */
  spatialIndex: PointCloudSpatialIndex;
  /**
   * Optional per-asset GPU model matrix (column-major, 16 floats),
   * applied in the vertex shader as `uniforms.model * vec4(position, 1)`
   * before `viewProj` (issue #1804: aligns a georeferenced point cloud
   * with the IFC model's `IfcMapConversion`). `undefined` → identity,
   * written by `writePointCloudUniforms`.
   */
  model?: Float32Array;
}

/**
 * Transform an AABB through a column-major 4x4 model matrix and return
 * the axis-aligned box of the result (standard 8-corner fold). Used so
 * `PointCloudRenderer.getBounds()` reports WORLD-space extents when a
 * node carries a per-asset model matrix (issue #1804) — the height-ramp
 * colour mode and the viewer's scene-bounds/framing consume those
 * extents and must agree with where the shader actually places points.
 * Returns the input box unchanged for a missing/malformed matrix
 * (mirrors `writePointCloudUniforms`' identity fallback).
 */
/**
 * True when `model` is a usable 4x4: exactly 16 entries, all finite.
 *
 * Single-sourced so the two consumers of `PointCloudNode.model` — the AABB
 * fold below and `writePointCloudUniforms`' GPU write — accept exactly the
 * same matrices. When they disagree, a matrix one accepts and the other
 * rejects puts the reported bounds in a different frame from the rendered
 * points, which is the precise failure this transform exists to prevent.
 * The finiteness check matters because a single NaN propagates to every
 * corner of the box (and to every point on the GPU), so a degenerate matrix
 * must fall back to identity rather than poison the result.
 */
export function isUsableModelMatrix(
  model: Float32Array | undefined,
): model is Float32Array {
  if (!model || model.length !== 16) return false;
  for (let i = 0; i < 16; i++) {
    if (!Number.isFinite(model[i])) return false;
  }
  return true;
}

export function transformAabb(
  bounds: { min: [number, number, number]; max: [number, number, number] },
  model: Float32Array | undefined,
): { min: [number, number, number]; max: [number, number, number] } {
  if (!isUsableModelMatrix(model)) return bounds;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const x = (c & 1) === 0 ? bounds.min[0] : bounds.max[0];
    const y = (c & 2) === 0 ? bounds.min[1] : bounds.max[1];
    const z = (c & 4) === 0 ? bounds.min[2] : bounds.max[2];
    const tx = model[0] * x + model[4] * y + model[8] * z + model[12];
    const ty = model[1] * x + model[5] * y + model[9] * z + model[13];
    const tz = model[2] * x + model[6] * y + model[10] * z + model[14];
    if (tx < min[0]) min[0] = tx;
    if (ty < min[1]) min[1] = ty;
    if (tz < min[2]) min[2] = tz;
    if (tx > max[0]) max[0] = tx;
    if (ty > max[1]) max[1] = ty;
    if (tz > max[2]) max[2] = tz;
  }
  return { min, max };
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
    spatialIndex: new PointCloudSpatialIndex(),
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

/**
 * Append a chunk's points to a node as one or more GPU vertex buffers.
 *
 * A single GPU buffer can't exceed `maxBufferSize` (typically 256 MiB), and
 * because this vertex buffer is also bound as STORAGE for the deviation
 * compute, `maxStorageBufferBindingSize` (often 128 MiB) applies too. At
 * 24 B/point that caps a buffer at ~5–11 M points — so a large chunk (e.g. a
 * whole-file decode that doesn't sub-chunk, or a big inline cloud) is split
 * into sub-buffers that each fit, instead of failing with
 * "Buffer size N is greater than the maximum buffer size". The draw and
 * deviation passes already iterate `node.chunks`, so the split is transparent.
 */
export function appendChunkToNode(
  device: GPUDevice,
  node: PointCloudNode,
  chunk: PointCloudChunkInput,
): void {
  const total = chunk.pointCount;
  if (total <= 0) return;
  // Index the whole chunk's points for measure-tool snapping (#1860),
  // independent of how the GPU sub-buffer split below divides it up —
  // the index doesn't care about buffer size limits, only world
  // positions. Retains `chunk.positions` (and classifications, so the
  // query can honour the class visibility mask #1783) by reference; see
  // spatial index class docs. No-ops past the index's point cap.
  node.spatialIndex.insertRange(chunk.positions, total, chunk.classifications ?? null);
  // Honour BOTH the raw buffer cap and the storage-binding cap, with a 5%
  // margin for safety against driver rounding.
  const maxBytes = Math.min(
    device.limits.maxBufferSize,
    device.limits.maxStorageBufferBindingSize,
  );
  const bufferPointCap = Math.floor((maxBytes * 0.95) / POINT_VERTEX_BYTES);
  // The deviation compute dispatches ceil(count / 64) workgroups over a whole
  // chunk (its workgroup size is 64). That count must stay within
  // maxComputeWorkgroupsPerDimension (65535), else WebGPU rejects the dispatch
  // ("group size ... must be less or equal to 65535"). So a chunk is capped so
  // both its GPU buffer AND a single per-point compute dispatch over it fit —
  // ~4.19 M points (65535 × 64), tighter than the ~5.3 M buffer cap.
  const dispatchPointCap = device.limits.maxComputeWorkgroupsPerDimension * 64;
  const maxPerBuffer = Math.max(1, Math.min(bufferPointCap, dispatchPointCap));
  for (let start = 0; start < total; start += maxPerBuffer) {
    appendPointSubBuffer(device, node, chunk, start, Math.min(maxPerBuffer, total - start));
  }
}

/** Pack `chunk`'s `[start, start+count)` points into one GPU vertex buffer. */
function appendPointSubBuffer(
  device: GPUDevice,
  node: PointCloudNode,
  chunk: PointCloudChunkInput,
  start: number,
  count: number,
): void {
  const bytes = new ArrayBuffer(count * POINT_VERTEX_BYTES);
  const f32 = new Float32Array(bytes);
  const u8 = new Uint8Array(bytes);
  const u32 = new Uint32Array(bytes);
  const positions = chunk.positions;
  const colors = chunk.colors;
  const classes = chunk.classifications;
  const intensities = chunk.intensities;
  const expressId = node.meta.expressId >>> 0;

  for (let j = 0; j < count; j++) {
    const src = start + j;
    const fOff = j * 6;
    f32[fOff] = positions[src * 3];
    f32[fOff + 1] = positions[src * 3 + 1];
    f32[fOff + 2] = positions[src * 3 + 2];

    const byteOff = j * POINT_VERTEX_BYTES + 12;
    if (colors) {
      u8[byteOff] = clamp01(colors[src * 3]) * 255;
      u8[byteOff + 1] = clamp01(colors[src * 3 + 1]) * 255;
      u8[byteOff + 2] = clamp01(colors[src * 3 + 2]) * 255;
    } else {
      u8[byteOff] = 200;
      u8[byteOff + 1] = 200;
      u8[byteOff + 2] = 200;
    }
    u8[byteOff + 3] = classes ? classes[src] : 0;

    // intensity at offset +16, low 16 bits of a u32
    u32[j * 6 + 4] = intensities ? intensities[src] & 0xffff : 0;
    u32[j * 6 + 5] = expressId;
  }

  // Sanity-check the packed buffer: read back the class byte for
  // the first few vertices so the console shows exactly what the
  // splat shader will see at `rgbAndClass.a * 255`. Catches the
  // case where the chunk had non-trivial classes but they got
  // zeroed during packing (e.g. a buffer-view mismatch).
  if (debugVertexClassLogs < DEBUG_VERTEX_CLASS_LOG_LIMIT && classes) {
    debugVertexClassLogs++;
    const sample: number[] = [];
    for (let j = 0; j < Math.min(8, count); j++) {
      sample.push(u8[j * POINT_VERTEX_BYTES + 15]);
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
  //
  // This allocation is paired with `vertexBuffer` above: if it throws
  // (e.g. OOM — the whole reason this upload is split into sub-buffers
  // in the first place, see appendChunkToNode), `vertexBuffer` would
  // otherwise be orphaned — created and written, but never referenced
  // again and never destroyed. Free it before propagating the error.
  let deviationBuffer: GPUBuffer;
  try {
    deviationBuffer = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  } catch (err) {
    try {
      vertexBuffer.destroy();
    } catch (destroyErr) {
      // Non-fatal: surfaced rather than swallowed, per the no-silent-catch
      // house rule — this firing would mean a real teardown bug.
      console.warn('[PointCloud] failed to release vertexBuffer after a paired allocation failure', destroyErr);
    }
    throw err;
  }
  // Zero-init explicitly — WebGPU spec doesn't promise zeroed buffers
  // and some implementations skip the initial clear when STORAGE is set.
  device.queue.writeBuffer(deviationBuffer, 0, new Float32Array(count));

  node.chunks.push({
    vertexBuffer,
    deviationBuffer,
    pointCount: count,
    bbox: chunk.bbox,
  });
  node.pointCount += count;
  growBounds(node.bounds, chunk.bbox);
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
  // Drop the retained position arrays + grid buckets (#1860) — without
  // this the spatial index would keep every chunk's Float32Array alive
  // for the rest of the session even after the GPU buffers are freed.
  node.spatialIndex.dispose();
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
