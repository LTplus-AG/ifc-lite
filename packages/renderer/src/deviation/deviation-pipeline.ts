/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compute pipeline for BIM ↔ scan deviation. Owns the GPU-resident
 * triangle BVH, builds bind groups per chunk on demand, and dispatches
 * the closest-point-on-triangle compute shader.
 *
 * The BVH lives in two storage buffers (nodes + triangles); both are
 * uploaded once per mesh-set change and reused across every chunk in
 * every point cloud asset. Per-chunk bind groups are created lazily
 * because a chunk's vertex buffer is the `positions` storage source
 * for the compute pass.
 */

import { deviationShaderSource } from './deviation-shader.wgsl.js';
import type { TriangleBVHResult } from './triangle-bvh.js';
import { POINT_VERTEX_BYTES } from '../pointcloud/point-pipeline.js';

/** Bytes per BVH node — 8 floats / 8 u32s laid out per the shader. */
const BVH_NODE_BYTES = 32;
/** Bytes per triangle — 12 floats (3 verts + face normal). */
const TRIANGLE_BYTES = 48;
/**
 * Uniform block size for `DeviationParams`. WGSL std140 packs the
 * struct compactly; we add 4 padding u32s to round to 32 bytes which
 * matches a single uniform alignment slot on every WebGPU impl.
 */
const PARAMS_UNIFORM_BYTES = 32;

export interface DeviationDispatchInput {
  /** Storage-usage GPU buffer holding interleaved point vertices.
   *  Must be the same buffer used as the splat pipeline's vertex
   *  buffer for this chunk; the compute shader reads positions
   *  directly from it (no copy). */
  positionsBuffer: GPUBuffer;
  /** Output buffer — one f32 per point. Must allow STORAGE. */
  deviationsBuffer: GPUBuffer;
  /** Number of points to process. */
  pointCount: number;
  /** Optional clip range in metres. 0 / negative → no clip. */
  maxRange: number;
}

export class DeviationPipeline {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private bindGroupLayout: GPUBindGroupLayout;
  private bvhNodesBuffer: GPUBuffer | null = null;
  private trianglesBuffer: GPUBuffer | null = null;
  private bvhTriangleCount = 0;
  private bvhNodeCount = 0;
  private bvhBounds: TriangleBVHResult['bounds'] | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
    this.pipeline = device.createComputePipeline({
      layout,
      compute: {
        module: device.createShaderModule({ code: deviationShaderSource }),
        entryPoint: 'cs_main',
      },
    });
  }

  /**
   * Upload the per-triangle BVH to the GPU. Replaces any previous
   * upload; safe to call repeatedly when the mesh set changes (load,
   * federation update, isolation toggle).
   */
  uploadBvh(bvh: TriangleBVHResult): void {
    this.disposeBvh();
    if (bvh.triangleCount === 0) {
      this.bvhNodeCount = 0;
      this.bvhTriangleCount = 0;
      this.bvhBounds = bvh.bounds;
      return;
    }
    // Nodes: pack into a STORAGE buffer. The Float32Array view also
    // contains u32 fields (childA, childB) but they were already
    // written via Uint32Array aliasing during the build, so a single
    // write of the underlying ArrayBuffer carries them too.
    const nodeBuf = this.device.createBuffer({
      size: bvh.nodeCount * BVH_NODE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(
      nodeBuf, 0,
      // Pass the typed-array view directly — TS widens `.buffer` to
      // ArrayBufferLike on a function-parameter Float32Array which
      // doesn't satisfy writeBuffer's signature. The view form has
      // size in elements (so we slice down to the populated head).
      bvh.nodes.subarray(0, bvh.nodeCount * BVH_NODE_BYTES / 4),
    );
    const triBuf = this.device.createBuffer({
      size: bvh.triangleCount * TRIANGLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(
      triBuf, 0,
      bvh.triangles.subarray(0, bvh.triangleCount * TRIANGLE_BYTES / 4),
    );
    this.bvhNodesBuffer = nodeBuf;
    this.trianglesBuffer = triBuf;
    this.bvhNodeCount = bvh.nodeCount;
    this.bvhTriangleCount = bvh.triangleCount;
    this.bvhBounds = bvh.bounds;
  }

  hasBvh(): boolean {
    return this.bvhNodesBuffer !== null && this.trianglesBuffer !== null && this.bvhTriangleCount > 0;
  }

  getBvhStats(): { nodeCount: number; triangleCount: number; bounds: TriangleBVHResult['bounds'] | null } {
    return {
      nodeCount: this.bvhNodeCount,
      triangleCount: this.bvhTriangleCount,
      bounds: this.bvhBounds,
    };
  }

  /**
   * Run the compute pass for one point chunk. Encoder-based so the
   * caller can dispatch many chunks back-to-back in one submit.
   *
   * Returns false when there's no BVH uploaded yet — caller should
   * skip the chunk in that case.
   */
  dispatch(encoder: GPUCommandEncoder, input: DeviationDispatchInput): boolean {
    if (!this.bvhNodesBuffer || !this.trianglesBuffer) return false;
    if (input.pointCount === 0) return true;

    // Per-chunk uniform buffer with the dispatch params. Created
    // fresh each call — 32 bytes is too small to bother caching.
    const paramsBuffer = this.device.createBuffer({
      size: PARAMS_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const params = new Uint32Array(PARAMS_UNIFORM_BYTES / 4);
    const paramsF = new Float32Array(params.buffer);
    params[0] = input.pointCount;
    // Each point in the splat vertex layout occupies POINT_VERTEX_BYTES
    // (24 bytes). The shader walks `positions` as a flat f32 array; one
    // point = 6 floats; the vec3 position is at offset 0.
    params[1] = POINT_VERTEX_BYTES / 4; // pointStrideF32
    params[2] = 0;                       // positionOffsetF32
    paramsF[3] = Math.max(0, input.maxRange);
    // params[4..7] reserved padding; left zero.
    this.device.queue.writeBuffer(paramsBuffer, 0, params.buffer, 0, PARAMS_UNIFORM_BYTES);

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.bvhNodesBuffer } },
        { binding: 1, resource: { buffer: this.trianglesBuffer } },
        { binding: 2, resource: { buffer: input.positionsBuffer } },
        { binding: 3, resource: { buffer: input.deviationsBuffer } },
        { binding: 4, resource: { buffer: paramsBuffer } },
      ],
    });

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    // Workgroup size 64; ceil division. Most GPUs handle ~10⁵
    // workgroups in one dispatch without trouble.
    const groupCount = Math.ceil(input.pointCount / 64);
    pass.dispatchWorkgroups(groupCount);
    pass.end();
    return true;
  }

  private disposeBvh(): void {
    this.bvhNodesBuffer?.destroy();
    this.trianglesBuffer?.destroy();
    this.bvhNodesBuffer = null;
    this.trianglesBuffer = null;
  }

  destroy(): void {
    this.disposeBvh();
  }
}
