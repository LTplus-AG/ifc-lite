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
 * Implementation: one stencil parity pass + one full-screen fill.
 *
 *   Pass A (stencilParityPipeline):
 *     - cullMode: 'none' — IFC geometry mixes windings, so back/front-face
 *       classification is unreliable. Instead of counting front vs back, we
 *       count triangle parity: for any camera ray through a pixel, count how
 *       many triangles lie ABOVE the clipping plane on that ray.
 *     - Fragment shader discards fragments BELOW the plane. Fragments above
 *       the plane pass.
 *     - Stencil op: invert bit 0 on pass (equivalent to XOR 1).
 *     - Depth test: 'always' with no depth write — we want every triangle
 *       covering the pixel to contribute, not just the front-most.
 *
 *     For a pixel whose camera ray crosses the plane INSIDE a solid (a cap
 *     pixel), an odd number of triangles lie above the plane on that ray
 *     (exactly one surface crossing happens on one side of the plane). For
 *     any other pixel an even number of triangles contribute (0 for rays
 *     that miss the solid, 2 for rays that pass entirely through the half
 *     of the solid above the plane, …). Parity is winding-independent, so
 *     this works even on the mixed-winding IFC geometry that forced the
 *     main pipeline to disable face culling.
 *
 *   Pass B (fillPipeline):
 *     - Full-screen triangle.
 *     - Stencil test: pass where bit 0 is set (reference 1, readMask 1,
 *       compare 'equal').
 *     - Fragment shader paints the cap colour + screen-space hatch.
 *     - The fill pass also clears stencil back to 0 via `zero` passOp so the
 *       next frame starts clean without needing an explicit clear.
 */

import type { BatchedMesh, InstancedMesh, Mesh } from './types.js';
import type { RenderPipeline } from './pipeline.js';
import {
  stencilGeomShaderSource,
  stencilGeomInstancedShaderSource,
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
  /** Instanced meshes to consider for stencil counting. */
  instanced?:   InstancedMesh[];
}

// ─── Uniform layout ───────────────────────────────────────────────────────

// Stencil-geom uniforms: viewProj (64) + sectionPlane (16) + flags (16) = 96 B.
const STENCIL_UNIFORM_BYTES = 96;
// Cap-fill uniforms: fillColor (16) + strokeColor (16) + params (16) + params2 (16) = 64 B.
const FILL_UNIFORM_BYTES = 64;

// Stencil reference used by the fill pass. Bit 0 is set at cap pixels by the
// invert-parity stencil pass; the fill pipeline compares stencil bit 0 against
// this reference (equal) and clears it back to 0 so the buffer is ready for
// the next frame without an explicit clear.
const STENCIL_REF = 1;
const STENCIL_PARITY_MASK = 1;

export class SectionCapRenderer {
  private device: GPUDevice;
  private mainPipeline: RenderPipeline;

  // Single parity pipeline — works on mixed-winding IFC (no front/back cull).
  private stencilParityPipeline: GPURenderPipeline;
  // Parallel pipeline for instanced geometry — shares the same stencil state
  // but samples per-instance transforms via a storage buffer.
  private stencilParityInstancedPipeline: GPURenderPipeline;
  private stencilInstancedBindLayout: GPUBindGroupLayout;
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

    const parityStencil = {
      format: depthFormat,
      // depthCompare 'always' with no depth write — every triangle covering
      // the pixel must contribute to parity, not just the front-most one.
      depthCompare: 'always' as const,
      depthWriteEnabled: false,
      stencilFront: {
        compare: 'always' as const,
        passOp:      'invert' as const,
        failOp:      'keep'   as const,
        depthFailOp: 'keep'   as const,
      },
      stencilBack: {
        compare: 'always' as const,
        passOp:      'invert' as const,
        failOp:      'keep'   as const,
        depthFailOp: 'keep'   as const,
      },
      stencilReadMask:  STENCIL_PARITY_MASK,
      stencilWriteMask: STENCIL_PARITY_MASK,
    };

