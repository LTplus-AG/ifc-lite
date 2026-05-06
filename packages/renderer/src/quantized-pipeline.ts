/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU pipeline that consumes the quantised + instanced scene bundle
 * produced by `parseQuantizedInstanced` in the WASM bridge.
 *
 * Vertex layout (12 B):     unorm16x4 position + snorm8x4 oct-normal
 * Per-mesh uniform (64 B):  AABB + vertex/index offsets + instance range
 * Per-instance SSBO (80 B): mat4 + expressId + baseColor + override + flags
 *
 * Side-by-side with `RenderPipeline` / `InstancedRenderPipeline`. Existing
 * paths are unaffected; this class is opt-in until visual parity is verified.
 */

import type { WebGPUDevice } from './device.js';
import { quantizedShaderSource } from './shaders/quantized.wgsl.js';

export const QUANTIZED_VERTEX_STRIDE = 12;
export const QUANTIZED_MESH_RECORD_SIZE = 64;
export const QUANTIZED_INSTANCE_RECORD_SIZE = 80;

/** Offsets within the per-instance record so other modules can patch fields. */
export const INSTANCE_FIELD_OFFSETS = {
  /** byte offset of `expressId` within the 80-byte instance record */
  expressId: 64,
  baseColor: 68,
  override: 72,
  flags: 76,
} as const;

/** Bit masks for the per-instance `flags` field. */
export const INSTANCE_FLAGS = {
  visible: 1 << 0,
  selected: 1 << 1,
  ghost: 1 << 2,
} as const;

/** Section-plane configuration matching the main pipeline. */
export interface QuantizedSectionPlane {
  normal: [number, number, number];
  distance: number;
  enabled: boolean;
  flipped?: boolean;
}

/**
 * Owns the GPU shader module + render pipeline + frame uniform buffer +
 * depth texture for the quantised render path.
 *
 * Bind groups for the per-mesh uniform and per-instance SSBO are created by
 * the caller (so a single pipeline can render across many `QuantizedScene`
 * instances without re-allocating).
 */
export class QuantizedRenderPipeline {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private depthTexture: GPUTexture;
  private depthTextureView: GPUTextureView;
  private objectIdTexture: GPUTexture;
  private objectIdTextureView: GPUTextureView;
  private readonly colorFormat: GPUTextureFormat;
  private readonly objectIdFormat: GPUTextureFormat = 'rgba8unorm';
  private readonly depthFormat: GPUTextureFormat = 'depth24plus-stencil8';

  constructor(device: WebGPUDevice, width = 1, height = 1) {
    this.device = device.getDevice();
    this.colorFormat = device.getFormat();

    this.depthTexture = this.device.createTexture({
      size: { width, height },
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTextureView = this.depthTexture.createView();
    this.objectIdTexture = this.device.createTexture({
      size: { width, height },
      format: this.objectIdFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.objectIdTextureView = this.objectIdTexture.createView();

    // Uniform buffer: viewProj (64) + sectionPlane (16) + flags (16) = 96 bytes.
    this.uniformBuffer = this.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Explicit bind group layout. Auto-layouts can fragment across pipelines;
    // declaring it here lets callers create instance bind groups independently.
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });

    const shaderModule = this.device.createShaderModule({ code: quantizedShaderSource });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: QUANTIZED_VERTEX_STRIDE,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'unorm16x4' }, // position
              { shaderLocation: 1, offset: 8, format: 'snorm8x4' }, // oct-normal
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.colorFormat }, { format: this.objectIdFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: true,
        // Reverse-Z to match the rest of the renderer.
        depthCompare: 'greater',
      },
    });
  }

  /** Resize the depth + objectId scratch textures (call on canvas resize). */
  resize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.depthTexture.destroy();
    this.depthTexture = this.device.createTexture({
      size: { width: w, height: h },
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTextureView = this.depthTexture.createView();
    this.objectIdTexture.destroy();
    this.objectIdTexture = this.device.createTexture({
      size: { width: w, height: h },
      format: this.objectIdFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.objectIdTextureView = this.objectIdTexture.createView();
  }

  /** Update the frame uniforms (viewProj + section plane). */
  updateUniforms(viewProj: Float32Array, sectionPlane?: QuantizedSectionPlane): void {
    if (viewProj.length !== 16) {
      throw new Error(`viewProj must be a 16-element matrix, got ${viewProj.length}`);
    }
    const buf = new Float32Array(24);
    const flags = new Uint32Array(buf.buffer, 80, 4);
    buf.set(viewProj, 0);
    if (sectionPlane?.enabled) {
      buf[16] = sectionPlane.normal[0];
      buf[17] = sectionPlane.normal[1];
      buf[18] = sectionPlane.normal[2];
      buf[19] = sectionPlane.distance;
      flags[0] = 1 | (sectionPlane.flipped ? 2 : 0);
    } else {
      flags[0] = 0;
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, buf.buffer, buf.byteOffset, buf.byteLength);
  }

  getPipeline(): GPURenderPipeline {
    return this.pipeline;
  }

  getBindGroupLayout(): GPUBindGroupLayout {
    return this.bindGroupLayout;
  }

  getUniformBuffer(): GPUBuffer {
    return this.uniformBuffer;
  }

  getDepthTextureView(): GPUTextureView {
    return this.depthTextureView;
  }

  /** Scratch objectId render target written during the main draw. */
  getObjectIdTextureView(): GPUTextureView {
    return this.objectIdTextureView;
  }

  getObjectIdTexture(): GPUTexture {
    return this.objectIdTexture;
  }

  getColorFormat(): GPUTextureFormat {
    return this.colorFormat;
  }

  getObjectIdFormat(): GPUTextureFormat {
    return this.objectIdFormat;
  }

  /**
   * Build a bind group for one [`QuantizedSceneBuffers`] instance.
   *
   * `meshUniformBuffer` must be at least `meshCount * 256` bytes (uniforms
   * have 256-byte minimum dynamic offset alignment in WebGPU spec).
   */
  createBindGroup(
    meshUniformBuffer: GPUBuffer,
    meshUniformSize: number,
    instanceBuffer: GPUBuffer,
  ): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        {
          binding: 1,
          resource: { buffer: meshUniformBuffer, offset: 0, size: meshUniformSize },
        },
        { binding: 2, resource: { buffer: instanceBuffer } },
      ],
    });
  }

  /** Release GPU resources. */
  destroy(): void {
    this.depthTexture.destroy();
    this.objectIdTexture.destroy();
    this.uniformBuffer.destroy();
  }
}
