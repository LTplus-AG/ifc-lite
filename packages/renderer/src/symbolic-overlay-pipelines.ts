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
 * Triangulation: simple ear-clipping for polygon-with-optional-holes,
 * inlined below to avoid adding a dependency. Good enough for typical IFC
 * fill regions (rooms, hatched zones) which are usually convex or near-convex.
 * Pathological concave shapes with many holes may show tessellation glitches —
 * an `earcut` upgrade is straightforward when it matters.
 */

import { SymbolicTextAtlas } from './symbolic-text-atlas.js';
import {
  SYMBOLIC_FILL_WGSL,
  SYMBOLIC_TEXT_WGSL,
} from './shaders/symbolic-overlay.wgsl.js';
import { PIPELINE_CONSTANTS } from './constants.js';

const FILL_VERTEX_STRIDE_BYTES = (3 + 4) * 4; // pos.xyz + color.rgba, 4 bytes each
const TEXT_INSTANCE_STRIDE_BYTES = (3 + 3 + 3 + 4 + 4 + 3 + 1) * 4;
// origin.xyz + rightAxis.xyz + upAxis.xyz + uvBounds.xyzw + color.rgba
// + anchor.xyz + capHeight (shared per text label, used by the shader to
//   compute a single screen-space scale for every glyph in the row).

// Uniform: 4x4 viewProj (64 B) + vec4 viewportAndTarget (16 B) = 80 B.
const TEXT_UNIFORM_BYTES = 80;
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
  /** Straight-alpha RGBA in [0..1]. The shader premultiplies. */
  color: [number, number, number, number];
}

// ─── Text input ─────────────────────────────────────────────────────────────

export interface SymbolicTextInput {
  worldPos: [number, number, number];
  /** Baseline direction (X axis in 3D world space). */
  dirX: number;
  dirZ: number;
  /** Glyph height in world units. */
  height: number;
  content: string;
  /** IFC BoxAlignment ("bottom-left", "center", "top-right", …). */
  alignment: string;
  color?: [number, number, number, number];
}

// ─── Fill pipeline ──────────────────────────────────────────────────────────

