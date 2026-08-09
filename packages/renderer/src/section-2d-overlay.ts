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
 * bind-group layout, one bind group, one shared 160-byte uniform buffer) plus
 * the published `upload*`/`clear*`/`has*`/`draw*` API over it. Splitting that
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

  // Standalone 3D annotation line overlay. Same line pipeline as the section
  // cut, but vertices are already in world space when uploaded so the draw
  // does not depend on a section plane being active. Used by the
  // "Show IFC Annotations" toggle so that authored 2D drawing curves
  // (IfcAnnotation polylines/arcs) are visible in any view.
  private annotationLines = new WorldLineBuffer();

  // Standalone 3D alignment centerline overlay. Independent buffer from the
  // annotation lines (separate visibility toggle) but reuses the same line
  // pipeline. IfcAlignment renders as a thin line here — not a ribbon mesh —
  // to match IfcGrid axes / IfcAnnotation curves.
  private alignmentLines = new WorldLineBuffer();

  // Standalone 3D structural-grid (IfcGridAxis) overlay. Independent buffer so
  // grid visibility is independent of the annotation/alignment overlays, but
  // reuses the same line pipeline (issue #967).
  private gridLines = new WorldLineBuffer();

  // Standalone 3D DXF reference-layer overlay (issue #2043, follow-up to
  // #1782/#1929's 2D-only DXF underlay). Independent buffer so 3D DXF
  // visibility is independent of the 2D underlay and the other overlays
  // above, but reuses the same line pipeline + shared overlay colour —
  // mirrors the grid overlay exactly. Line paths only (walls/boundaries);
  // DXF fills/text are not lifted to 3D in this iteration.
  private dxfLines = new WorldLineBuffer();

  // Standalone 3D clash-overlap-box overlay (#1277): the wireframe AABB of a
  // focused clash, drawn in its OWN distinct colour (not the shared overlay
  // line colour) so the overlap region reads as a third colour next to the two
  // glowing clash elements.
  private clashBoxLines = new WorldLineBuffer();
  private clashBoxLineColor: readonly [number, number, number, number] = [1, 0, 1, 1];

  constructor(device: GPUDevice, format: GPUTextureFormat, sampleCount: number = 4) {
    this.device = device;
    this.format = format;
    this.sampleCount = sampleCount;
  }

  private init(): void {
    if (this.initialized) return;

    // Create bind group layout
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
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
    this.uniformBuffer = this.device.createBuffer({
      size: SECTION_2D_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create bind group
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
      ],
    });

    this.initialized = true;
  }

  /**
   * The shared line-pipeline resources a WorldLineBuffer borrows for a draw.
   * Returns null before `init()` has produced them (or after `dispose()`), so
   * every `draw*Lines3D` bails on the same condition it always did.
   */
  private lineResources(): SectionLinePipelineResources | null {
    if (!this.linePipeline || !this.uniformBuffer || !this.bindGroup) return null;
    return {
      device: this.device,
      pipeline: this.linePipeline,
      bindGroup: this.bindGroup,
      uniformBuffer: this.uniformBuffer,
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
   * Upload a flat Float32Array of 3D line-list vertices for the standalone
   * annotation overlay. Each segment is `[x1, y1, z1, x2, y2, z2]` in world
   * space. The buffer is independent of the section cut's line buffer and
   * is drawn regardless of `sectionPlane.enabled`.
   *
   * Pass an empty array (or omit) to clear.
   */
  uploadAnnotationLines3D(vertices: Float32Array): void {
    this.init();
    this.annotationLines.upload(this.device, vertices);
  }

  clearAnnotationLines3D(): void {
    this.annotationLines.clear();
  }

  hasAnnotationLines3D(): boolean {
    return this.annotationLines.has();
  }

  /**
   * Draw the standalone annotation line overlay. Uses the same line pipeline
   * as the section cut outlines (vertex format: 3 floats per vertex, line-list
   * topology) but reads from a separate vertex buffer. The pipeline's
   * `planeOffset` uniform is zeroed so vertices render at their authored
   * world position.
   */
  drawAnnotationLines3D(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    this.init();
    const resources = this.lineResources();
    if (!resources) return;
    this.annotationLines.draw(pass, resources, viewProj, this.overlayLineColor);
  }

  /**
   * Upload a flat Float32Array of 3D line-list vertices for the alignment
   * centerline overlay. Same format/pipeline as the annotation lines, kept in
   * a separate buffer so alignment visibility is independent.
   * Pass an empty array (or omit) to clear.
   */
  uploadAlignmentLines3D(vertices: Float32Array): void {
    this.init();
    this.alignmentLines.upload(this.device, vertices);
  }

  clearAlignmentLines3D(): void {
    this.alignmentLines.clear();
  }

  hasAlignmentLines3D(): boolean {
    return this.alignmentLines.has();
  }

  /**
   * Draw the alignment centerline overlay. Identical pipeline/uniform setup as
   * `drawAnnotationLines3D`, reading from the separate alignment buffer.
   */
  drawAlignmentLines3D(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    this.init();
    const resources = this.lineResources();
    if (!resources) return;
    this.alignmentLines.draw(pass, resources, viewProj, this.overlayLineColor);
  }

  /**
   * Upload structural-grid (IfcGridAxis) segments as a flat
   * `[x,y,z, x,y,z, …]` line-list in world space (issue #967). Mirrors
   * `uploadAlignmentLines3D` with a separate buffer so grid visibility is
   * independent. Pass an empty array (or omit) to clear.
   */
  uploadGridLines3D(vertices: Float32Array): void {
    this.init();
    this.gridLines.upload(this.device, vertices);
  }

  clearGridLines3D(): void {
    this.gridLines.clear();
  }

  hasGridLines3D(): boolean {
    return this.gridLines.has();
  }

  /**
   * Draw the structural-grid overlay. Identical pipeline/uniform setup as
   * `drawAlignmentLines3D`, reading from the separate grid buffer.
   */
  drawGridLines3D(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    this.init();
    const resources = this.lineResources();
    if (!resources) return;
    this.gridLines.draw(pass, resources, viewProj, this.overlayLineColor);
  }

  /**
   * Upload the DXF reference-layer's line paths as a flat `[x,y,z, x,y,z, …]`
   * line-list in world space (issue #2043). Mirrors `uploadGridLines3D` with
   * a separate buffer so 3D DXF visibility is independent of the 2D
   * underlay and the other overlays above. Pass an empty array (or omit)
   * to clear.
   */
  uploadDxfLines3D(vertices: Float32Array): void {
    this.init();
    this.dxfLines.upload(this.device, vertices);
  }

  clearDxfLines3D(): void {
    this.dxfLines.clear();
  }

  hasDxfLines3D(): boolean {
    return this.dxfLines.has();
  }

  /**
   * Draw the 3D DXF reference-layer overlay. Identical pipeline/uniform
   * setup as `drawGridLines3D`, reading from the separate DXF buffer.
   */
  drawDxfLines3D(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    this.init();
    const resources = this.lineResources();
    if (!resources) return;
    this.dxfLines.draw(pass, resources, viewProj, this.overlayLineColor);
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
    // The fill pipeline uses depthCompare 'always' so z-fighting with
    // coincident below-plane top faces is not an issue; the stencil gate
    // keeps the fill restricted to the actual cap polygons.
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
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

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
      pass.setBindGroup(0, this.bindGroup);
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
      pass.setBindGroup(0, this.bindGroup);
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
   * destroys against uploads so a seventh family cannot repeat it.
   */
  dispose(): void {
    this.clearGeometry();
    this.clearAnnotationLines3D();
    this.clearAlignmentLines3D();
    this.clearGridLines3D();
    this.clearDxfLines3D();
    this.clearClashBoxLines3D();
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
  }
}