    this.stencilParityPipeline = device.createRenderPipeline({
      ...stencilBase,
      label: 'section-cap-parity',
      // cullMode: 'none' — mirror the main pipeline, which disables culling
      // because IFC geometry mixes winding orders. The parity (invert)
      // stencil op doesn't care which side of the triangle we see; every
      // triangle above the plane that covers the pixel toggles bit 0.
      primitive: { ...stencilBase.primitive, cullMode: 'none' },
      depthStencil: parityStencil,
    });

    // Instanced stencil-parity pipeline — same stencil rules, but reads
    // transforms from an instance storage buffer and has a different vertex
    // layout (no entityId attribute; matches InstancedRenderPipeline).
    const stencilInstancedShader = device.createShaderModule({
      code: stencilGeomInstancedShaderSource,
      label: 'section-cap-stencil-geom-instanced',
    });
    this.stencilInstancedBindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'read-only-storage' },
        },
      ],
    });
    const stencilInstancedLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.stencilInstancedBindLayout],
    });
    const instancedVertexBuffers: GPUVertexBufferLayout[] = [{
      // Matches InstancedRenderPipeline: position (3f) + normal (3f) = 24 B.
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset:  0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
      ],
    }];
    this.stencilParityInstancedPipeline = device.createRenderPipeline({
      label: 'section-cap-parity-instanced',
      layout: stencilInstancedLayout,
      vertex:   { module: stencilInstancedShader, entryPoint: 'vs_main', buffers: instancedVertexBuffers },
      fragment: { module: stencilInstancedShader, entryPoint: 'fs_main', targets: [] as GPUColorTargetState[] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: parityStencil,
      multisample: { count: sampleCount },
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
        // Pass where stencil bit 0 == reference bit 0 (= 1). The readMask
        // restricts the compare to bit 0 so any higher bits are ignored.
        stencilFront: {
          compare: 'equal',
          passOp:      'zero',   // Clear stencil for the next frame.
          failOp:      'keep',
          depthFailOp: 'keep',
        },
        stencilBack: {
          compare: 'equal',
          passOp:      'zero',
          failOp:      'keep',
          depthFailOp: 'keep',
        },
        stencilReadMask:  STENCIL_PARITY_MASK,
        stencilWriteMask: STENCIL_PARITY_MASK,
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

    // ── Pass A: stencil parity (bit 0 = XOR of triangles above plane) ───
    pass.setStencilReference(STENCIL_REF);
    pass.setBindGroup(0, this.stencilBindGroup);
    pass.setPipeline(this.stencilParityPipeline);
    this.drawBatchedAndIndividual(pass, opts);

    // Instanced geometry uses the 24-byte vertex layout and a per-instance
    // transform storage buffer, so it needs its own pipeline + bind group
    // per InstancedMesh. Same stencil state, same parity semantics.
    const instanced = opts.instanced ?? [];
    if (instanced.length > 0) {
      pass.setPipeline(this.stencilParityInstancedPipeline);
      for (const m of instanced) {
        if (!m.vertexBuffer || !m.indexBuffer || !m.instanceBuffer) continue;
        const bindGroup = this.device.createBindGroup({
          layout: this.stencilInstancedBindLayout,
          entries: [
            { binding: 0, resource: { buffer: this.stencilUniformBuffer } },
            { binding: 1, resource: { buffer: m.instanceBuffer } },
          ],
        });
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, m.vertexBuffer);
        pass.setIndexBuffer(m.indexBuffer, 'uint32');
        pass.drawIndexed(m.indexCount, m.instanceCount, 0, 0, 0);
      }
    }

    // ── Pass B: fill quad where stencil bit 0 == 1 (cap region) ─────────
    pass.setPipeline(this.fillPipeline);
    pass.setBindGroup(0, this.fillBindGroup);
    pass.draw(3, 1, 0, 0);
  }

  private drawBatchedAndIndividual(pass: GPURenderPassEncoder, opts: SectionCapDrawOptions): void {
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