export class SymbolicFillPipeline {
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly sampleCount: number;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private vertexCount = 0;

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
      },
      multisample: { count: this.sampleCount },
    });

    this.uniformBuffer = this.device.createBuffer({
      label: 'symbolic-fill-camera',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroup = this.device.createBindGroup({
      label: 'symbolic-fill-bg',
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  /**
   * Upload a list of fill regions. Each region is triangulated (ear-clipping,
   * holes-aware) into a single shared vertex buffer.
   *
   * Pass an empty array to clear. Triangulation skips degenerate rings
   * (< 3 vertices) and silently drops any hole that can't be merged into the
   * outer ring (rare; usually overlapping rings in malformed IFC).
   */
  upload(fills: readonly SymbolicFillInput[]): void {
    this.init();

    // Drop the previous buffer eagerly so swapping models doesn't accumulate.
    if (this.vertexBuffer) {
      this.vertexBuffer.destroy();
      this.vertexBuffer = null;
    }
    this.vertexCount = 0;

    if (fills.length === 0) return;

    // Triangulate everything into one big flat vertex stream.
    const stream: number[] = [];
    for (const fill of fills) {
      triangulateFillTo(stream, fill);
    }
    if (stream.length === 0) return;

    const data = new Float32Array(stream);
    this.vertexBuffer = this.device.createBuffer({
      label: 'symbolic-fill-vbuf',
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, data);
    this.vertexCount = data.length / (FILL_VERTEX_STRIDE_BYTES / 4);
  }

  hasGeometry(): boolean {
    return this.vertexCount > 0;
  }

  render(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup || !this.vertexBuffer) return;
    if (this.vertexCount === 0) return;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(this.vertexCount);
  }

  destroy(): void {
    if (this.vertexBuffer) this.vertexBuffer.destroy();
    if (this.uniformBuffer) this.uniformBuffer.destroy();
    this.vertexBuffer = null;
    this.uniformBuffer = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.pipeline = null;
    this.vertexCount = 0;
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
  private atlasTexture: GPUTexture | null = null;
  private atlasView: GPUTextureView | null = null;
  private sampler: GPUSampler | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private instanceCount = 0;
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
          // + anchor + capHeight (last two drive screen-space scaling).
          {
            arrayStride: TEXT_INSTANCE_STRIDE_BYTES,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0,                             format: 'float32x3' }, // origin
              { shaderLocation: 2, offset: 3 * 4,                         format: 'float32x3' }, // rightAxis
              { shaderLocation: 3, offset: (3 + 3) * 4,                   format: 'float32x3' }, // upAxis
              { shaderLocation: 4, offset: (3 + 3 + 3) * 4,               format: 'float32x4' }, // uvBounds
              { shaderLocation: 5, offset: (3 + 3 + 3 + 4) * 4,           format: 'float32x4' }, // color
              { shaderLocation: 6, offset: (3 + 3 + 3 + 4 + 4) * 4,       format: 'float32x3' }, // anchor
              { shaderLocation: 7, offset: (3 + 3 + 3 + 4 + 4 + 3) * 4,   format: 'float32'   }, // capHeight
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
    this.instanceCount = 0;

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

      for (const entry of layout.glyphs) {
        const glyph = entry.glyph;
        // Glyph quad's bottom-left in atlas pixels relative to the text
        // anchor, before alignment.
        const px0 = entry.xOffsetPx + horizontalOffset;
        const pyBottom = -baselineOffset - (glyph.heightPx - glyph.baselinePx);
        const widthAtlas = glyph.widthPx;
        const heightGlyphAtlas = glyph.heightPx;

        // Convert atlas-pixel local coords to world-space offsets:
        //   right axis in world = (ux, 0, uz) * (widthAtlas * heightWorld / heightAtlas)
        //   up axis    in world = (0, 1, 0)   * (heightGlyphAtlas * heightWorld / heightAtlas)
        const wScale = heightWorld / heightAtlas;
        const widthWorld = widthAtlas * wScale;
        const heightGlyphWorld = heightGlyphAtlas * wScale;

        // Bottom-left origin of the glyph quad in world space.
        const ox = text.worldPos[0] + ux * px0 * wScale;
        const oy = text.worldPos[1] + pyBottom * wScale;
        const oz = text.worldPos[2] + uz * px0 * wScale;

        layouts.push({
          origin: [ox, oy, oz],
          rightAxis: [ux * widthWorld, 0, uz * widthWorld],
          upAxis: [0, heightGlyphWorld, 0],
          uvBounds: [glyph.u0, glyph.v0, glyph.u1, glyph.v1],
          color: tint,
          // Shared per-label anchor (text.worldPos) lets the shader compute
          // one screen-space scale and apply it uniformly across all glyphs.
          anchor: [text.worldPos[0], text.worldPos[1], text.worldPos[2]],
          capHeight: heightWorld,
        });
      }
    }

    if (layouts.length === 0) return;

    // Pack into a Float32Array.
    const stride = TEXT_INSTANCE_STRIDE_BYTES / 4;
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
      off += stride;
    }

    this.instanceBuffer = this.device.createBuffer({
      label: 'symbolic-text-instances',
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    this.instanceCount = layouts.length;
  }

  hasGeometry(): boolean {
    return this.instanceCount > 0;
  }

  render(
    pass: GPURenderPassEncoder,
    viewProj: Float32Array,
    viewportPxWidth: number,
    viewportPxHeight: number,
    targetGlyphPx: number = DEFAULT_TEXT_TARGET_PX,
  ): void {
    if (!this.pipeline || !this.uniformBuffer || !this.cornerBuffer || !this.instanceBuffer) return;
    if (this.instanceCount === 0) return;
    this.syncAtlasTexture();
    this.ensureBindGroup();
    if (!this.bindGroup) return;

    // Pack the uniform: 64 B viewProj + 16 B (viewportW, viewportH, targetPx, pad).
    const uniformData = new Float32Array(TEXT_UNIFORM_BYTES / 4);
    uniformData.set(viewProj, 0);
    uniformData[16] = viewportPxWidth;
    uniformData[17] = viewportPxHeight;
    uniformData[18] = targetGlyphPx;
    uniformData[19] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.cornerBuffer);
    pass.setVertexBuffer(1, this.instanceBuffer);
    pass.draw(4, this.instanceCount);
  }

  destroy(): void {
    if (this.instanceBuffer) this.instanceBuffer.destroy();
    if (this.cornerBuffer) this.cornerBuffer.destroy();
    if (this.uniformBuffer) this.uniformBuffer.destroy();
    if (this.atlasTexture) this.atlasTexture.destroy();
    this.instanceBuffer = null;
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * IFC BoxAlignment → normalized offsets in [-1, 0] for vertical and
 * horizontal axes. Returned offset is multiplied by the relevant span.
 *
 * Vertical:
 *   "top"     →  0   (no offset)
 *   "middle"  → -0.5
 *   "bottom"  → -1   (default per IFC)
 * Horizontal:
 *   "left"    →  0   (default per IFC)
 *   "center"  → -0.5
 *   "right"   → -1
 *
 * Unknown values fall back to ("bottom", "left"). Single-token values like
 * "center" are interpreted as { vertical: "middle", horizontal: "center" }.
 */
function parseBoxAlignment(s: string): { horizontal: number; vertical: number } {
  const norm = s.toLowerCase().trim();
  let horizontal = 0;
  let vertical = -1;

  if (norm === '') return { horizontal, vertical };

  if (norm.includes('top')) vertical = 0;
  else if (norm.includes('middle')) vertical = -0.5;
  else if (norm.includes('center') && !norm.includes('center-')) vertical = -0.5;
  else vertical = -1;

  if (norm.includes('right')) horizontal = -1;
  else if (norm.includes('center')) horizontal = -0.5;
  else horizontal = 0;

  return { horizontal, vertical };
}

/**
 * Triangulate a polygon-with-holes via ear-clipping. Each output triangle is
 * appended to `stream` as 3 × (x, y, z, r, g, b, a) entries (matching the
 * fill pipeline's vertex layout). Holes that fully enclose nothing or have
 * < 3 valid vertices are silently dropped.
 *
 * Ear-clipping is O(n²) which is fine for fill regions (typically < 100
 * vertices). For pathological inputs we'd want earcut proper, but adding the
 * npm dependency for marginal gain isn't worth it.
 */
function triangulateFillTo(stream: number[], fill: SymbolicFillInput): void {
  const { points, holesOffsets, worldY, color } = fill;
  if (points.length < 6) return;

  // Convert the flat ring buffer into rings of {x, z} (Y is constant).
  const totalVerts = points.length / 2;
  const ringStarts: number[] = [0, ...Array.from(holesOffsets), totalVerts];
  if (ringStarts.length < 2) return;

  // Pull each ring's vertices out.
  const rings: Array<Array<{ x: number; z: number }>> = [];
  for (let r = 0; r < ringStarts.length - 1; r++) {
    const start = ringStarts[r];
    const end = ringStarts[r + 1];
    if (end - start < 3) continue;
    const ring: Array<{ x: number; z: number }> = [];
    for (let v = start; v < end; v++) {
      ring.push({ x: points[v * 2], z: points[v * 2 + 1] });
    }
    rings.push(ring);
  }
  if (rings.length === 0) return;

  // Stitch each hole into the outer ring with a bridge edge from the hole's
  // rightmost vertex to the nearest outer-ring vertex (the same approach
  // earcut.js takes for polygon-with-holes input). Ear-clipping then runs on
  // the resulting simple polygon. The hole's winding is reversed first so the
  // combined ring's signed area stays consistent and the ear-test sign holds.
  const outer = rings[0];
  const holes = rings.slice(1);
  const stitched = holes.length === 0 ? outer : joinHoles(outer, holes);
  const triangles = earClip(stitched);
  for (const tri of triangles) {
    for (const idx of tri) {
      const v = stitched[idx];
      stream.push(v.x, worldY, v.z, color[0], color[1], color[2], color[3]);
    }
  }
}

/**
 * Stitch each hole into the outer ring with a single bridge edge so the
 * result is a simple polygon ear-clipping can handle. Mirrors mapbox/earcut's
 * `eliminateHoles` pass:
 *
 *   1. For each hole, pick its rightmost (max-x) vertex as the bridge start.
 *   2. Sort holes by descending bridge-start x so outer holes go in first.
 *   3. Walk the outer ring for the vertex on the right side of the bridge
 *      that's "visible" from the hole — closest match wins.
 *   4. Splice the hole (rotated to start at its bridge vertex, and reversed
 *      so its winding opposes the outer ring) into the outer ring at the
 *      anchor, closing both ends back to their starts to form a zero-area
 *      bridge edge.
 *
 * This breaks under pathological inputs (overlapping holes, holes outside
 * the outer ring) but those don't occur in well-formed `IfcAnnotationFillArea`
 * geometry — the IFC schema requires the outer bound to contain all inner
 * bounds.
 */
type Pt = { x: number; z: number };
function joinHoles(outer: Pt[], holes: Pt[][]): Pt[] {
  if (holes.length === 0) return outer;

  type HoleEntry = { ring: Pt[]; startIdx: number; startX: number; startZ: number };
  const sorted: HoleEntry[] = holes
    .map((h) => {
      let bestI = 0;
      for (let i = 1; i < h.length; i++) {
        if (h[i].x > h[bestI].x) bestI = i;
      }
      return { ring: h, startIdx: bestI, startX: h[bestI].x, startZ: h[bestI].z };
    })
    .sort((a, b) => b.startX - a.startX);

  let result: Pt[] = outer.slice();

  for (const { ring, startIdx, startX, startZ } of sorted) {
    // Find the outer-ring index with the smallest distance to the bridge
    // start, preferring vertices to the right (x > startX). When nothing is
    // to the right (hole touches the outer ring's right edge), fall back to
    // global nearest.
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < result.length; i++) {
      const p = result[i];
      if (p.x <= startX) continue;
      const d = (p.x - startX) * (p.x - startX) + (p.z - startZ) * (p.z - startZ);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) {
      for (let i = 0; i < result.length; i++) {
        const p = result[i];
        const d = (p.x - startX) * (p.x - startX) + (p.z - startZ) * (p.z - startZ);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0) continue;

    // Hole reversed so its winding opposes outer (outer is CCW after earClip
    // normalisation; holes should be CW for the combined ring's area to come
    // out right). Rotate to start at the bridge vertex.
    const reversed = ring.slice().reverse();
    const reversedStartIdx = ring.length - 1 - startIdx;
    const rotated = [
      ...reversed.slice(reversedStartIdx),
      ...reversed.slice(0, reversedStartIdx),
    ];

    result = [
      ...result.slice(0, bestIdx + 1),
      ...rotated,
      rotated[0],
      result[bestIdx],
      ...result.slice(bestIdx + 1),
    ];
  }

  return result;
}

/** Ear-clipping triangulation of a simple polygon. Returns triangle vertex indices. */
function earClip(ring: ReadonlyArray<{ x: number; z: number }>): number[][] {
  const n = ring.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  // Working list of indices.
  const indices: number[] = [];
  // Determine winding: positive shoelace = CCW; otherwise reverse so the
  // ear-test below uses a consistent sign.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    area += (a.x * b.z) - (b.x * a.z);
  }
  const ccw = area > 0;
  for (let i = 0; i < n; i++) {
    indices.push(ccw ? i : n - 1 - i);
  }

  const triangles: number[][] = [];
  let safety = indices.length * indices.length;

  while (indices.length > 3 && safety-- > 0) {
    let found = false;
    for (let i = 0; i < indices.length; i++) {
      const ia = indices[(i + indices.length - 1) % indices.length];
      const ib = indices[i];
      const ic = indices[(i + 1) % indices.length];
      const a = ring[ia];
      const b = ring[ib];
      const c = ring[ic];

      // Convex check (cross product of (b-a) × (c-b) > 0 for CCW).
      const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      if (cross <= 0) continue;

      // No other vertex inside triangle (a, b, c).
      let containsOther = false;
      for (let j = 0; j < indices.length; j++) {
        const ij = indices[j];
        if (ij === ia || ij === ib || ij === ic) continue;
        if (pointInTriangle(ring[ij], a, b, c)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;

      triangles.push([ia, ib, ic]);
      indices.splice(i, 1);
      found = true;
      break;
    }
    if (!found) break; // degenerate polygon — emit what we have
  }

  if (indices.length === 3) {
    triangles.push([indices[0], indices[1], indices[2]]);
  }
  return triangles;
}

function pointInTriangle(
  p: { x: number; z: number },
  a: { x: number; z: number },
  b: { x: number; z: number },
  c: { x: number; z: number },
): boolean {
  const s1 = sign(p, a, b);
  const s2 = sign(p, b, c);
  const s3 = sign(p, c, a);
  const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
  const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
  return !(hasNeg && hasPos);
}

function sign(
  p1: { x: number; z: number },
  p2: { x: number; z: number },
  p3: { x: number; z: number },
): number {
  return (p1.x - p3.x) * (p2.z - p3.z) - (p2.x - p3.x) * (p1.z - p3.z);
}
