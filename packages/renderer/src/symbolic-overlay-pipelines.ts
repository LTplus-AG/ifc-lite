/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU pipelines for IfcAnnotation overlays — filled regions and text
 * labels. Each pipeline is self-contained (owns its own buffers, bind groups,
 * pipeline state, optional atlas texture) and exposes a `render(pass,
 * viewProj)` entry point that the caller invokes from inside an existing
 * RGBA-blended render pass.
 *
 * Triangulation lives in `fill-triangulate.ts` and is shared with the section
 * cut caps: rings are nested by the even-odd rule, holes are bridged in, and
 * the result is ear-clipped.
 */

import { haloGlyphQuad, SymbolicTextAtlas } from './symbolic-text-atlas.js';
import {
  SYMBOLIC_FILL_WGSL,
  SYMBOLIC_TEXT_WGSL,
} from './shaders/symbolic-overlay.wgsl.js';
import { PIPELINE_CONSTANTS } from './constants.js';
import { tryPackRteDrawableDelta, type WorldPoint } from './relative-to-eye.js';
import { collectInstanceRuns, type InstanceRun } from './instanced-rte.js';
import { parseBoxAlignment, triangulateFillTo } from './symbolic-overlay-geometry.js';
export { parseBoxAlignment } from './symbolic-overlay-geometry.js';

const FILL_VERTEX_STRIDE_BYTES = (3 + 4) * 4; // pos.xyz + color.rgba, 4 bytes each
const TEXT_INSTANCE_FLOATS = 3 + 3 + 3 + 4 + 4 + 3 + 1 + 1 + 4 + 1;
const TEXT_INSTANCE_STRIDE_BYTES = TEXT_INSTANCE_FLOATS * 4;
const TEXT_RTE_DELTA_FLOATS = 8;
const TEXT_RTE_DELTA_STRIDE_BYTES = TEXT_RTE_DELTA_FLOATS * 4;
// Static glyph fields: origin, axes, UV/color, label anchor, cap height,
// billboard, glyph offset/size and target override (108 B/glyph). A separate
// dynamic RTE delta stream updates only 32 B/glyph per camera frame; low.w marks anchor-local legacy origins.
// Uniform: global viewProj (64 B) + RTE viewProj (64 B) + viewport/target
// (16 B) + camera basis (32 B) + f64 camera split (32 B) = 208 B. Keeping
// both projections is deliberate: a mixed legacy/anchored upload must keep
// legacy world-f32 labels on the original matrix while anchored labels use the
// eye-relative matrix selected by their instance record.
const TEXT_UNIFORM_BYTES = 208;
// Default target glyph cap height in physical pixels. Roughly matches a
// 13–14px body font at 1× DPR — readable at any zoom without dominating
// the model. Authored IFC text height is ignored in screen space, but the
// authored cap height still feeds the scale ratio so glyph metrics keep
// their relative proportions.
const DEFAULT_TEXT_TARGET_PX = 14;

// ─── Fill input ─────────────────────────────────────────────────────────────

export interface SymbolicFillInput {
  /** Flat ring buffer: [x, z, x, z, …]. Y is taken from `worldY`. */
  points: Float32Array;
  /** Vertex indices marking the start of each hole. Empty = no holes. */
  holesOffsets: Uint32Array;
  worldY: number;
  /** Opt-in f64 anchor. points/worldY are local to it; legacy inputs omit it. */
  origin?: [number, number, number];
  /** Straight-alpha RGBA in [0..1]. The shader premultiplies. */
  color: [number, number, number, number];
  /** Does this fill DEFINE the model's extent? Default true; see `uploadFills` (#3359). */
  definesExtent?: boolean;
}

// ─── Text input ─────────────────────────────────────────────────────────────

