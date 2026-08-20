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

/**
 * The clip this frame, mirrored from the colour pass so clipped-away geometry
 * stops casting (a sectioned-off roof must not keep shadowing the floor).
 * `null`/all-absent members mean "no clipping" and keep the fragment-less
 * depth-only pipelines.
 */
export interface ShadowClip {
  /** World-space plane; fragments on its + side are cut (see `flipped`). */
  section?: {
    normal: readonly [number, number, number];
    distance: number;
    flipped?: boolean;
  } | null;
  /** World-space crop box; fragments outside it are cut. */
  box?: {
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  } | null;
}

/** Bytes of the per-draw uniform: mat4 model (64) + vec4 quantParams (16). */
const PER_DRAW_BYTES = 80;

/** Bytes of the clip uniform: sectionPlane + boxMin + boxMax + flags (4 vec4). */
const CLIP_BYTES = 64;

/** Depth format for the shadow map — sampleable and comparison-filterable. */
const SHADOW_DEPTH_FORMAT: GPUTextureFormat = 'depth32float';

export class ShadowPass {
  private device: GPUDevice;
  private resolution: number;

  private depthTexture: GPUTexture;
  private depthTextureView: GPUTextureView;

  private bindGroupLayout: GPUBindGroupLayout;
  private pipelines: Record<ShadowDrawKind, GPURenderPipeline>;
  /**
   * Clipping twins of {@link pipelines} — same state plus the discarding
   * fragment stage. Built on the first clipped frame only, so a session that
   * never sections anything never pays for the extra pipelines.
   */
  private clipPipelines: Record<ShadowDrawKind, GPURenderPipeline> | null = null;
  private shaderModule: GPUShaderModule;
  private pipelineLayout: GPUPipelineLayout;

  private lightBuffer: GPUBuffer;
  private lightScratch = new Float32Array(16);

  /** Clip uniform (floats 0..11) with the flag word aliased as u32 (word 12). */
  private clipBuffer: GPUBuffer;
  private clipScratch = new Float32Array(CLIP_BYTES / 4);
  private clipFlags = new Uint32Array(this.clipScratch.buffer);

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

    this.clipBuffer = device.createBuffer({
      label: 'shadow-clip-uniform',
      size: CLIP_BYTES,
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
        // Read only by the clipping fragment stage; the depth-only pipelines
        // simply leave this entry unused.
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    this.drawBufferSlots = 256;
    this.drawBuffer = this.createDrawBuffer(this.drawBufferSlots);
    this.drawScratch = new Float32Array((this.drawStride / 4) * this.drawBufferSlots);
    this.drawBindGroup = this.createDrawBindGroup();

    this.shaderModule = device.createShaderModule({
      label: 'shadow-shader',
      code: shadowShaderSource,
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
    this.pipelines = this.createPipelineSet(false);
  }

  /** One pipeline per geometry path, with or without the clipping fragment stage. */
  private createPipelineSet(clipped: boolean): Record<ShadowDrawKind, GPURenderPipeline> {
    const make = (entryPoint: string, buffers: GPUVertexBufferLayout[]) =>
      this.createPipeline(this.shaderModule, this.pipelineLayout, entryPoint, buffers, clipped);
    return {
      flat: make('vs_shadow_flat', [this.posBuffer(28)]),
      textured: make('vs_shadow_textured', [this.posBuffer(36)]),
      quantized: make('vs_shadow_quantized', [this.quantBuffer()]),
      instanced: make('vs_shadow_instanced', [this.posBuffer(28), this.instanceBuffer()]),
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
   *
   * `clip` mirrors the colour pass's section plane / clip box; when it cuts
   * anything the draws go through the clipping pipelines so removed geometry
   * casts nothing.
   */
  render(
    encoder: GPUCommandEncoder,
    lightViewProj: Mat4,
    draws: readonly ShadowOccluderDraw[],
    clip?: ShadowClip | null,
  ): void {
    if (this.destroyed) return;

    // Shared light matrix — one write per frame.
    this.lightScratch.set(lightViewProj.m);
    this.device.queue.writeBuffer(this.lightBuffer, 0, this.lightScratch);

    const clipping = this.writeClipUniform(clip);
    if (clipping && !this.clipPipelines) this.clipPipelines = this.createPipelineSet(true);
    const pipelines = clipping && this.clipPipelines ? this.clipPipelines : this.pipelines;

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
      pass.setPipeline(pipelines[d.kind]);
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
    this.clipBuffer.destroy();
  }

  /**
   * Pack this frame's clip into the uniform, laid out (and flag-packed) exactly
   * like the colour pass's. Returns whether anything is actually being cut —
   * the caller uses that to pick the clipping pipelines. Writes only when
   * clipping: with nothing cut the uniform is never read.
   */
  private writeClipUniform(clip: ShadowClip | null | undefined): boolean {
    const section = clip?.section;
    const box = clip?.box;
    if (!section && !box) return false;

    const s = this.clipScratch;
    s.fill(0);
    if (section) {
      s[0] = section.normal[0];
      s[1] = section.normal[1];
      s[2] = section.normal[2];
      s[3] = section.distance;
    }
    if (box) {
      s[4] = box.min[0];
      s[5] = box.min[1];
      s[6] = box.min[2];
      s[8] = box.max[0];
      s[9] = box.max[1];
      s[10] = box.max[2];
    }
    // flags.x — bit 0 section enabled, bit 1 flipped, bit 2 clip box enabled.
    this.clipFlags[12] = (section ? 1 : 0) | (section?.flipped ? 2 : 0) | (box ? 4 : 0);
    this.device.queue.writeBuffer(this.clipBuffer, 0, s);
    return true;
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
        { binding: 2, resource: { buffer: this.clipBuffer } },
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
    clipped: boolean,
  ): GPURenderPipeline {
    return this.device.createRenderPipeline({
      label: `shadow-pipeline-${entryPoint}${clipped ? '-clipped' : ''}`,
      layout,
      vertex: { module, entryPoint, buffers },
      // Depth-only unless a clip is active, in which case a fragment stage
      // with no colour targets discards the cut-away fragments before they
      // write depth.
      ...(clipped
        ? { fragment: { module, entryPoint: 'fs_shadow_clip', targets: [] } }
        : {}),
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
        //
        // Kept SMALL for depth32float: the constant-bias unit for a float depth
        // format is implementation-defined and scales with the depth exponent,
        // so a large constant behaves unpredictably across the range/hardware
        // (#2670 review). The shader-side slope bias (sunShadowFactor) is the
        // primary acne defense; this is a light occluder-side nudge, bounded by
        // a clamp so no driver can turn it into peter-panning.
        depthBias: -1,
        depthBiasSlopeScale: -2,
        depthBiasClamp: -0.004,
      },
    });
  }
}
