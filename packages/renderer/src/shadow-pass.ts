/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sun shadow-map depth pre-pass (issue #2670, Phase 2a).
 *
 * Owns the shadow depth texture and the four depth-only pipelines (one per
 * geometry path — flat, quantized, instanced, textured), and records a single
 * depth-only render pass that rasterises every occluder from the sun's point
 * of view. The main colour pass (Phase 2b) then samples this depth map to
 * decide lit vs. shadowed.
 *
 * Per-draw `model`/`quantParams` are supplied through ONE dynamic-offset
 * uniform buffer (a grow-only ring) rather than a buffer per batch, so a
 * CATIA-class model with thousands of batches costs one allocation, not
 * thousands. `lightViewProj` is shared (written once per frame).
 *
 * The pass is single-sample and double-sided (cullMode 'none'): IFC winding is
 * not reliably outward — the colour pipelines already draw double-sided for
 * the same reason — so front/back-face culling would drop occluders and punch
 * holes in the shadow.
 */

import type { Mat4 } from './types.js';
import { shadowShaderSource } from './shaders/shadow.wgsl.js';

/** Which geometry path an occluder draw came from — selects the pipeline. */
export type ShadowDrawKind = 'flat' | 'quantized' | 'instanced' | 'textured';

/** One occluder draw recorded into the depth pre-pass. */
export interface ShadowOccluderDraw {
  kind: ShadowDrawKind;
  /** Slot-0 vertex buffer (positions). */
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  /**
   * Column-major model matrix (16 floats). Carries the batch origin for the
   * flat/quantized/textured paths; ignored for the instanced path.
   */
  model?: Float32Array;
  /** Dequantization params [minX, minY, minZ, step]; quantized path only. */
  quantParams?: readonly [number, number, number, number];
  /** Slot-1 per-occurrence instance buffer; instanced path only. */
  instanceBuffer?: GPUBuffer;
  /** Instance count; instanced path only. */
  instanceCount?: number;
}

/** Bytes of the per-draw uniform: mat4 model (64) + vec4 quantParams (16). */
const PER_DRAW_BYTES = 80;

/** Depth format for the shadow map — sampleable and comparison-filterable. */
const SHADOW_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

export class ShadowPass {
  private device: GPUDevice;
  private resolution: number;

  private depthTexture: GPUTexture;
  private depthTextureView: GPUTextureView;

  private bindGroupLayout: GPUBindGroupLayout;
  private pipelines: Record<ShadowDrawKind, GPURenderPipeline>;

  private lightBuffer: GPUBuffer;
  private lightScratch = new Float32Array(16);

  /** Grow-only ring for per-draw uniforms, bound with a dynamic offset. */
  private drawBuffer: GPUBuffer;
  private drawBufferSlots: number;
  private drawStride: number;
  private drawBindGroup: GPUBindGroup;
  private drawScratch: Float32Array;

  private destroyed = false;

  constructor(device: GPUDevice, resolution: number) {
    this.device = device;
    this.resolution = Math.max(256, Math.floor(resolution));

    // Per-draw uniforms are addressed by dynamic offset, which must be a
    // multiple of the device's minimum alignment (256 on most GPUs).
    const align = device.limits.minUniformBufferOffsetAlignment || 256;
    this.drawStride = Math.ceil(PER_DRAW_BYTES / align) * align;

    this.depthTexture = this.createDepthTexture(this.resolution);
    this.depthTextureView = this.depthTexture.createView();

    this.lightBuffer = device.createBuffer({
      label: 'shadow-light-uniform',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'shadow-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PER_DRAW_BYTES },
        },
      ],
    });

    this.drawBufferSlots = 256;
    this.drawBuffer = this.createDrawBuffer(this.drawBufferSlots);
    this.drawScratch = new Float32Array((this.drawStride / 4) * this.drawBufferSlots);
    this.drawBindGroup = this.createDrawBindGroup();

    const module = device.createShaderModule({ label: 'shadow-shader', code: shadowShaderSource });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
    this.pipelines = {
      flat: this.createPipeline(module, layout, 'vs_shadow_flat', [this.posBuffer(28)]),
      textured: this.createPipeline(module, layout, 'vs_shadow_textured', [this.posBuffer(36)]),
      quantized: this.createPipeline(module, layout, 'vs_shadow_quantized', [this.quantBuffer()]),
      instanced: this.createPipeline(module, layout, 'vs_shadow_instanced', [
        this.posBuffer(28),
        this.instanceBuffer(),
      ]),
    };
  }

  /** Depth-texture view for the colour pass to sample. */
  getDepthTextureView(): GPUTextureView {
    return this.depthTextureView;
  }

  getResolution(): number {
    return this.resolution;
  }

  /** Resize the shadow map (Quality-panel control, Phase 2b). No-op if same. */
  setResolution(resolution: number): void {
    const res = Math.max(256, Math.floor(resolution));
    if (res === this.resolution || this.destroyed) return;
    this.resolution = res;
    this.depthTexture.destroy();
    this.depthTexture = this.createDepthTexture(res);
    this.depthTextureView = this.depthTexture.createView();
  }

  /**
   * Record the depth pre-pass: rasterise every occluder from the sun. Writes
   * all uniforms (queue ops, before the pass begins), then draws.
   */
  render(
    encoder: GPUCommandEncoder,
    lightViewProj: Mat4,
    draws: readonly ShadowOccluderDraw[],
  ): void {
    if (this.destroyed) return;

    // Shared light matrix — one write per frame.
    this.lightScratch.set(lightViewProj.m);
    this.device.queue.writeBuffer(this.lightBuffer, 0, this.lightScratch);

    // Grow the per-draw ring if this frame needs more slots than it holds.
    if (draws.length > this.drawBufferSlots) {
      let slots = this.drawBufferSlots;
      while (slots < draws.length) slots *= 2;
      this.drawBufferSlots = slots;
      this.drawBuffer.destroy();
      this.drawBuffer = this.createDrawBuffer(slots);
      this.drawScratch = new Float32Array((this.drawStride / 4) * slots);
      this.drawBindGroup = this.createDrawBindGroup();
    }

    // Pack per-draw uniforms (model + quantParams) at dynamic-offset strides.
    const strideFloats = this.drawStride / 4;
    for (let i = 0; i < draws.length; i++) {
      const d = draws[i];
      const base = i * strideFloats;
      if (d.model) this.drawScratch.set(d.model, base);
      // else leave identity-ish zero; only the instanced path omits model and
      // it never reads draw.model.
      const q = d.quantParams;
      this.drawScratch[base + 16] = q ? q[0] : 0;
      this.drawScratch[base + 17] = q ? q[1] : 0;
      this.drawScratch[base + 18] = q ? q[2] : 0;
      this.drawScratch[base + 19] = q ? q[3] : 0;
    }
    if (draws.length > 0) {
      this.device.queue.writeBuffer(
        this.drawBuffer,
        0,
        this.drawScratch.buffer,
        this.drawScratch.byteOffset,
        draws.length * this.drawStride,
      );
    }

    const pass = encoder.beginRenderPass({
      label: 'shadow-depth-pass',
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.depthTextureView,
        depthClearValue: 0.0, // reverse-Z far
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    for (let i = 0; i < draws.length; i++) {
      const d = draws[i];
      pass.setPipeline(this.pipelines[d.kind]);
      pass.setBindGroup(0, this.drawBindGroup, [i * this.drawStride]);
      pass.setVertexBuffer(0, d.vertexBuffer);
      pass.setIndexBuffer(d.indexBuffer, 'uint32');
      if (d.kind === 'instanced') {
        if (!d.instanceBuffer || !d.instanceCount) continue;
        pass.setVertexBuffer(1, d.instanceBuffer);
        pass.drawIndexed(d.indexCount, d.instanceCount);
      } else {
        pass.drawIndexed(d.indexCount);
      }
    }

    pass.end();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.depthTexture.destroy();
    this.lightBuffer.destroy();
    this.drawBuffer.destroy();
  }

  private createDepthTexture(resolution: number): GPUTexture {
    return this.device.createTexture({
      label: 'shadow-depth',
      size: [resolution, resolution, 1],
      format: SHADOW_DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  private createDrawBuffer(slots: number): GPUBuffer {
    return this.device.createBuffer({
      label: 'shadow-per-draw-uniform',
      size: slots * this.drawStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private createDrawBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      label: 'shadow-bg',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.lightBuffer } },
        { binding: 1, resource: { buffer: this.drawBuffer, size: PER_DRAW_BYTES } },
      ],
    });
  }

  private posBuffer(stride: number): GPUVertexBufferLayout {
    return {
      arrayStride: stride,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
    };
  }

  private quantBuffer(): GPUVertexBufferLayout {
    return {
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'uint16x4' }],
    };
  }

  private instanceBuffer(): GPUVertexBufferLayout {
    return {
      arrayStride: 88,
      stepMode: 'instance',
      attributes: [
        { shaderLocation: 3, offset: 0, format: 'float32x4' },
        { shaderLocation: 4, offset: 16, format: 'float32x4' },
        { shaderLocation: 5, offset: 32, format: 'float32x4' },
        { shaderLocation: 6, offset: 48, format: 'float32x4' },
      ],
    };
  }

  private createPipeline(
    module: GPUShaderModule,
    layout: GPUPipelineLayout,
    entryPoint: string,
    buffers: GPUVertexBufferLayout[],
  ): GPURenderPipeline {
    return this.device.createRenderPipeline({
      label: `shadow-pipeline-${entryPoint}`,
      layout,
      vertex: { module, entryPoint, buffers },
      // No fragment stage: depth-only.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: SHADOW_DEPTH_FORMAT,
        depthWriteEnabled: true,
        // Reverse-Z: keep the fragment CLOSEST to the light (largest depth).
        depthCompare: 'greater-equal',
        // Slope-scaled depth bias — the canonical fix for shadow acne on large
        // flat receivers at a grazing sun, where a normal-offset bias is
        // ineffective (the offset is nearly perpendicular to the light). The
        // slope term grows the push with the polygon's tilt to the light, so a
        // ground plane under an evening sun stops self-shadowing into moiré.
        // Reverse-Z inverts the sign: negative pushes the stored occluder depth
        // AWAY from the light, so a co-planar receiver passes `greater-equal`.
        depthBias: -2,
        depthBiasSlopeScale: -4,
        depthBiasClamp: 0,
      },
    });
  }
}