export interface SymbolicTextInput {
  worldPos: [number, number, number];
  /**
   * Opt-in canonical f64 label anchor. When supplied, `worldPos` is a small
   * local offset from this origin; legacy callers omit it and retain their
   * world-f32 projection path without a fabricated precision claim.
   */
  origin?: [number, number, number];
  /** Baseline direction (X axis in 3D world space). */
  dirX: number;
  dirZ: number;
  /** Glyph height in world units. */
  height: number;
  content: string;
  /** IFC BoxAlignment ("bottom-left", "center", "top-right", …). */
  alignment: string;
  color?: [number, number, number, number];
  /**
   * When true, the shader rebuilds the glyph quad in screen-aligned
   * (cameraRight, cameraUp) basis so the text always faces the camera.
   * Used for IfcGridAxis bubble tags — they must stay readable in
   * top-down/ground views where the authored world-Y up axis collapses.
   * Defaults to false (authored, in-plane text).
   */
  billboard?: boolean;
  /**
   * Per-instance target cap height in screen pixels. 0 / undefined falls
   * back to the renderer's global default (~14 px). Grid bubble fills +
   * outlines emit at ~32 px so the bubble stays proportional to the
   * inscribed tag at every zoom level — without this override they'd
   * collapse to the same screen size as the tag and the bubble would
   * disappear behind the character.
   */
  targetPx?: number;
  /** Does this label DEFINE the model's extent? Default true; see `uploadTexts` (#3359). */
  definesExtent?: boolean;
}

// ─── Fill pipeline ──────────────────────────────────────────────────────────

export class SymbolicFillPipeline {
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly sampleCount: number;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  /**
   * Each partition owns its uniform resource. Queue writes happen before the
   * encoded pass executes, so using one buffer for several partitions makes
   * every draw observe the final anchor written that frame.
   */
  private partitions: Array<{
    vertexBuffer: GPUBuffer; vertexCount: number; origin?: [number, number, number];
    uniformBuffer: GPUBuffer; bindGroup: GPUBindGroup;
  }> = [];

  constructor(device: GPUDevice, presentationFormat: GPUTextureFormat, sampleCount: number = 1) {
    this.device = device;
    this.format = presentationFormat;
    this.sampleCount = sampleCount;
  }

