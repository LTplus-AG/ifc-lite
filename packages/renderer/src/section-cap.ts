/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SectionCapRenderer — filled, hatched cut surfaces for the 3D section plane.
 *
 * Conceptual model (the user's "large void that subtracts whatever is on the
 * other side of the slider"): the clipping plane describes an infinite half-
 * space void. Wherever that void intersects a closed solid, we render a cap
 * surface showing the cut.
 *
 * Implementation: three stencil passes + one full-screen fill.
 *
 *   Pass A (stencilBackIncPipeline):
 *     - Cull front faces so only BACK faces are rasterised.
 *     - Fragment shader discards fragments below the plane.
 *     - Stencil op: increment (front+back both inc, but cull keeps us to back).
 *     - No colour or depth write.
 *
 *   Pass B (stencilFrontDecPipeline):
 *     - Cull back faces so only FRONT faces are rasterised.
 *     - Same plane discard.
 *     - Stencil op: decrement.
 *     - No colour or depth write.
 *
 *   Pass C (fillPipeline):
 *     - Full-screen triangle.
 *     - Stencil test: pass where stencil != 0.
 *     - Fragment shader paints the cap colour + screen-space hatch.
 *
 * For a closed convex-ish mesh, Pass A contributes +1 where a back face is
 * "inside" the clipped half-space and the corresponding front face was
 * discarded by the main pass. Pass B undoes that where a front face is also
 * above the plane. Net stencil > 0 exactly at the intersection of the plane
 * with the solid — the cap region.
 */

import type { BatchedMesh, Mesh } from './types.js';
import type { RenderPipeline } from './pipeline.js';
import {
  stencilGeomShaderSource,
  capFillShaderSource,
} from './shaders/section-cap.wgsl.js';

/**
 * Hatch pattern identifiers. Keep in sync with the `patternId` branches in
 * `capFillShaderSource` (shaders/section-cap.wgsl.ts).
 */
export const HATCH_PATTERN_IDS = {
  solid:       0,
  diagonal:    1,
  crossHatch:  2,
  horizontal:  3,
  vertical:    4,
  concrete:    5,
  brick:       6,
  insulation:  7,
} as const;

export type HatchPatternId = keyof typeof HATCH_PATTERN_IDS;

export interface SectionCapStyle {
  /** Fill colour behind the hatch. RGBA, each 0-1. */
  fillColor:   [number, number, number, number];
  /** Hatch stroke colour. RGBA. */
  strokeColor: [number, number, number, number];
  /** Pattern to draw on top of the fill. */
  pattern:     HatchPatternId;
  /** Spacing between hatch lines, in screen-space pixels. */
  spacingPx:   number;
  /** Primary angle in radians. */
  angleRad:    number;
  /** Line width in pixels. */
  widthPx:     number;
  /** Secondary angle (radians) for cross-hatch. Ignored for other patterns. */
  secondaryAngleRad: number;
}

export const DEFAULT_CAP_STYLE: SectionCapStyle = {
  fillColor:   [0.92, 0.88, 0.78, 1.0],    // warm paper
  strokeColor: [0.1,  0.1,  0.1,  1.0],    // ink
  pattern:     'diagonal',
  spacingPx:   8,
  angleRad:    Math.PI / 4,                // 45°
  widthPx:     1.0,
  secondaryAngleRad: -Math.PI / 4,
};

export interface SectionCapDrawOptions {
  viewProj:     Float32Array;
  /** World-space plane equation. `dot(x, normal) == distance` defines the plane. */
  planeNormal:  [number, number, number];
  planeDistance: number;
  /** If true, cap the opposite half (flipped slider). */
  flipped:      boolean;
  /** Per-frame cap style. */
  style:        SectionCapStyle;
  /** Batched meshes to consider for stencil counting. */
  batches:      BatchedMesh[];
  /** Individual meshes to consider for stencil counting. */
  meshes:       Mesh[];
}

// ─── Uniform layout ───────────────────────────────────────────────────────

// Stencil-geom uniforms: viewProj (64) + sectionPlane (16) + flags (16) = 96 B.
const STENCIL_UNIFORM_BYTES = 96;
// Cap-fill uniforms: fillColor (16) + strokeColor (16) + params (16) + params2 (16) = 64 B.
const FILL_UNIFORM_BYTES = 64;

// Stencil reference used by the fill pass — any non-zero value matches the
// "cap region" (stencil test is NotEqual against 0).
const STENCIL_REF = 0;

export class SectionCapRenderer {
  private device: GPUDevice;
  private mainPipeline: RenderPipeline;

  private stencilBackIncPipeline: GPURenderPipeline;
  private stencilFrontDecPipeline: GPURenderPipeline;
  private fillPipeline: GPURenderPipeline;

  private stencilUniformBuffer: GPUBuffer;
  private fillUniformBuffer:    GPUBuffer;
  private stencilBindGroup:     GPUBindGroup;
  private fillBindGroup:        GPUBindGroup;

  // Scratch buffers reused each frame.
  private stencilScratch = new Float32Array(STENCIL_UNIFORM_BYTES / 4);
  private stencilScratchU32 = new Uint32Array(this.stencilScratch.buffer, 80, 4);
  private fillScratch = new Float32Array(FILL_UNIFORM_BYTES / 4);

  constructor(device: GPUDevice, mainPipeline: RenderPipeline, colorFormat: GPUTextureFormat) {
    this.device = device;
    this.mainPipeline = mainPipeline;
    const sampleCount = mainPipeline.getSampleCount();
    const depthFormat = mainPipeline.getDepthFormat();

    // ─── Stencil-geom pipelines ─────────────────────────────────────────
    const stencilShader = device.createShaderModule({
      code: stencilGeomShaderSource,
      label: 'section-cap-stencil-geom',
    });

    const stencilBindLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    const stencilLayout = device.createPipelineLayout({
      bindGroupLayouts: [stencilBindLayout],
    });

    // Matches the main pipeline vertex layout exactly so we can reuse batched
    // vertex buffers without any repack.
    const vertexBuffers: GPUVertexBufferLayout[] = [{
      arrayStride: 28,
      attributes: [
        { shaderLocation: 0, offset:  0, format: 'float32x3' }, // position
        { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal (unused by cap)
        { shaderLocation: 2, offset: 24, format: 'uint32'   }, // entityId (unused by cap)
      ],
    }];

    const stencilBase = {
      layout: stencilLayout,
      vertex:   { module: stencilShader, entryPoint: 'vs_main', buffers: vertexBuffers },
      // No colour targets. The fragment shader writes nothing; only the
      // stencil op runs.
      fragment: { module: stencilShader, entryPoint: 'fs_main', targets: [] as GPUColorTargetState[] },
      primitive: { topology: 'triangle-list' as const },
      multisample: { count: sampleCount },
    };

    this.stencilBackIncPipeline = device.createRenderPipeline({
      ...stencilBase,
      label: 'section-cap-back-inc',
      primitive: { ...stencilBase.primitive, cullMode: 'front' },
      depthStencil: {
        format: depthFormat,
        depthCompare: 'greater-equal',      // Reverse-Z: keep fragments in front of occluders.
        depthWriteEnabled: false,
        stencilFront: {
          compare: 'always',
          passOp:      'increment-clamp',
          failOp:      'keep',
          depthFailOp: 'keep',
        },
        stencilBack: {
          compare: 'always',
          passOp:      'increment-clamp',
          failOp:      'keep',
          depthFailOp: 'keep',
        },
        stencilReadMask:  0xff,
        stencilWriteMask: 0xff,
      },
    });

    this.stencilFrontDecPipeline = device.createRenderPipeline({
      ...stencilBase,
      label: 'section-cap-front-dec',
      primitive: { ...stencilBase.primitive, cullMode: 'back' },
      depthStencil: {
        format: depthFormat,
        depthCompare: 'greater-equal',
        depthWriteEnabled: false,
        stencilFront: {
          compare: 'always',
          passOp:      'decrement-clamp',
          failOp:      'keep',
          depthFailOp: 'keep',
        },
        stencilBack: {
          compare: 'always',
          passOp:      'decrement-clamp',
          failOp:      'keep',
          depthFailOp: 'keep',
        },
        stencilReadMask:  0xff,
        stencilWriteMask: 0xff,
      },
    });

    // ─── Cap fill pipeline ──────────────────────────────────────────────
    const fillShader = device.createShaderModule({
      code: capFillShaderSource,
      label: 'section-cap-fill',
    });

    const fillBindLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    const fillLayout = device.createPipelineLayout({
      bindGroupLayouts: [fillBindLayout],
    });

    this.fillPipeline = device.createRenderPipeline({
      label: 'section-cap-fill',
      layout: fillLayout,
      vertex:   { module: fillShader, entryPoint: 'vs_main' },
      fragment: {
        module: fillShader,
        entryPoint: 'fs_main',
        targets: [{
          format: colorFormat,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: depthFormat,
        depthCompare: 'always',
        depthWriteEnabled: false,
        stencilFront: {
          compare: 'not-equal',
          passOp:      'zero',   // Clear stencil for the next frame.
          failOp:      'zero',
          depthFailOp: 'zero',
        },
        stencilBack: {
          compare: 'not-equal',
          passOp:      'zero',
          failOp:      'zero',
          depthFailOp: 'zero',
        },
        stencilReadMask:  0xff,
        stencilWriteMask: 0xff,
      },
      multisample: { count: sampleCount },
    });

    this.stencilUniformBuffer = device.createBuffer({
      size: STENCIL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'section-cap-stencil-uniforms',
    });
    this.fillUniformBuffer = device.createBuffer({
      size: FILL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'section-cap-fill-uniforms',
    });

    this.stencilBindGroup = device.createBindGroup({
      layout: stencilBindLayout,
      entries: [{ binding: 0, resource: { buffer: this.stencilUniformBuffer } }],
    });
    this.fillBindGroup = device.createBindGroup({
      layout: fillBindLayout,
      entries: [{ binding: 0, resource: { buffer: this.fillUniformBuffer } }],
    });
  }

  /**
   * Draw the cap into the given render pass. Must be called AFTER the main
   * opaque pass has written the depth buffer so the cap's depth test works.
   * The pass must own a depth-stencil attachment with stencilStoreOp = 'store'.
   */
  draw(pass: GPURenderPassEncoder, opts: SectionCapDrawOptions): void {
    // ── Write stencil-geom uniforms ─────────────────────────────────────
    this.stencilScratch.set(opts.viewProj, 0);
    this.stencilScratch[16] = opts.planeNormal[0];
    this.stencilScratch[17] = opts.planeNormal[1];
    this.stencilScratch[18] = opts.planeNormal[2];
    this.stencilScratch[19] = opts.planeDistance;
    this.stencilScratchU32[0] = opts.flipped ? 1 : 0;
    this.stencilScratchU32[1] = 0;
    this.stencilScratchU32[2] = 0;
    this.stencilScratchU32[3] = 0;
    this.device.queue.writeBuffer(this.stencilUniformBuffer, 0, this.stencilScratch);

    // ── Write cap-fill uniforms ─────────────────────────────────────────
    const s = opts.style;
    this.fillScratch[0]  = s.fillColor[0];
    this.fillScratch[1]  = s.fillColor[1];
    this.fillScratch[2]  = s.fillColor[2];
    this.fillScratch[3]  = s.fillColor[3];
    this.fillScratch[4]  = s.strokeColor[0];
    this.fillScratch[5]  = s.strokeColor[1];
    this.fillScratch[6]  = s.strokeColor[2];
    this.fillScratch[7]  = s.strokeColor[3];
    this.fillScratch[8]  = HATCH_PATTERN_IDS[s.pattern];
    this.fillScratch[9]  = s.spacingPx;
    this.fillScratch[10] = s.angleRad;
    this.fillScratch[11] = s.widthPx;
    this.fillScratch[12] = s.secondaryAngleRad;
    this.fillScratch[13] = 0;
    this.fillScratch[14] = 0;
    this.fillScratch[15] = 0;
    this.device.queue.writeBuffer(this.fillUniformBuffer, 0, this.fillScratch);

    // ── Pass A: back faces inc ──────────────────────────────────────────
    pass.setStencilReference(STENCIL_REF);
    pass.setBindGroup(0, this.stencilBindGroup);
    pass.setPipeline(this.stencilBackIncPipeline);
    this.drawGeometry(pass, opts);

    // ── Pass B: front faces dec ─────────────────────────────────────────
    pass.setPipeline(this.stencilFrontDecPipeline);
    this.drawGeometry(pass, opts);

    // ── Pass C: fill quad where stencil != 0 ────────────────────────────
    pass.setPipeline(this.fillPipeline);
    pass.setBindGroup(0, this.fillBindGroup);
    pass.draw(3, 1, 0, 0);
  }

  private drawGeometry(pass: GPURenderPassEncoder, opts: SectionCapDrawOptions): void {
    for (const b of opts.batches) {
      if (!b.vertexBuffer || !b.indexBuffer) continue;
      pass.setVertexBuffer(0, b.vertexBuffer);
      pass.setIndexBuffer(b.indexBuffer, 'uint32');
      pass.drawIndexed(b.indexCount);
    }
    for (const m of opts.meshes) {
      if (!m.vertexBuffer || !m.indexBuffer) continue;
      pass.setVertexBuffer(0, m.vertexBuffer);
      pass.setIndexBuffer(m.indexBuffer, 'uint32');
      pass.drawIndexed(m.indexCount, 1, 0, 0, 0);
    }
  }

  destroy(): void {
    this.stencilUniformBuffer.destroy();
    this.fillUniformBuffer.destroy();
  }
}
