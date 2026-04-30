/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU pipeline for `topology: 'point-list'` rendering.
 *
 * Built once and shared across all point cloud assets in the scene.
 * Color attachments must match RenderPipeline's main pipeline (color +
 * objectId rgba8unorm) and depth/MSAA must match too — we render into
 * the same render pass.
 *
 * Vertex layout (24 bytes/point):
 *   0..11   vec3<f32>  position
 *   12..15  unorm8x4   color  (r, g, b, classification-as-byte)
 *   16..17  uint16     intensity (0..65535)
 *   18..19  uint8x2    pad / future flags
 *   20..23  uint32     entityId (federation-aware express id)
 */

import { pointShaderSource } from './point-shader.wgsl.js';

export const POINT_UNIFORM_SIZE = 192;
export const POINT_VERTEX_BYTES = 24;

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
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              // unorm8x4 unpacks the four bytes to a vec4<f32> in 0..1.
              // We carry classification in the alpha channel (also 0..1) and
              // recover the integer class id in the shader by *255.
              { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
              // intensity stays 0..65535 raw — shader normalises to 0..1.
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
        topology: 'point-list',
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
