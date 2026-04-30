/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU resources for one point cloud asset.
 *
 * Phase 0 keeps a single vertex buffer per asset (one chunk). When we add
 * streaming, this becomes a list of chunk-buffers and the renderer issues
 * one draw call per chunk.
 */

import type { PointCloudAsset } from '@ifc-lite/geometry';
import type { PointRenderPipeline } from './point-pipeline.js';
import { POINT_VERTEX_BYTES } from './point-pipeline.js';

export interface PointCloudGpuChunk {
  vertexBuffer: GPUBuffer;
  pointCount: number;
}

export interface PointCloudNode {
  asset: PointCloudAsset;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  chunks: PointCloudGpuChunk[];
  /** World-space bounds (Y-up; positions have already been transformed). */
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Pack a `PointCloudAsset.chunk` into a GPU vertex buffer matching the
 * point pipeline's vertex layout.
 */
export function uploadAssetToGpu(
  device: GPUDevice,
  pipeline: PointRenderPipeline,
  asset: PointCloudAsset,
): PointCloudNode {
  const chunk = asset.chunk;
  const count = chunk.pointCount;
  const interleaved = new ArrayBuffer(count * POINT_VERTEX_BYTES);
  const f32 = new Float32Array(interleaved);
  const u8 = new Uint8Array(interleaved);
  const u32 = new Uint32Array(interleaved);

  const positions = chunk.positions;
  const colors = chunk.colors;
  const expressId = asset.expressId >>> 0;

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
      // Default: light gray so points are visible against the dark clear color
      u8[byteOff] = 200;
      u8[byteOff + 1] = 200;
      u8[byteOff + 2] = 200;
    }
    u8[byteOff + 3] = 255;

    u32[i * 6 + 4] = expressId;
    u32[i * 6 + 5] = 0; // pad
  }

  const vertexBuffer = device.createBuffer({
    size: interleaved.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, interleaved);

  const uniformBuffer = pipeline.createUniformBuffer();
  const bindGroup = pipeline.createBindGroup(uniformBuffer);

  // Compute world bounds (positions are already in renderer space)
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  return {
    asset,
    uniformBuffer,
    bindGroup,
    chunks: [{ vertexBuffer, pointCount: count }],
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

export function destroyNode(node: PointCloudNode): void {
  for (const chunk of node.chunks) {
    chunk.vertexBuffer.destroy();
  }
  node.uniformBuffer.destroy();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
