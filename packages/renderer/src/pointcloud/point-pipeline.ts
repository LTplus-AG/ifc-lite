/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU pipeline for point cloud splatting.
 *
 * Each point is drawn as an instanced 6-vertex quad (`triangle-list` with
 * `stepMode: 'instance'` on the vertex buffer). The vertex shader picks
 * a corner offset from `vertex_index` and inflates the clip-space
 * position by the active size mode. Fragment discards out-of-disc
 * corners so splats render as round dots, not squares.
 *
 * Color attachments must match RenderPipeline's main pipeline (color +
 * objectId rgba8unorm) and depth/MSAA must match too — we render into
 * the same render pass.
 *
 * Vertex layout (24 bytes/point, per-instance):
 *   0..11   vec3<f32>  position
 *   12..15  unorm8x4   color  (r, g, b, classification-as-byte)
 *   16..19  uint32     intensity (low 16 bits, 0..65535)
 *   20..23  uint32     entityId (federation-aware express id)
 */

import { pointShaderSource } from './point-shader.wgsl.js';

/**
 * Uniform block size in bytes. Layout (Float32 indices):
 *   [0..15]  viewProj (mat4x4)
 *   [16..31] model    (mat4x4)
 *   [32..35] colorOverride (vec4)
 *   [36..39] colorModeAndExtras (mode, pointSizePx, heightMin, heightMax)
 *   [40..43] sizing (sizeMode, worldRadius, viewportW, viewportH)
 *   [44..47] sectionPlane (nx, ny, nz, distance)
 *   [48..51] flags (u32 view: x=unused, y=sectionEnabled, z=roundShape, w=unused)
 *   [52..55] extras (u32 view: x=previewStride, yzw=unused)
 */
// 14 vec4 slots × 16 bytes = 224 (was 208 before the `extras` slot).
// Bumped to make room for the preview-density path's stride-cull
// during section-plane drag without overloading the existing flags
// slot (which is already crowded across other PRs).
export const POINT_UNIFORM_SIZE = 224;
export const POINT_VERTEX_BYTES = 24;
/** Number of vertices emitted per splat (two triangles forming a quad). */
export const POINT_QUAD_VERTS = 6;

export class PointRenderPipeline {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private bindGroupLayout: GPUBindGroupLayout;

  constructor(
    device: GPUDevice,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    sampleCount: number,
  ) {
    this.device = device;

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const layout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    const shader = device.createShaderModule({ code: pointShaderSource });

    this.pipeline = device.createRenderPipeline({
      layout,
      vertex: {
        module: shader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: POINT_VERTEX_BYTES,
            // One source point feeds all 6 quad vertices: per-instance step.
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
              { shaderLocation: 2, offset: 16, format: 'uint32' },
              { shaderLocation: 3, offset: 20, format: 'uint32' },
            ],
          },
        ],
      },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [{ format: colorFormat }, { format: 'rgba8unorm' }],
      },
      primitive: {
        topology: 'triangle-list',
      },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: true,
        depthCompare: 'greater', // reverse-Z, matches RenderPipeline main pipeline
      },
      multisample: { count: sampleCount },
    });
  }

  getPipeline(): GPURenderPipeline {
    return this.pipeline;
  }

  getBindGroupLayout(): GPUBindGroupLayout {
    return this.bindGroupLayout;
  }

  createUniformBuffer(): GPUBuffer {
    return this.device.createBuffer({
      size: POINT_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  createBindGroup(uniformBuffer: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
  }
}
