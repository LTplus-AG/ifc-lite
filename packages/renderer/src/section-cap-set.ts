/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The section cut caps (#7545): one per cutting plane.
 *
 * `Section2DOverlayRenderer` used to hold exactly one cap's vertex and index
 * buffers and draw it; with several cutting planes there is one cap per plane,
 * each lying on its own plane and each removed where ANOTHER plane cuts it away.
 * This holds the cap geometry and the draw, and borrows every shared GPU
 * resource (pipelines, the uniform buffer, the bind groups) per draw, exactly as
 * `WorldLineBuffer` does, so `Section2DOverlayRenderer` stays the single owner
 * of what it creates in `init()` and destroys in `dispose()` (issue #2456).
 *
 * The primary plane's cap keeps the section-cut uniform slot it always had; each
 * extra plane's cap has a slot of its own (`SECTION_2D_UNIFORM_SLOT_INDEX.extraCap`
 * and up). Alongside each cap's uniform goes the block of planes that clip it
 * (`extra-clip-planes.ts`): every other cutting plane, never its own.
 */

import { packExtraClip, EXTRA_CLIP_FLOATS } from './extra-clip-planes.js';
import type { ExtraClipPlane } from './clip-types.js';
import { tryPackRteDrawableDelta } from './relative-to-eye.js';
import {
  SECTION_2D_MAX_EXTRA_CAPS,
  SECTION_2D_UNIFORM_FLOATS,
  SECTION_2D_UNIFORM_SLOTS,
  SECTION_2D_UNIFORM_SLOT_INDEX,
} from './shaders/section-2d-overlay.wgsl.js';
import {
  buildCapFillGeometry,
  buildDrawingOutlineVertices,
  createSectionLift,
  recolorCapVertices,
  type CapHighlight,
  type CapPolygonRange,
  type CutPolygon2D,
  type DrawingLine2D,
  type SectionAxis,
  type SectionCustomPlane,
} from './section-2d-lift.js';
import type { Section2DOverlayOptions } from './section-2d-types.js';

/** What a cap draw borrows from `Section2DOverlayRenderer` for the duration of one frame. */
export interface CapDrawResources {
  device: GPUDevice;
  fillPipeline: GPURenderPipeline;
  fillDepthPipeline: GPURenderPipeline;
  /** The outline pipeline that clips like the fill (not the shared world-line pipeline). */
  outlinePipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  uniformBuffer: GPUBuffer;
  uniformStride: number;
  /** Group 1: one extra-clip block per cap, addressed by dynamic offset. */
  clipBindGroup: GPUBindGroup;
  clipBuffer: GPUBuffer;
  clipStride: number;
  lineColor: readonly [number, number, number, number];
}

/** One cap's GPU geometry: the filled polygons and their outline. */
class CapGeometry {
  fillVertexBuffer: GPUBuffer | null = null;
  fillIndexBuffer: GPUBuffer | null = null;
  fillIndexCount = 0;
  lineVertexBuffer: GPUBuffer | null = null;
  lineVertexCount = 0;
  /** f64 cap anchor retained separately from the local cap vertices. */
  anchor: [number, number, number] | null = null;
  /** The fill vertices as built (before any highlight) and each polygon's slice of them. */
  private fillSource: Float32Array | null = null;
  private fillRanges: CapPolygonRange[] = [];
  /** The highlight last written to {@link fillVertexBuffer}; compared by content. */
  private appliedHighlight: CapHighlight | null = null;

  has(): boolean {
    return this.fillIndexCount > 0 || this.lineVertexCount > 0;
  }

  clear(): void {
    this.fillVertexBuffer?.destroy();
    this.fillIndexBuffer?.destroy();
    this.lineVertexBuffer?.destroy();
    this.fillVertexBuffer = null;
    this.fillIndexBuffer = null;
    this.lineVertexBuffer = null;
    this.fillIndexCount = 0;
    this.lineVertexCount = 0;
    this.anchor = null;
    this.fillSource = null;
    this.fillRanges = [];
    this.appliedHighlight = null;
  }

  /**
   * Paint the highlighted elements' polygons in their colour (`null` restores the
   * cap as built). Rewrites the vertex buffer only when the highlight actually
   * differs from what is already there.
   */
  setHighlight(device: GPUDevice, highlight: CapHighlight | null): void {
    if (!this.fillVertexBuffer || !this.fillSource) return;
    const next = highlight && highlight.size > 0 ? highlight : null;
    if (sameHighlight(this.appliedHighlight, next)) return;
    // A copy: the caller may mutate and re-pass the same Map, which must still read as a change.
    this.appliedHighlight = next && new Map(next);
    device.queue.writeBuffer(this.fillVertexBuffer, 0, recolorCapVertices(this.fillSource, this.fillRanges, next) ?? this.fillSource);
  }

  upload(
    device: GPUDevice,
    highlight: CapHighlight | null,
    polygons: CutPolygon2D[],
    lines: DrawingLine2D[],
    axis: SectionAxis,
    planePosition: number,
    flipped: boolean,
    customPlane?: SectionCustomPlane,
  ): void {
    this.clear();
    const lift = createSectionLift(axis, planePosition, flipped, customPlane);
    const planeAnchor: [number, number, number] = customPlane
      ? [...customPlane.origin]
      : axis === 'side' ? [planePosition, 0, 0]
        : axis === 'down' ? [0, planePosition, 0] : [0, 0, planePosition];
    // The plane-coordinate anchor was enough when every model was near the
    // origin. At a survey offset it leaves both in-plane coordinates absolute
    // in the f32 vertex buffer, collapsing centimetre cap edges. Anchor at an
    // actual lifted point instead, while retaining the old plane point for an
    // empty upload that produces no vertex buffer to draw.
    const firstPoint = polygons.find((polygon) => polygon.polygon.outer.length > 0)?.polygon.outer[0]
      ?? lines[0]?.line.start;
    const anchor = firstPoint ? lift(firstPoint.x, firstPoint.y) : planeAnchor;

    // Lift/subtract while the coordinates are JS f64. Building a world-space
    // Float32Array first then subtracting the cap anchor loses centimetre
    // detail in both the plane normal and its in-plane axes at national-grid
    // offsets.
    const fill = buildCapFillGeometry(polygons, lift, anchor);
    if (fill) {
      this.fillVertexBuffer = device.createBuffer({
        size: fill.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.fillSource = fill.vertices;
      this.fillRanges = fill.ranges;
      const painted = recolorCapVertices(fill.vertices, fill.ranges, highlight);
      this.appliedHighlight = painted && highlight && highlight.size > 0 ? new Map(highlight) : null;
      device.queue.writeBuffer(this.fillVertexBuffer, 0, painted ?? fill.vertices);

      this.fillIndexBuffer = device.createBuffer({
        size: fill.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.fillIndexBuffer, 0, fill.indices);
      this.fillIndexCount = fill.indices.length;
    }

    const outline = buildDrawingOutlineVertices(polygons, lines, lift, anchor);
    if (outline) {
      this.lineVertexBuffer = device.createBuffer({
        size: outline.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(this.lineVertexBuffer, 0, outline);
      this.lineVertexCount = outline.length / 3; // Each vertex is 3 floats
    }
    this.anchor = anchor;
  }
}

function sameHighlight(a: CapHighlight | null, b: CapHighlight | null): boolean {
  if (a === null && b === null) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [id, color] of a) {
    const other = b.get(id);
    if (!other || other[0] !== color[0] || other[1] !== color[1] || other[2] !== color[2] || other[3] !== color[3]) return false;
  }
  return true;
}

/** One extra plane's cap to draw: its key and the planes that clip it. */
export interface ExtraCapDraw {
  key: string;
  /** Every OTHER cutting plane (the primary one included), resolved in world space. */
  clippedBy: readonly ExtraClipPlane[];
}

export class SectionCapSet {
  private readonly primary = new CapGeometry();
  private readonly extras = new Map<string, CapGeometry>();
  private readonly uniforms = new Float32Array(SECTION_2D_UNIFORM_FLOATS);
  private readonly clipScratch = new Float32Array(EXTRA_CLIP_FLOATS);
  /** The elements whose cap is painted in a highlight colour; carried over every re-upload. */
  private highlight: CapHighlight | null = null;

  /** Paint these elements' cap polygons in their colour on every cap; `null` clears. */
  setHighlight(device: GPUDevice, highlight: CapHighlight | null): void {
    this.highlight = highlight && highlight.size > 0 ? highlight : null;
    this.primary.setHighlight(device, this.highlight);
    for (const geometry of this.extras.values()) geometry.setHighlight(device, this.highlight);
  }

  /** Whether the primary plane's cap holds anything. */
  has(): boolean { return this.primary.has(); }

  /** Whether any extra plane's cap holds anything. */
  hasExtras(): boolean {
    for (const geometry of this.extras.values()) if (geometry.has()) return true;
    return false;
  }

  /** The keys of the extra caps currently held. */
  extraKeys(): string[] { return [...this.extras.keys()]; }

  upload(device: GPUDevice, key: string | null, ...args: [
    CutPolygon2D[], DrawingLine2D[], SectionAxis, number, boolean, SectionCustomPlane | undefined,
  ]): void {
    if (key === null) {
      this.primary.upload(device, this.highlight, ...args);
      return;
    }
    // A plane past the capacity has no uniform slot to draw with.
    if (!this.extras.has(key) && this.extras.size >= SECTION_2D_MAX_EXTRA_CAPS) return;
    let geometry = this.extras.get(key);
    if (!geometry) { geometry = new CapGeometry(); this.extras.set(key, geometry); }
    geometry.upload(device, this.highlight, ...args);
  }

  /** Release the primary cap (`key` null) or one extra cap. */
  clear(key: string | null): void {
    if (key === null) { this.primary.clear(); return; }
    this.extras.get(key)?.clear();
    this.extras.delete(key);
  }

  /** Release every extra cap whose key is not in `keep`. */
  clearExtrasExcept(keep: ReadonlySet<string>): void {
    for (const key of [...this.extras.keys()]) if (!keep.has(key)) this.clear(key);
  }

  dispose(): void {
    this.primary.clear();
    for (const geometry of this.extras.values()) geometry.clear();
    this.extras.clear();
  }

  /** Draw the primary plane's cap, clipped by `clippedBy` (every extra cutting plane). */
  draw(
    pass: GPURenderPassEncoder,
    res: CapDrawResources,
    options: Section2DOverlayOptions,
    clippedBy: readonly ExtraClipPlane[],
  ): void {
    this.drawOne(pass, res, options, this.primary, SECTION_2D_UNIFORM_SLOT_INDEX.sectionCut, 0, clippedBy);
  }

  /** Draw each listed extra plane's cap in its own uniform slot, with the cap style of the primary. */
  drawExtras(
    pass: GPURenderPassEncoder,
    res: CapDrawResources,
    options: Section2DOverlayOptions,
    caps: readonly ExtraCapDraw[],
  ): void {
    const keys = this.extraKeys();
    for (const cap of caps) {
      const geometry = this.extras.get(cap.key);
      if (!geometry?.has()) continue;
      const index = keys.indexOf(cap.key);
      this.drawOne(pass, res, options, geometry, SECTION_2D_UNIFORM_SLOT_INDEX.extraCap + index, 1 + index, cap.clippedBy);
    }
  }

  private drawOne(
    pass: GPURenderPassEncoder,
    res: CapDrawResources,
    options: Section2DOverlayOptions,
    geometry: CapGeometry,
    uniformSlot: number,
    clipSlot: number,
    clippedBy: readonly ExtraClipPlane[],
  ): void {
    if (!geometry.has()) return;
    const { viewProj } = options;

    // No offset — cap renders exactly on the section plane. The previous
    // 0.3m bias was there to keep the outline lines clear of below-plane
    // geometry, but it made the cap visually drift off the slider plane
    // (users could see a 0.3m gap between the plane preview and the cap).
    // The fill pipeline uses depthCompare 'greater-equal' (reverse-Z) so the
    // cap ties cleanly with coincident below-plane top faces and is occluded
    // by nearer model geometry — see the depthStencil comment in
    // `section-cap-pipelines.ts`. There is no stencil test; the fill is restricted
    // to the actual cap polygons by the triangle-plane intersection geometry
    // `SectionCutter` produces, not by a stencil gate.
    // Cap vertices are stored relative to the anchor so that the RTE path can
    // retain their small in-plane residuals. The legacy view-projection path
    // still transforms world coordinates, however, so it must add that anchor
    // back through planeOffset. Leaving it zero placed every rebased legacy
    // cap around the world origin. Do not combine the two: RTE adds this same
    // anchor as an f64 split drawable delta below.
    const anchor = geometry.anchor;
    const rteViewProj = options.rteViewProj;
    const rteCamera = options.rteCamera;
    const rte = anchor !== null && rteViewProj !== undefined && rteCamera !== undefined;
    const offset: [number, number, number] = anchor === null || rte ? [0, 0, 0] : anchor;

    // Field offsets come from SECTION_2D_UNIFORM_SLOTS, which sits next to the
    // WGSL struct it describes.
    const S = SECTION_2D_UNIFORM_SLOTS;
    const uniforms = this.uniforms;
    uniforms.fill(0);
    uniforms.set(viewProj, S.viewProj);
    if (rte) {
      uniforms.set(rteViewProj, S.rteViewProj);
      // Outside this camera's RTE envelope: the cap and its outline, the only
      // draws below, are not rasterisable this frame (#6128).
      if (!tryPackRteDrawableDelta(anchor, rteCamera, uniforms, S.originDeltaHigh)) return;
      uniforms[S.originDeltaHigh + 3] = 1;
    }
    uniforms.set(res.lineColor, S.lineColor); // section-cut outline colour
    uniforms[S.planeOffset + 0] = offset[0];
    uniforms[S.planeOffset + 1] = offset[1];
    uniforms[S.planeOffset + 2] = offset[2];
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
    // Each cap owns its slot. Both draws below read it, which is correct: the
    // fill and the outline are one drawing with one plane offset and one style.
    // What they must NOT share is the record the world-space line families
    // write, whose zeroed cap-style tail would otherwise arrive here.
    // The planes that remove this cap's fragments, in the frame the shader works in
    // (eye-relative on the RTE path, world otherwise). Written first: the cap's own
    // uniform record stays the last write of the draw.
    packExtraClip(clippedBy, rte ? rteCamera : null, this.clipScratch, 0);
    const clipOffset = clipSlot * res.clipStride;
    res.device.queue.writeBuffer(res.clipBuffer, clipOffset, this.clipScratch);
    const uniformOffset = uniformSlot * res.uniformStride;
    res.device.queue.writeBuffer(res.uniformBuffer, uniformOffset, uniforms);

    // Filled polygons = the 3D section cap. Render them ONLY when the
    // caller opts in (`showFills: true` + a capStyle). This replaces the
    // old stencil-parity cap, which leaked hatch into empty sky on non-
    // manifold IFC geometry. The polygons here come from exact triangle-
    // plane intersection in `SectionCutter`, so the silhouette is
    // mathematically correct.
    if (
      options.showFills === true &&
      options.capStyle &&
      geometry.fillVertexBuffer &&
      geometry.fillIndexBuffer &&
      geometry.fillIndexCount > 0
    ) {
      pass.setPipeline(res.fillPipeline);
      pass.setBindGroup(0, res.bindGroup, [uniformOffset]);
      pass.setBindGroup(1, res.clipBindGroup, [clipOffset]);
      pass.setVertexBuffer(0, geometry.fillVertexBuffer);
      pass.setIndexBuffer(geometry.fillIndexBuffer, 'uint32');
      pass.drawIndexed(geometry.fillIndexCount);
      // Then its depth, colour-masked, for the post passes (section-cap-pipelines.ts).
      pass.setPipeline(res.fillDepthPipeline);
      pass.drawIndexed(geometry.fillIndexCount);
    }

    // Outline lines on top of the fill. Gated by `showOutlines` so the
    // user can toggle surfaces and outlines independently from the UI.
    // Defaults to true when the caller omits the flag.
    if (
      options.showOutlines !== false &&
      geometry.lineVertexBuffer &&
      geometry.lineVertexCount > 0
    ) {
      pass.setPipeline(res.outlinePipeline);
      pass.setBindGroup(0, res.bindGroup, [uniformOffset]);
      pass.setBindGroup(1, res.clipBindGroup, [clipOffset]);
      pass.setVertexBuffer(0, geometry.lineVertexBuffer);
      pass.draw(geometry.lineVertexCount);
    }
  }
}
