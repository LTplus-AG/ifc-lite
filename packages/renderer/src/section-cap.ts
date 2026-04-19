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
  /**
   * Axis-aligned world-space bounds of the scene. Used to pin the cap fill to
   * a bounded plane quad instead of a full-screen triangle, so stray stencil
   * bits from non-manifold IFC geometry cannot paint hatch into empty sky
   * above or beside the model.
   */
  boundsMin:    [number, number, number];
  boundsMax:    [number, number, number];
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
// Cap-fill uniforms:
//   viewProj (64) + 4 * vec4 corners (64) +
//   fillColor (16) + strokeColor (16) + params (16) + params2 (16) = 192 B.
const FILL_UNIFORM_BYTES = 192;

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
  private fillScratch = new Float32Array(FILL_UNIFORM_BYTES / 4);  // 48 floats

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

    // WebGPU requires a pipeline's fragment targets to match the render
    // pass's colour attachments exactly — both in count and format — even
    // when the fragment shader doesn't write anything. The main render pass
    // has two colour attachments (main colour + objectId), so the stencil
    // pipelines must declare both with writeMask 0 so nothing is written.
    // This is the fix for "Incompatible color attachments at indices []:
    // the RenderPass uses textures with formats [Bgra8Unorm, Rgba8Unorm]
    // but the RenderPipeline with 'section-cap-parity' label uses attachments
    // with formats []".
    const noWriteColorTargets: GPUColorTargetState[] = [
      { format: colorFormat, writeMask: 0 },
      { format: 'rgba8unorm', writeMask: 0 },
    ];

    const stencilBase = {
      layout: stencilLayout,
      vertex:   { module: stencilShader, entryPoint: 'vs_main', buffers: vertexBuffers },
      // Match the main render pass colour attachments but write nothing —
      // only the stencil op runs.
      fragment: { module: stencilShader, entryPoint: 'fs_main', targets: noWriteColorTargets },
      primitive: { topology: 'triangle-list' as const },
      multisample: { count: sampleCount },
    };

    const parityStencil = {
      format: depthFormat,
      // Depth-test (reverse-Z: 'greater' means "closer to camera passes")
      // against the main pass's depth buffer, so only triangles BETWEEN the
      // camera and the nearest opaque below-plane surface contribute to
      // parity. Without this, above-plane triangles hidden behind a nearer
      // wall still flipped bit 0, producing cap hatch that bled through
      // onto distant/occluding geometry and floating "sideways" pattern
      // artefacts in empty sky above the cut. Depth-writing stays OFF so
      // the cap pass doesn't disturb the depth buffer that transparent and
      // selection passes sample next.
      depthCompare: 'greater' as const,
      depthWriteEnabled: false,
      // depthFailOp MUST stay 'keep' — only stencil-passing fragments that
      // also win the depth test contribute to parity, hidden-behind-wall
      // triangles are excluded entirely.
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
      // Must match the render pass's colour attachments — see comment above
      // on `noWriteColorTargets`.
      fragment: { module: stencilInstancedShader, entryPoint: 'fs_main', targets: noWriteColorTargets },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: parityStencil,
      multisample: { count: sampleCount },
    });

    // ─── Cap fill pipeline ──────────────────────────────────────────────
    const fillShader = device.createShaderModule({
      code: capFillShaderSource,
      label: 'section-cap-fill',
    });

    // Visibility MUST include VERTEX because the fill vertex shader now reads
    // cap.viewProj + quadP0..3 to position the world-space plane quad. With
    // FRAGMENT only, WebGPU rejects the pipeline layout — that validation
    // error cascades into the whole main render pass being dropped every
    // frame, which appeared as "model doesn't cut, orbit jitters".
    const fillBindLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
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
        // Target 0 (main colour) gets the cap paint with alpha blending.
        // Target 1 (objectId) must be declared to match the render pass's
        // attachment count, but we mask writes so cap pixels don't clobber
        // the picking IDs underneath.
        targets: [
          {
            format: colorFormat,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha' },
            },
          },
          { format: 'rgba8unorm', writeMask: 0 },
        ],
      },
      // cullMode 'none' — we don't want the fill to depend on which side of
      // the plane the camera is viewing from (down/up, front/back).
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: depthFormat,
        // depthCompare 'always': the quad lies exactly on the clip plane,
        // which coincides with the top faces of below-plane geometry. A
        // strict 'greater' depth test fails at those pixels because the
        // quad depth equals the stored depth, leaving visible pin-holes
        // in the cap. The world-space quad already restricts screen
        // coverage to the plane's projection, and stencil bit 0 gates
        // the cap region inside that footprint, so ignoring depth here
        // is safe — spurious parity bits outside the quad's screen area
        // produce no fragments in the first place.
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

    // ── Compute world-space plane quad corners ─────────────────────────
    // Build an orthonormal basis (u, v) on the plane, project the bounding
    // box corners into that basis, and take a quad spanning the projected
    // extent. This keeps every emitted vertex exactly on the plane
    // dot(p, n) = d — the previous "set the dominant axis directly"
    // shortcut drifted off the plane for rotated building normals.
    const n = opts.planeNormal;
    const bMin = opts.boundsMin;
    const bMax = opts.boundsMax;
    const nLenSq = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
    if (nLenSq < 1e-12) {
        // Degenerate normal — skip cap rather than draw garbage.
        return;
    }

    // Anchor the plane at the bounds centre projected onto the plane, so the
    // quad is centred over the model rather than wandering off with the
    // building origin.
    const cx = (bMin[0] + bMax[0]) * 0.5;
    const cy = (bMin[1] + bMax[1]) * 0.5;
    const cz = (bMin[2] + bMax[2]) * 0.5;
    const toPlane = (opts.planeDistance - (cx * n[0] + cy * n[1] + cz * n[2])) / nLenSq;
    const ox = cx + n[0] * toPlane;
    const oy = cy + n[1] * toPlane;
    const oz = cz + n[2] * toPlane;

    // Pick a helper axis that's not parallel to n (favour world Y unless n
    // points mostly along Y, in which case use world X). Cross with n to get
    // the first in-plane direction u, then v = n × u gives the second.
    const nyAbs = Math.abs(n[1]);
    const hx = nyAbs < 0.9 ? 0 : 1;
    const hy = nyAbs < 0.9 ? 1 : 0;
    const hz = 0;
    // u = h × n
    let ux = hy * n[2] - hz * n[1];
    let uy = hz * n[0] - hx * n[2];
    let uz = hx * n[1] - hy * n[0];
    const uLen = Math.hypot(ux, uy, uz);
    ux /= uLen; uy /= uLen; uz /= uLen;
    // v = n × u  (already unit because n and u are both unit and orthogonal,
    // but normalise defensively in case n isn't unit-length).
    let vx = n[1] * uz - n[2] * uy;
    let vy = n[2] * ux - n[0] * uz;
    let vz = n[0] * uy - n[1] * ux;
    const vLen = Math.hypot(vx, vy, vz);
    vx /= vLen; vy /= vLen; vz /= vLen;

    // Project the 8 AABB corners onto (u, v) relative to the anchor and take
    // the extent. 1% margin so the hatch reaches the silhouette edge cleanly.
    const margin = 0.01;
    let uMin = Infinity, uMax = -Infinity;
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < 8; i++) {
        const x = (i & 1) ? bMax[0] : bMin[0];
        const y = (i & 2) ? bMax[1] : bMin[1];
        const z = (i & 4) ? bMax[2] : bMin[2];
        const rx = x - ox, ry = y - oy, rz = z - oz;
        const up = rx * ux + ry * uy + rz * uz;
        const vp = rx * vx + ry * vy + rz * vz;
        if (up < uMin) uMin = up; if (up > uMax) uMax = up;
        if (vp < vMin) vMin = vp; if (vp > vMax) vMax = vp;
    }
    const uPad = (uMax - uMin) * margin;
    const vPad = (vMax - vMin) * margin;
    uMin -= uPad; uMax += uPad;
    vMin -= vPad; vMax += vPad;

    const p0x = ox + ux * uMin + vx * vMin, p0y = oy + uy * uMin + vy * vMin, p0z = oz + uz * uMin + vz * vMin;
    const p1x = ox + ux * uMax + vx * vMin, p1y = oy + uy * uMax + vy * vMin, p1z = oz + uz * uMax + vz * vMin;
    const p2x = ox + ux * uMax + vx * vMax, p2y = oy + uy * uMax + vy * vMax, p2z = oz + uz * uMax + vz * vMax;
    const p3x = ox + ux * uMin + vx * vMax, p3y = oy + uy * uMin + vy * vMax, p3z = oz + uz * uMin + vz * vMax;

    // ── Write cap-fill uniforms ─────────────────────────────────────────
    // Layout (matches CapUniforms in section-cap.wgsl.ts):
    //   0-15   viewProj (mat4x4)
    //   16-19  quadP0 (vec4)
    //   20-23  quadP1
    //   24-27  quadP2
    //   28-31  quadP3
    //   32-35  fillColor
    //   36-39  strokeColor
    //   40-43  params
    //   44-47  params2
    const s = opts.style;
    this.fillScratch.set(opts.viewProj, 0);
    this.fillScratch[16] = p0x; this.fillScratch[17] = p0y; this.fillScratch[18] = p0z; this.fillScratch[19] = 0;
    this.fillScratch[20] = p1x; this.fillScratch[21] = p1y; this.fillScratch[22] = p1z; this.fillScratch[23] = 0;
    this.fillScratch[24] = p2x; this.fillScratch[25] = p2y; this.fillScratch[26] = p2z; this.fillScratch[27] = 0;
    this.fillScratch[28] = p3x; this.fillScratch[29] = p3y; this.fillScratch[30] = p3z; this.fillScratch[31] = 0;
    this.fillScratch[32] = s.fillColor[0];
    this.fillScratch[33] = s.fillColor[1];
    this.fillScratch[34] = s.fillColor[2];
    this.fillScratch[35] = s.fillColor[3];
    this.fillScratch[36] = s.strokeColor[0];
    this.fillScratch[37] = s.strokeColor[1];
    this.fillScratch[38] = s.strokeColor[2];
    this.fillScratch[39] = s.strokeColor[3];
    this.fillScratch[40] = HATCH_PATTERN_IDS[s.pattern];
    this.fillScratch[41] = s.spacingPx;
    this.fillScratch[42] = s.angleRad;
    this.fillScratch[43] = s.widthPx;
    this.fillScratch[44] = s.secondaryAngleRad;
    this.fillScratch[45] = 0;
    this.fillScratch[46] = 0;
    this.fillScratch[47] = 0;
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
    // Two triangles (6 indices) covering the plane quad. The vertex shader
    // indexes quadP0..3 via @builtin(vertex_index) so no vertex buffer is
    // bound. Depth test + stencil test together restrict output to the
    // visible cap region.
    pass.setPipeline(this.fillPipeline);
    pass.setBindGroup(0, this.fillBindGroup);
    pass.draw(6, 1, 0, 0);
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
