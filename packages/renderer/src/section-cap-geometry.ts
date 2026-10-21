/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { buildCapFillGeometry, buildDrawingOutlineVertices, createSectionLift, recolorCapVertices,
  type CapHighlight, type CapPolygonRange, type CutPolygon2D, type DrawingLine2D,
  type SectionAxis, type SectionCustomPlane } from './section-2d-lift.js';

type CapSource = [CutPolygon2D[], DrawingLine2D[], SectionAxis, number, boolean, SectionCustomPlane?];
/** One cap's GPU geometry: the filled polygons and their outline. */
export class CapGeometry {
  private source: CapSource | null = null;
  private sourceHasGeometry = false;
  private excluded = new Set<number>();
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

  setExclusions(device: GPUDevice, highlight: CapHighlight | null, ids?: ReadonlySet<number>): void {
    if (!this.source || (this.excluded.size === (ids?.size ?? 0) && [...this.excluded].every(id => ids?.has(id)))) return;
    const source = this.source;
    const sourceHasGeometry = this.sourceHasGeometry;
    const [polygons, lines, ...plane] = source;
    this.upload(device, highlight, polygons.filter(p => !ids?.has(p.expressId)),
      lines.filter(l => l.ownerId === undefined || !ids?.has(l.ownerId)), ...plane);
    this.source = source;
    this.sourceHasGeometry = sourceHasGeometry;
    this.excluded = new Set(ids);
  }

  has(): boolean {
    return this.sourceHasGeometry;
  }

  clear(): void {
    this.source = null;
    this.sourceHasGeometry = false;
    this.excluded.clear();
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
    this.source = [polygons, lines, axis, planePosition, flipped, customPlane];
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
      // Cached even when nothing here matched, so the next frame's identical highlight is a no-op.
      this.appliedHighlight = highlight && highlight.size > 0 ? new Map(highlight) : null;
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
    this.sourceHasGeometry = this.fillIndexCount > 0 || this.lineVertexCount > 0;
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
