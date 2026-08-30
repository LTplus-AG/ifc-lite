/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section 2D Overlay Renderer
 *
 * Renders 2D section drawings (cut polygons, outlines, hatching) as a 3D overlay
 * on the section plane in the WebGPU viewport. This provides an integrated view
 * where the architectural drawing appears directly on the section cut surface.
 *
 * SIZE (issue #2456): this module is deliberately over the ~400-line house rule.
 * Everything that could leave without dragging a GPU resource across a module
 * boundary has left — the WGSL to `shaders/section-2d-overlay.wgsl.ts`, the
 * 2D→3D lift and cap triangulation to `section-2d-lift.ts`, the per-family
 * vertex buffer to `section-2d-line-buffer.ts`. What is left is one nullable,
 * `init()`-created / `dispose()`-destroyed GPU object (two pipelines, one
 * bind-group layout, one bind group, one uniform buffer holding a 160-byte
 * record per draw site) plus the published API over it: one
 * `setLineOverlay`/`hasLineOverlay`/`drawLineOverlay` trio covering every
 * standalone line channel, and the section cut's own upload/draw. Splitting that
 * further means giving those shared resources a second owner, which is the cut
 * #2456 explicitly refuses. Do not "fix" the line count by doing it.
 */

import { PIPELINE_CONSTANTS } from './constants.js';
import {
  SECTION_2D_CAP_FILL_WGSL,
  SECTION_2D_OVERLAY_LINE_WGSL,
  SECTION_2D_UNIFORM_BYTES,
  SECTION_2D_UNIFORM_FLOATS,
  SECTION_2D_UNIFORM_SLOTS,
  SECTION_2D_UNIFORM_SLOT_COUNT,
  SECTION_2D_UNIFORM_SLOT_INDEX,
  sectionUniformSlotStride,
} from './shaders/section-2d-overlay.wgsl.js';
import {
  buildCapFillGeometry,
  buildDrawingOutlineVertices,
  createSectionLift,
  type CutPolygon2D,
  type DrawingLine2D,
  type SectionAxis,
  type SectionCustomPlane,
} from './section-2d-lift.js';
import {
  WorldLineBuffer,
  type SectionLinePipelineResources,
} from './section-2d-line-buffer.js';

export type { CutPolygon2D, DrawingLine2D, SectionCustomPlane } from './section-2d-lift.js';

/**
 * The standalone world-space line overlays, in draw order.
 *
 * Each channel is an independent vertex buffer sharing one line pipeline and one shared overlay
 * colour; only the buffer read and the uniform slot bound distinguish them — naming them makes a
 * fifth channel five table rows, not eight methods. Four of five refuse to compile if skipped;
 * the fifth, `SECTION_2D_UNIFORM_SLOT_COUNT`, derives from `SECTION_2D_UNIFORM_SLOT_INDEX`, so
 * the buffer follows it automatically (#3342 was a hand-written count, one short).
 *
 * Not enforced: each draw site binding its OWN slot. A test pins the index dense, but a channel
 * reusing an existing slot constant passes it while two sites overwrite each other's `lineColor`
 * (#2456).
 *
 * Clash box/contact lines are deliberately NOT a channel: they draw in their own colour via
 * `setClashOverlapBox` / `setClashContactLines`.
 */
export const LINE_OVERLAY_CHANNELS = ['annotation', 'alignment', 'grid', 'dxf'] as const;

/** One of {@link LINE_OVERLAY_CHANNELS}. */
export type LineOverlayChannel = (typeof LINE_OVERLAY_CHANNELS)[number];

export interface Section2DOverlayCapStyle {
  fillColor:         [number, number, number, number];
  strokeColor:       [number, number, number, number];
  patternId:         number;   // 0..7, matches HATCH_PATTERN_IDS in section-cap.ts
  spacingPx:         number;
  angleRad:          number;
  widthPx:           number;
  secondaryAngleRad: number;
}

export interface Section2DOverlayOptions {
  axis: 'down' | 'front' | 'side';  // Semantic axis: down (Y), front (Z), side (X)
  position: number; // 0-100 percentage
  bounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  viewProj: Float32Array;
  flipped?: boolean;
  min?: number;  // Optional override for min range
  max?: number;  // Optional override for max range
  /**
   * If provided, the 2D overlay's polygon fills render as the 3D section
   * cap with this screen-space hatch style. If omitted or `showFills` is
   * false, the filled hatch is skipped.
   */
  capStyle?: Section2DOverlayCapStyle;
  showFills?: boolean;
  /**
   * Whether to draw the polygon outline + hidden lines on the cap. Users
   * can turn surfaces and outlines on/off independently. Defaults to true
   * so existing call sites keep showing outlines.
   */
  showOutlines?: boolean;
}

export class Section2DOverlayRenderer {
  private device: GPUDevice;
  private fillPipeline: GPURenderPipeline | null = null;
  private linePipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  /** Byte stride between the uniform slots in {@link uniformBuffer}. Set by `init()`. */
  private uniformStride = 0;
  private format: GPUTextureFormat;
  private sampleCount: number;
  private initialized = false;

  // Colour for the standalone 3D overlay lines (annotation / alignment / grid)
  // and the section-cut outline, which share the line pipeline. Defaults to
  // opaque black for backwards compatibility; a consumer can theme it (e.g. light
  // lines on a dark canvas) via setOverlayLineColor().
  private overlayLineColor: readonly [number, number, number, number] = [0, 0, 0, 1];

  // Cached section-cut geometry buffers. Unlike the world-space overlays below
  // these ride the section plane and the fill half is indexed, so they are not
  // WorldLineBuffers.
  private fillVertexBuffer: GPUBuffer | null = null;
  private fillIndexBuffer: GPUBuffer | null = null;
  private fillIndexCount = 0;
  private lineVertexBuffer: GPUBuffer | null = null;
  private lineVertexCount = 0;

  /**
   * One world-space vertex buffer per {@link LineOverlayChannel}, each on its
   * own uniform slot.
   *
   * Four `WorldLineBuffer`s, not one: the four draws are encoded into a single
   * pass and `queue.writeBuffer` lands before the pass runs, so a shared buffer
   * or a shared uniform slot would give all four whatever the last write said.
   * Keying them by channel unifies the LOOKUP, which is all that was ever
   * duplicated; the buffers stay separate because their independence is what
   * makes annotation (#653), alignment, grid (#967) and DXF (#2043) visibility
   * toggle independently.
   */
  private readonly lineOverlays: Record<LineOverlayChannel, WorldLineBuffer> = {
    annotation: new WorldLineBuffer(SECTION_2D_UNIFORM_SLOT_INDEX.annotation),
    alignment: new WorldLineBuffer(SECTION_2D_UNIFORM_SLOT_INDEX.alignment),
    grid: new WorldLineBuffer(SECTION_2D_UNIFORM_SLOT_INDEX.grid),
    dxf: new WorldLineBuffer(SECTION_2D_UNIFORM_SLOT_INDEX.dxf),
  };

  // Standalone 3D clash-overlap-box overlay (#1277): the wireframe AABB of a
  // focused clash, drawn in its OWN distinct colour (not the shared overlay
  // line colour) so the overlap region reads as a third colour next to the two
  // glowing clash elements.
  private clashBoxLines = new WorldLineBuffer(SECTION_2D_UNIFORM_SLOT_INDEX.clashBox);
  private clashBoxLineColor: readonly [number, number, number, number] = [1, 0, 1, 1];

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount: number = 4) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
  }

  private init(): void {
    if (this.initialized) return;

    // Create bind group layout
    // `hasDynamicOffset`: one bind group serves every draw site, each reading
    // its own 160-byte slot at a per-draw offset. See
    // SECTION_2D_UNIFORM_SLOT_INDEX for why the slots exist at all.
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: SECTION_2D_UNIFORM_BYTES,
          },
        },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    const fillShader = this.device.createShaderModule({ code: SECTION_2D_CAP_FILL_WGSL });
    const lineShader = this.device.createShaderModule({ code: SECTION_2D_OVERLAY_LINE_WGSL });

    // Pipeline for filled polygons
    this.fillPipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: fillShader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 28, // 3 position + 4 color = 7 floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
              { shaderLocation: 1, offset: 12, format: 'float32x4' as const },
            ],
          },
        ],
      },
      fragment: {
        module: fillShader,
        entryPoint: 'fs_main',
        // The main render pass has two colour attachments (main colour +
        // picker objectId). Pipelines used inside that pass must declare
        // matching targets — the objectId slot writes nothing so the pass's
        // picking IDs underneath are preserved.
        targets: [
          {
            format: this.format,
            blend: {
              color: {
                srcFactor: 'src-alpha' as const,
                dstFactor: 'one-minus-src-alpha' as const,
                operation: 'add' as const,
              },
              alpha: {
                srcFactor: 'one' as const,
                dstFactor: 'one-minus-src-alpha' as const,
                operation: 'add' as const,
              },
            },
          },
          { format: 'rgba8unorm' as const, writeMask: 0 },
        ],
      },
      primitive: {
        topology: 'triangle-list' as const,
        cullMode: 'none' as const,
      },
      depthStencil: {
        format: PIPELINE_CONSTANTS.DEPTH_FORMAT,
        depthWriteEnabled: false,
        // 'greater-equal' (reverse-Z): draw the cap fill when its depth is at
        // least as close as whatever the main opaque pass already wrote. The
        // cap polygons live exactly on the section plane, which coincides
        // with below-plane top faces — 'greater-equal' lets them tie cleanly
        // there. Where nearer model geometry (e.g. a wall in front of the
        // cut, viewed at an angle) wrote a closer depth, the cap fails the
        // test and is occluded — the user no longer sees cap hatch painted
        // through model elements that ought to be in front of it.
        depthCompare: 'greater-equal' as const,
      },
      multisample: {
        count: this.sampleCount,
      },
    });

    // Pipeline for lines
    this.linePipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: lineShader,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 12, // 3 position floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' as const },
            ],
          },
        ],
      },
      fragment: {
        module: lineShader,
        entryPoint: 'fs_main',
        targets: [
          { format: this.format },
          { format: 'rgba8unorm' as const, writeMask: 0 },
        ],
      },
      primitive: {
        topology: 'line-list' as const,
        cullMode: 'none' as const,
      },
      depthStencil: {
        format: PIPELINE_CONSTANTS.DEPTH_FORMAT,
        depthWriteEnabled: false,
        // Same z-respect logic as the fill pipeline above — outline lines
        // are drawn on the cut plane, so closer model geometry should hide
        // them when the camera looks through it. The decal nudge for the
        // #812 coplanar case is applied in the line vertex shader (clip-z
        // offset) — WebGPU forbids depthStencil.depthBias on non-triangle
        // topologies.
        depthCompare: 'greater-equal' as const,
      },
      multisample: {
        count: this.sampleCount,
      },
    });

    // One 160-byte uniform buffer shared by BOTH pipelines: the fill fragment
    // shader reads up to params2 (144 B), the line shader reads
    // viewProj/planeOffset plus the appended lineColor at byte offset 144, so
    // they do not alias. Field offsets live in SECTION_2D_UNIFORM_SLOTS next to
    // the WGSL that defines them.
    // …once per draw site (SECTION_2D_UNIFORM_SLOT_COUNT of them), spaced by
    // the device's dynamic-offset alignment. Still one buffer under one owner;
    // what changed is that the six draws no longer overwrite each other.
    this.uniformStride = sectionUniformSlotStride(this.device);
    this.uniformBuffer = this.device.createBuffer({
      size: this.uniformStride * SECTION_2D_UNIFORM_SLOT_COUNT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group. `size` pins the binding to ONE record — without it
    // the binding would span the whole buffer and the dynamic offset would be
    // rejected for every slot but the first.
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer, offset: 0, size: SECTION_2D_UNIFORM_BYTES },
        },
      ],
    });

    this.initialized = true;
  }

  /**
   * The shared line-pipeline resources a WorldLineBuffer borrows for a draw.
   * Returns null before `init()` has produced them (or after `dispose()`), so
   * every line draw bails on the same condition it always did.
   */
  private lineResources(): SectionLinePipelineResources | null {
    if (!this.linePipeline || !this.uniformBuffer || !this.bindGroup) return null;
    return {
      device: this.device,
      pipeline: this.linePipeline,
      bindGroup: this.bindGroup,
      uniformBuffer: this.uniformBuffer,
      uniformStride: this.uniformStride,
    };
  }

  /**
   * Upload 2D drawing data to GPU buffers.
   *
   * For cardinal-axis section planes, pass `axis` + `planePosition` (+
   * `flipped`) and 2D points are lifted to 3D via the cardinal-axis
   * coordinate swap. For arbitrary face-picked planes (issue #243),
   * pass `customPlane = { origin, tangent, bitangent }` instead — the
   * 2D points are then lifted via `origin + tangent·x + bitangent·y`,
   * matching the basis the upstream `SectionCutter` used to project
   * the cut polygons in the first place. Without that the cap silhouette
   * would land off the actual cutting plane (the bug PR #581 hid by
   * suppressing the cap entirely for non-cardinal planes).
   */
  uploadDrawing(
    polygons: CutPolygon2D[],
    lines: DrawingLine2D[],
    axis: SectionAxis,
    planePosition: number,
    flipped: boolean = false,
    customPlane?: SectionCustomPlane,
  ): void {
    this.init();
    this.clearGeometry();

    const lift = createSectionLift(axis, planePosition, flipped, customPlane);

    const fill = buildCapFillGeometry(polygons, lift);
    if (fill) {
      this.fillVertexBuffer = this.device.createBuffer({
        size: fill.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.fillVertexBuffer, 0, fill.vertices);

      this.fillIndexBuffer = this.device.createBuffer({
        size: fill.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.fillIndexBuffer, 0, fill.indices);
      this.fillIndexCount = fill.indices.length;
    }

    const outline = buildDrawingOutlineVertices(polygons, lines, lift);
    if (outline) {
      this.lineVertexBuffer = this.device.createBuffer({
        size: outline.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.lineVertexBuffer, 0, outline);
      this.lineVertexCount = outline.length / 3;  // Each vertex is 3 floats
    }
  }

  /**
   * Clear uploaded geometry
   */
  clearGeometry(): void {
    if (this.fillVertexBuffer) {
      this.fillVertexBuffer.destroy();
      this.fillVertexBuffer = null;
    }
    if (this.fillIndexBuffer) {
      this.fillIndexBuffer.destroy();
      this.fillIndexBuffer = null;
    }
    if (this.lineVertexBuffer) {
      this.lineVertexBuffer.destroy();
      this.lineVertexBuffer = null;
    }
    this.fillIndexCount = 0;
    this.lineVertexCount = 0;
  }

  /**
   * Set the colour of the overlay lines (annotation / alignment / grid) and the
   * section-cut outline, which share the line pipeline. RGBA components are in
   * 0..1. Defaults to opaque black; set e.g. a light colour to keep the lines
   * legible on a dark canvas. Takes effect on the next draw.
   */
  setOverlayLineColor(color: readonly [number, number, number, number]): void {
    this.overlayLineColor = color;
  }

  /**
   * Set one standalone world-space line overlay, or clear it with `null`.
   *
   * `vertices` is a flat line-list, `[x1,y1,z1, x2,y2,z2, …]`, already in world
   * space: unlike the section-cut outline these do not ride the section plane,
   * so they draw regardless of `sectionPlane.enabled`. A short array clears too.
   *
   * Every channel gets its own buffer and its own uniform slot, so setting one
   * leaves the other three exactly as they were — that independence is the
   * whole point of having channels rather than one merged buffer.
   */
  setLineOverlay(channel: LineOverlayChannel, vertices: Float32Array | null): void {
    if (vertices === null) {
      // Deliberately no `init()`: clearing destroys a buffer that only an
      // upload could have created, so a clear before first use must not be
      // what brings the pipeline into existence.
      this.lineOverlays[channel].clear();
      return;
    }
    this.init();
    this.lineOverlays[channel].upload(this.device, vertices);
  }

  /** Whether `channel` currently holds at least one whole segment. */
  hasLineOverlay(channel: LineOverlayChannel): boolean {
    return this.lineOverlays[channel].has();
  }

  /**
   * Draw one channel with the shared line pipeline and the shared overlay
   * colour, binding that channel's own uniform slot. No-ops when the channel is
   * empty or the pipeline could not be built.
   */
  drawLineOverlay(
    pass: GPURenderPassEncoder,
    viewProj: Float32Array,
    channel: LineOverlayChannel,
  ): void {
    this.init();
    const resources = this.lineResources();
    if (!resources) return;
    this.lineOverlays[channel].draw(pass, resources, viewProj, this.overlayLineColor);
  }

  /** Colour for the clash-overlap box (its own, not the shared overlay colour). */
  setClashBoxLineColor(color: readonly [number, number, number, number]): void {
    this.clashBoxLineColor = color;
  }

  /**
   * Upload the clash-overlap-box wireframe as a flat `[x,y,z, …]` line-list in
   * world space (12 AABB edges = 24 vertices). Separate buffer + colour from the
   * other overlays. Pass an empty array to clear. (#1277)
   */
  uploadClashBoxLines3D(vertices: Float32Array): void {
    this.init();
    this.clashBoxLines.upload(this.device, vertices);
  }

  clearClashBoxLines3D(): void {
    this.clashBoxLines.clear();
  }

  hasClashBoxLines3D(): boolean {
    return this.clashBoxLines.has();
  }

  /** Draw the clash-overlap box in its own colour. Same line pipeline. (#1277) */
  drawClashBoxLines3D(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    this.init();
    const resources = this.lineResources();
    if (!resources) return;
    this.clashBoxLines.draw(pass, resources, viewProj, this.clashBoxLineColor);
  }

  /**
   * Check if there is geometry to draw
   */
  hasGeometry(): boolean {
    return this.fillIndexCount > 0 || this.lineVertexCount > 0;
  }

  /**
   * Draw the 2D overlay on the section plane
   */
  draw(
    pass: GPURenderPassEncoder,
    options: Section2DOverlayOptions
  ): void {
    this.init();

    if (!this.fillPipeline || !this.linePipeline || !this.uniformBuffer || !this.bindGroup) {
      return;
    }

    if (!this.hasGeometry()) {
      return;
    }

    const { viewProj } = options;

    // No offset — cap renders exactly on the section plane. The previous
    // 0.3m bias was there to keep the outline lines clear of below-plane
    // geometry, but it made the cap visually drift off the slider plane
    // (users could see a 0.3m gap between the plane preview and the cap).
    // The fill pipeline uses depthCompare 'greater-equal' (reverse-Z) so the
    // cap ties cleanly with coincident below-plane top faces and is occluded
    // by nearer model geometry — see the depthStencil comment on
    // `fillPipeline` above. There is no stencil test; the fill is restricted
    // to the actual cap polygons by the triangle-plane intersection geometry
    // `SectionCutter` produces, not by a stencil gate.
    const offset: [number, number, number] = [0, 0, 0];

    // Update uniforms. Field offsets come from SECTION_2D_UNIFORM_SLOTS, which
    // sits next to the WGSL struct it describes.
    const S = SECTION_2D_UNIFORM_SLOTS;
    const uniforms = new Float32Array(SECTION_2D_UNIFORM_FLOATS);
    uniforms.set(viewProj, S.viewProj);
    uniforms.set(this.overlayLineColor, S.lineColor); // section-cut outline colour
    uniforms[S.planeOffset + 0] = offset[0];
    uniforms[S.planeOffset + 1] = offset[1];
    uniforms[S.planeOffset + 2] = offset[2];
    uniforms[S.planeOffset + 3] = 0;
    const cs = options.capStyle;
    if (cs) {
      uniforms.set(cs.fillColor, S.capFillColor);
      uniforms.set(cs.strokeColor, S.capStrokeColor);
      uniforms[S.params + 0] = cs.patternId;
      uniforms[S.params + 1] = cs.spacingPx;
      uniforms[S.params + 2] = cs.angleRad;
      uniforms[S.params + 3] = cs.widthPx;
      uniforms[S.params2 + 0] = cs.secondaryAngleRad;
    } else {
      // Sensible defaults when caller omits style (e.g. legacy lines-only
      // use): solid fill using a warm-paper colour, no hatch.
      uniforms.set([0.92, 0.88, 0.78, 1], S.capFillColor);
      uniforms.set([0.10, 0.10, 0.10, 1], S.capStrokeColor);
      uniforms[S.params + 0] = 0; // solid pattern
      uniforms[S.params + 1] = 8;
      uniforms[S.params + 2] = Math.PI / 4;
      uniforms[S.params + 3] = 1;
      uniforms[S.params2 + 0] = -Math.PI / 4;
    }
    // The section cut owns slot 0. Both draws below read it, which is correct:
    // the fill and the outline are one drawing with one plane offset and one
    // style. What they must NOT share is the record the world-space line
    // families write, whose zeroed cap-style tail would otherwise arrive here.
    const capOffset = SECTION_2D_UNIFORM_SLOT_INDEX.sectionCut * this.uniformStride;
    this.device.queue.writeBuffer(this.uniformBuffer, capOffset, uniforms);

    // Filled polygons = the 3D section cap. Render them ONLY when the
    // caller opts in (`showFills: true` + a capStyle). This replaces the
    // old stencil-parity cap, which leaked hatch into empty sky on non-
    // manifold IFC geometry. The polygons here come from exact triangle-
    // plane intersection in `SectionCutter`, so the silhouette is
    // mathematically correct.
    if (
      options.showFills === true &&
      options.capStyle &&
      this.fillVertexBuffer &&
      this.fillIndexBuffer &&
      this.fillIndexCount > 0
    ) {
      pass.setPipeline(this.fillPipeline);
      pass.setBindGroup(0, this.bindGroup, [capOffset]);
      pass.setVertexBuffer(0, this.fillVertexBuffer);
      pass.setIndexBuffer(this.fillIndexBuffer, 'uint32');
      pass.drawIndexed(this.fillIndexCount);
    }

    // Outline lines on top of the fill. Gated by `showOutlines` so the
    // user can toggle surfaces and outlines independently from the UI.
    // Defaults to true when the caller omits the flag.
    if (
      options.showOutlines !== false &&
      this.lineVertexBuffer &&
      this.lineVertexCount > 0
    ) {
      pass.setPipeline(this.linePipeline);
      pass.setBindGroup(0, this.bindGroup, [capOffset]);
      pass.setVertexBuffer(0, this.lineVertexBuffer);
      pass.draw(this.lineVertexCount);
    }
  }

  /**
   * Dispose of GPU resources.
   *
   * Every family's buffer must be released here. The clash box (#1277) was the
   * sixth family added and was missing from this list, leaking its vertex
   * buffer on every teardown — `section-2d-overlay-lifecycle.test.ts` now counts
   * destroys against uploads so a seventh family cannot repeat it. The four
   * `LINE_OVERLAY_CHANNELS` are released by iterating the channel list, so a
   * fifth channel is covered here the moment it joins that list; the clash box
   * is named separately because it is not a channel.
   */
  dispose(): void {
    this.clearGeometry();
    for (const channel of LINE_OVERLAY_CHANNELS) this.lineOverlays[channel].clear();
    this.clearClashBoxLines3D();
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
  }
}