  private init(): void {
    if (this.pipeline) return;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'symbolic-fill-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const module = this.device.createShaderModule({
      label: 'symbolic-fill-shader',
      code: SYMBOLIC_FILL_WGSL,
    });

    this.pipeline = this.device.createRenderPipeline({
      label: 'symbolic-fill-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: FILL_VERTEX_STRIDE_BYTES,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },        // position
              { shaderLocation: 1, offset: 3 * 4, format: 'float32x4' },    // color
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        // The main render pass attaches 2 colour targets (presentation + the
        // picker objectId) and runs MSAA. Pipelines used inside that pass
        // must declare matching targets and sampleCount or WebGPU rejects
        // them at validation time. The objectId slot is write-masked off so
        // the picker IDs from the opaque pass underneath are preserved.
        targets: [
          {
            format: this.format,
            blend: {
              // Standard "one * src + (1 - src.a) * dst" composite — the
              // shader writes premultiplied alpha.
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
            writeMask: GPUColorWrite.ALL,
          },
          { format: 'rgba8unorm', writeMask: 0 },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: PIPELINE_CONSTANTS.DEPTH_FORMAT,
        depthWriteEnabled: false,
        // Reverse-Z: the renderer clears depth to 0.0 and uses 'greater' /
        // 'greater-equal' for everything in the main pass. 'less-equal'
        // would fail the test on every visible surface.
        depthCompare: 'greater-equal',
        // Decal bias: nudge fills slightly closer to camera so they don't
        // z-fight when coplanar with a wall/floor face (issue #812).
        // Reverse-Z → larger depth is closer → negative bias.
        depthBias: -4,
        depthBiasSlopeScale: -0.5,
        depthBiasClamp: 0,
      },
      multisample: { count: this.sampleCount },
    });

  }

  /**
   * Upload a list of fill regions. Each region is triangulated by the shared
   * even-odd triangulator (`fill-triangulate.ts`) into a single vertex buffer.
   *
   * Pass an empty array to clear. Rings with fewer than 3 vertices are
   * dropped, and so is any ring set that yields no triangle at all (a fully
   * collinear bound). Inner bounds themselves are never dropped: since #2516
   * the bridge always finds an anchor, so a hole cannot fall out of the
   * result the way it used to when it "couldn't be merged".
   */
  upload(fills: readonly SymbolicFillInput[]): void {
    this.init();

    // Drop the previous buffer eagerly so swapping models doesn't accumulate.
    for (const partition of this.partitions) {
      partition.vertexBuffer.destroy();
      partition.uniformBuffer.destroy();
    }
    this.partitions = [];

    if (fills.length === 0) return;

    const legacy: number[] = [];
    for (const fill of fills) {
      const stream: number[] = [];
      triangulateFillTo(stream, fill);
      if (fill.origin) this.addPartition(stream, fill.origin); else legacy.push(...stream);
    }
    this.addPartition(legacy);
  }

  hasGeometry(): boolean {
    return this.partitions.length > 0;
  }

  private addPartition(stream: number[], origin?: [number, number, number]): void {
    if (stream.length === 0 || !this.bindGroupLayout) return;
    const data = new Float32Array(stream);
    const vertexBuffer = this.device.createBuffer({ label: 'symbolic-fill-vbuf', size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(vertexBuffer, 0, data);
    const uniformBuffer = this.device.createBuffer({
      label: 'symbolic-fill-partition-camera', size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = this.device.createBindGroup({
      label: 'symbolic-fill-partition-bg', layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });
    this.partitions.push({
      vertexBuffer, vertexCount: data.length / (FILL_VERTEX_STRIDE_BYTES / 4), origin,
      uniformBuffer, bindGroup,
    });
  }

  render(pass: GPURenderPassEncoder, viewProj: Float32Array, rteViewProj?: Float32Array, camera?: readonly [number, number, number]): void {
    if (!this.pipeline) return;
    pass.setPipeline(this.pipeline);
    for (const partition of this.partitions) {
      const uniform = new Float32Array(40); uniform.set(viewProj);
      if (partition.origin && rteViewProj && camera) {
        uniform.set(rteViewProj, 16);
        // Outside this camera's RTE envelope: not rasterisable this frame (#6128).
        if (!tryPackRteDrawableDelta(partition.origin, camera, uniform, 32)) continue;
        uniform[35] = 1;
      }
      this.device.queue.writeBuffer(partition.uniformBuffer, 0, uniform);
      pass.setBindGroup(0, partition.bindGroup);
      pass.setVertexBuffer(0, partition.vertexBuffer); pass.draw(partition.vertexCount);
    }
  }

  destroy(): void {
    for (const partition of this.partitions) {
      partition.vertexBuffer.destroy();
      partition.uniformBuffer.destroy();
    }
    this.partitions = [];
    this.bindGroupLayout = null;
    this.pipeline = null;
  }
}

// ─── Text pipeline ──────────────────────────────────────────────────────────

export class SymbolicTextPipeline {
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly sampleCount: number;
  private readonly atlas: SymbolicTextAtlas;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private cornerBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private rteDeltaBuffer: GPUBuffer | null = null;
  private atlasTexture: GPUTexture | null = null;
  private atlasView: GPUTextureView | null = null;
  private sampler: GPUSampler | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private instanceCount = 0;
  /** CPU-side dynamic delta stream; never derived from f32 instance lanes. */
  private rteDeltaData: Float32Array | null = null;
  private instanceAnchors: Array<WorldPoint | null> = [];
  private uploadedAtlasVersion = -1;

  constructor(
    device: GPUDevice,
    presentationFormat: GPUTextureFormat,
    sampleCount: number = 1,
    atlas?: SymbolicTextAtlas,
  ) {
    this.device = device;
    this.format = presentationFormat;
    this.sampleCount = sampleCount;
    this.atlas = atlas ?? new SymbolicTextAtlas();
  }

  /** Expose the atlas so the upload pre-warms glyphs before instance encoding. */
  getAtlas(): SymbolicTextAtlas {
    return this.atlas;
  }

  private init(): void {
    if (this.pipeline) return;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'symbolic-text-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    const module = this.device.createShaderModule({
      label: 'symbolic-text-shader',
      code: SYMBOLIC_TEXT_WGSL,
    });

    this.pipeline = this.device.createRenderPipeline({
      label: 'symbolic-text-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          // Per-vertex: corner index 0..3 as a u32.
          {
            arrayStride: 4,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'uint32' }],
          },
          // Per-instance: origin + rightAxis + upAxis + uvBounds + color
          // + anchor + capHeight + billboard + glyphOffsetSize + targetPxOverride.
          {
            arrayStride: TEXT_INSTANCE_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1,  offset: 0,                                         format: 'float32x3' }, // origin
              { shaderLocation: 2,  offset: 3 * 4,                                     format: 'float32x3' }, // rightAxis
              { shaderLocation: 3,  offset: (3 + 3) * 4,                               format: 'float32x3' }, // upAxis
              { shaderLocation: 4,  offset: (3 + 3 + 3) * 4,                           format: 'float32x4' }, // uvBounds
              { shaderLocation: 5,  offset: (3 + 3 + 3 + 4) * 4,                       format: 'float32x4' }, // color
              { shaderLocation: 6,  offset: (3 + 3 + 3 + 4 + 4) * 4,                   format: 'float32x3' }, // anchor
              { shaderLocation: 7,  offset: (3 + 3 + 3 + 4 + 4 + 3) * 4,               format: 'float32'   }, // capHeight
              { shaderLocation: 8,  offset: (3 + 3 + 3 + 4 + 4 + 3 + 1) * 4,           format: 'float32'   }, // billboard
              { shaderLocation: 9,  offset: (3 + 3 + 3 + 4 + 4 + 3 + 1 + 1) * 4,       format: 'float32x4' }, // glyphOffsetSize
              { shaderLocation: 10, offset: (3 + 3 + 3 + 4 + 4 + 3 + 1 + 1 + 4) * 4,   format: 'float32'   }, // targetPxOverride
            ],
          },
          {
            // Per-frame f64-split drawable-minus-camera delta.
            arrayStride: TEXT_RTE_DELTA_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 11, offset: 0, format: 'float32x4' },
              { shaderLocation: 12, offset: 4 * 4, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        // Matches the main render pass attachments — see SymbolicFillPipeline
        // for the full reasoning.
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
            writeMask: GPUColorWrite.ALL,
          },
          { format: 'rgba8unorm', writeMask: 0 },
        ],
      },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      depthStencil: {
        format: PIPELINE_CONSTANTS.DEPTH_FORMAT,
        depthWriteEnabled: false,
        // Reverse-Z: see SymbolicFillPipeline.
        depthCompare: 'greater-equal',
        // Decal bias so text labels stay legible when sitting exactly on
        // a wall/floor face (issue #812). Reverse-Z → negative bias.
        depthBias: -4,
        depthBiasSlopeScale: -0.5,
        depthBiasClamp: 0,
      },
      multisample: { count: this.sampleCount },
    });

    // Per-vertex corner buffer: 4 corner indices for the triangle-strip quad.
    // Corner ordering matches the (u, v) decoder in the vertex shader:
    //   0 = BL, 1 = BR, 2 = TL, 3 = TR
    const corners = new Uint32Array([0, 1, 2, 3]);
    this.cornerBuffer = this.device.createBuffer({
      label: 'symbolic-text-corner',
      size: corners.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.cornerBuffer, 0, corners);

    this.uniformBuffer = this.device.createBuffer({
      label: 'symbolic-text-camera',
      size: TEXT_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.sampler = this.device.createSampler({
      label: 'symbolic-text-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      // Atlas glyphs are isolated; clamp keeps neighboring glyphs from
      // bleeding when minified.
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /** Re-upload the atlas to a GPUTexture when its version changes. */
  private syncAtlasTexture(): void {
    if (this.uploadedAtlasVersion === this.atlas.getVersion() && this.atlasTexture) return;

    if (this.atlasTexture) {
      this.atlasTexture.destroy();
      this.atlasTexture = null;
      this.atlasView = null;
    }
    this.atlasTexture = this.device.createTexture({
      label: 'symbolic-text-atlas',
      size: { width: this.atlas.atlasSize, height: this.atlas.atlasSize, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: this.atlas.canvas, flipY: false },
      { texture: this.atlasTexture },
      { width: this.atlas.atlasSize, height: this.atlas.atlasSize },
    );
    this.atlasView = this.atlasTexture.createView();
    this.uploadedAtlasVersion = this.atlas.getVersion();
    // Rebuild the bind group with the new texture view.
    this.bindGroup = null;
  }

  private ensureBindGroup(): void {
    if (this.bindGroup) return;
    if (!this.bindGroupLayout || !this.uniformBuffer || !this.atlasView || !this.sampler) return;
    this.bindGroup = this.device.createBindGroup({
      label: 'symbolic-text-bg',
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.atlasView },
        { binding: 2, resource: this.sampler },
      ],
    });
  }

  /**
   * Lay out the given text labels into the atlas, encode an instance buffer,
   * and upload to the GPU. Pass an empty array to clear.
   */
  upload(texts: readonly SymbolicTextInput[]): void {
    this.init();

    if (this.instanceBuffer) {
      this.instanceBuffer.destroy();
      this.instanceBuffer = null;
    }
    if (this.rteDeltaBuffer) {
      this.rteDeltaBuffer.destroy();
      this.rteDeltaBuffer = null;
    }
    this.instanceCount = 0;
    this.rteDeltaData = null;
    this.instanceAnchors = [];

    if (texts.length === 0) return;

    // Pass 1: rasterise any new glyphs into the atlas.
    const layouts: Array<{
      origin: [number, number, number];
      rightAxis: [number, number, number];
      upAxis: [number, number, number];
      uvBounds: [number, number, number, number];
      color: [number, number, number, number];
      anchor: [number, number, number];
      capHeight: number;
      billboard: number;
      // (offsetX, offsetY, width, height) in world units — only consumed by
      // the shader on the billboard branch. World units = atlas px × wScale.
      glyphOffsetSize: [number, number, number, number];
      // 0 → use renderer global default; otherwise override (in screen px).
      targetPxOverride: number;
      rteAnchor: WorldPoint | null;
    }> = [];

    for (const text of texts) {
      const layout = this.atlas.layoutString(text.content);
      if (layout.glyphs.length === 0) continue;

      const tint: [number, number, number, number] =
        text.color ?? [0.05, 0.05, 0.05, 1.0];

      // The IFC text direction (dirX, dirZ) is the baseline X axis in world
      // space. We want a 3D right-axis = baseline direction, up-axis = scene
      // up (0, 1, 0). The glyph is scaled by the world-height and the per-
      // glyph atlas-pixel size relative to the atlas-pixel cap height.
      const heightWorld = text.height;
      const heightAtlas = this.atlas.glyphPx;
      const dirLen = Math.hypot(text.dirX, text.dirZ) || 1;
      const ux = text.dirX / dirLen;
      const uz = text.dirZ / dirLen;

      // Alignment offsets in atlas pixels along the baseline + vertical axes.
      const align = parseBoxAlignment(text.alignment);
      const baselineOffset = align.vertical * this.atlas.glyphPx;
      const horizontalOffset = align.horizontal * layout.totalAdvancePx;

      // Detect "true visual center" alignment so a single-line label
      // anchors the GLYPH's geometric centre on the anchor (rather than
      // the atlas-slot midline — the canonical `parseBoxAlignment` output
      // assumes the slot height equals the visual glyph which is rarely
      // true for sans-serif digits and produces noticeable top-bias on
      // grid bubble tags).
      const isCenterH = align.horizontal === -0.5;
      const isCenterV = align.vertical === -0.5;

      // For horizontal centring across a multi-glyph label, the row's
      // visual width is (lastXOffset + lastGlyphWidth) - firstXOffset.
      // For a single-glyph label this collapses to the glyph's widthPx.
      let visualWidthPx = layout.totalAdvancePx;
      if (isCenterH && layout.glyphs.length > 0) {
        const first = layout.glyphs[0];
        const last = layout.glyphs[layout.glyphs.length - 1];
        const left = first.xOffsetPx;
        const right = last.xOffsetPx + last.glyph.widthPx;
        visualWidthPx = right - left;
      }

      for (const entry of layout.glyphs) {
        const glyph = entry.glyph;
        // Glyph quad's bottom-left in atlas pixels relative to the text
        // anchor.
        const px0 = isCenterH
          ? entry.xOffsetPx - visualWidthPx * 0.5
          : entry.xOffsetPx + horizontalOffset;
        const pyBottom = isCenterV
          ? -glyph.heightPx * 0.5
          : -baselineOffset - (glyph.heightPx - glyph.baselinePx);
        // Quad widened by the halo margin on every side (#5388).
        const { qx0, qyBottom, widthAtlas, heightGlyphAtlas, uvBounds } = haloGlyphQuad(glyph, px0, pyBottom, this.atlas.atlasSize);

        // Convert atlas-pixel local coords to world-space offsets:
        //   right axis in world = (ux, 0, uz) * (widthAtlas * heightWorld / heightAtlas)
        //   up axis    in world = (0, 1, 0)   * (heightGlyphAtlas * heightWorld / heightAtlas)
        const wScale = heightWorld / heightAtlas;
        const widthWorld = widthAtlas * wScale;
        const heightGlyphWorld = heightGlyphAtlas * wScale;

        // Bottom-left origin of the glyph quad in world space.
        const anchored = text.origin !== undefined;
        const ax = anchored ? text.origin![0] + text.worldPos[0] : text.worldPos[0];
        const ay = anchored ? text.origin![1] + text.worldPos[1] : text.worldPos[1];
        const az = anchored ? text.origin![2] + text.worldPos[2] : text.worldPos[2];
        const ox = anchored ? ux * qx0 * wScale : ax + ux * qx0 * wScale;
        const oy = anchored ? qyBottom * wScale : ay + qyBottom * wScale;
        const oz = anchored ? uz * qx0 * wScale : az + uz * qx0 * wScale;
        layouts.push({
          origin: [ox, oy, oz],
          rightAxis: [ux * widthWorld, 0, uz * widthWorld],
          upAxis: [0, heightGlyphWorld, 0],
          uvBounds,
          color: tint,
          // Shared per-label anchor (text.worldPos) lets the shader compute
          // one screen-space scale and apply it uniformly across all glyphs.
          // Retain a world-f32 anchor for the legacy projection. The dynamic
          // RTE draw rewrites the final two lanes from rteAnchor below.
          anchor: [ax, ay, az],
          capHeight: heightWorld,
          billboard: text.billboard ? 1.0 : 0.0,
          // Per-glyph offset + size in world units. The shader uses these
          // (via cameraRight/cameraUp) when billboard=1 so the glyph quad
          // tracks the screen instead of the floor plane.
          glyphOffsetSize: [
            qx0 * wScale,         // offsetX from anchor along baseline
            qyBottom * wScale,    // offsetY (ascender / descender / baseline)
            widthAtlas * wScale,  // glyph width
            heightGlyphAtlas * wScale, // glyph height
          ],
          targetPxOverride: text.targetPx ?? 0,
          rteAnchor: anchored ? [ax, ay, az] : null,
        });
      }
    }

    if (layouts.length === 0) return;

    // Pack into a Float32Array.
    const stride = TEXT_INSTANCE_FLOATS;
    const data = new Float32Array(layouts.length * stride);
    let off = 0;
    for (const l of layouts) {
      data[off + 0]  = l.origin[0];    data[off + 1]  = l.origin[1];    data[off + 2]  = l.origin[2];
      data[off + 3]  = l.rightAxis[0]; data[off + 4]  = l.rightAxis[1]; data[off + 5]  = l.rightAxis[2];
      data[off + 6]  = l.upAxis[0];    data[off + 7]  = l.upAxis[1];    data[off + 8]  = l.upAxis[2];
      data[off + 9]  = l.uvBounds[0];  data[off + 10] = l.uvBounds[1];
      data[off + 11] = l.uvBounds[2];  data[off + 12] = l.uvBounds[3];
      data[off + 13] = l.color[0];     data[off + 14] = l.color[1];
      data[off + 15] = l.color[2];     data[off + 16] = l.color[3];
      data[off + 17] = l.anchor[0];    data[off + 18] = l.anchor[1];    data[off + 19] = l.anchor[2];
      data[off + 20] = l.capHeight;
      data[off + 21] = l.billboard;
      data[off + 22] = l.glyphOffsetSize[0]; data[off + 23] = l.glyphOffsetSize[1];
      data[off + 24] = l.glyphOffsetSize[2]; data[off + 25] = l.glyphOffsetSize[3];
      data[off + 26] = l.targetPxOverride;
      this.instanceAnchors.push(l.rteAnchor);
      off += stride;
    }

    this.instanceBuffer = this.device.createBuffer({
      label: 'symbolic-text-instances',
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    this.rteDeltaData = new Float32Array(layouts.length * TEXT_RTE_DELTA_FLOATS);
    this.rteDeltaBuffer = this.device.createBuffer({
      label: 'symbolic-text-rte-deltas',
      size: this.rteDeltaData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.rteDeltaBuffer, 0, this.rteDeltaData);
    this.instanceCount = layouts.length;
  }

  /**
   * Pack each f64 anchor against this frame's camera via the shared RTE
   * contract, returning the runs of instances to draw. An anchor outside this
   * camera's eye envelope cannot be rasterised this frame and keeps a stale
   * delta, so it is left out of every run (#6128).
   */
  private updateRteInstanceDeltas(camera: WorldPoint | undefined): InstanceRun[] {
    if (!this.rteDeltaBuffer || !this.rteDeltaData || this.instanceAnchors.length === 0) {
      return [{ first: 0, count: this.instanceCount }];
    }
    const rteDeltaData = this.rteDeltaData;
    const runs = collectInstanceRuns(this.instanceAnchors.length, (index) => {
      const offset = index * TEXT_RTE_DELTA_FLOATS;
      const anchor = this.instanceAnchors[index];
      let drawable = true;
      if (anchor && camera) {
        drawable = tryPackRteDrawableDelta(anchor, camera, rteDeltaData, offset);
        if (drawable) rteDeltaData[offset + 3] = 1;
      } else {
        rteDeltaData.fill(0, offset, offset + TEXT_RTE_DELTA_FLOATS);
      }
      // Keep the anchor-local marker separate from high.w's RTE projection flag.
      if (anchor) rteDeltaData[offset + 7] = 1;
      return drawable;
    });
    this.device.queue.writeBuffer(this.rteDeltaBuffer, 0, this.rteDeltaData);
    return runs;
  }

  hasGeometry(): boolean { return this.instanceCount > 0; }

  render(
    pass: GPURenderPassEncoder,
    viewProj: Float32Array,
    viewportPxWidth: number,
    viewportPxHeight: number,
    cameraRight: readonly [number, number, number],
    cameraUp: readonly [number, number, number],
    targetGlyphPx: number = DEFAULT_TEXT_TARGET_PX,
    rteViewProj?: Float32Array,
    rteCamera?: readonly [number, number, number],
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.cornerBuffer || !this.instanceBuffer || !this.rteDeltaBuffer) return;
    if (this.instanceCount === 0) return;
    this.syncAtlasTexture();
    this.ensureBindGroup();
    if (!this.bindGroup) return;

    // Pack the uniform:
    //   [0..15]  legacy world-f32 viewProj
    //   [16..31] anchored RTE viewProj
    //   [32..35] (viewportW, viewportH, targetPx, pad)
    //   [36..39] cameraRight.xyz + pad
    //   [40..43] cameraUp.xyz + pad
    //   [44..47] camera high.xyz + pad
    //   [48..51] camera low.xyz + pad
    const uniformData = new Float32Array(TEXT_UNIFORM_BYTES / 4);
    uniformData.set(viewProj, 0);
    uniformData.set(rteViewProj ?? viewProj, 16);
    uniformData[32] = viewportPxWidth;
    uniformData[33] = viewportPxHeight;
    uniformData[34] = targetGlyphPx;
    uniformData[35] = 0;
    uniformData[36] = cameraRight[0];
    uniformData[37] = cameraRight[1];
    uniformData[38] = cameraRight[2];
    uniformData[39] = 0;
    uniformData[40] = cameraUp[0];
    uniformData[41] = cameraUp[1];
    uniformData[42] = cameraUp[2];
    uniformData[43] = 0;
    if (rteCamera) {
      for (let axis = 0; axis < 3; axis++) {
        const high = Math.fround(rteCamera[axis]);
        uniformData[44 + axis] = high;
        uniformData[48 + axis] = Math.fround(rteCamera[axis] - high);
      }
    }
    // RTE text consumes CPU-packed per-instance drawable deltas. Retain the
    // camera split slots above for the established 208-byte uniform ABI.
    const runs = this.updateRteInstanceDeltas(rteViewProj && rteCamera ? rteCamera : undefined);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.cornerBuffer);
    pass.setVertexBuffer(1, this.instanceBuffer);
    pass.setVertexBuffer(2, this.rteDeltaBuffer);
    for (const run of runs) pass.draw(4, run.count, 0, run.first);
  }

  destroy(): void {
    if (this.instanceBuffer) this.instanceBuffer.destroy();
    if (this.rteDeltaBuffer) this.rteDeltaBuffer.destroy();
    if (this.cornerBuffer) this.cornerBuffer.destroy();
    if (this.uniformBuffer) this.uniformBuffer.destroy();
    if (this.atlasTexture) this.atlasTexture.destroy();
    this.instanceBuffer = null;
    this.rteDeltaBuffer = null;
    this.rteDeltaData = null;
    this.instanceAnchors = [];
    this.cornerBuffer = null;
    this.uniformBuffer = null;
    this.atlasTexture = null;
    this.atlasView = null;
    this.sampler = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.pipeline = null;
    this.instanceCount = 0;
    this.uploadedAtlasVersion = -1;
  }
}
