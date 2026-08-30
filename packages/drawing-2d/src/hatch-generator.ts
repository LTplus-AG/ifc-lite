/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hatch Generator - Generate hatch lines for cut polygons
 *
 * Creates parallel line patterns clipped to polygon boundaries
 * for architectural section drawings.
 */

import type { Point2D, Line2D, Polygon2D, DrawingPolygon, Bounds2D } from './types.js';
import type { HatchPattern, HatchPatternType } from './styles.js';
import { getHatchPattern } from './styles.js';
import { EPSILON } from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface HatchLine {
  line: Line2D;
  /** Source polygon entity ID */
  entityId: number;
  /** IFC type for styling */
  ifcType: string;
  /** Model index */
  modelIndex: number;
}

export interface HatchResult {
  /** Generated hatch lines */
  lines: HatchLine[];
  /** Pattern used */
  pattern: HatchPattern;
  /** Source polygon */
  polygon: DrawingPolygon;
}

// ═══════════════════════════════════════════════════════════════════════════
// HATCH GENERATOR CLASS
// ═══════════════════════════════════════════════════════════════════════════

/** Custom hatch settings that can override IFC type-based patterns */
export interface CustomHatchSettings {
  type: HatchPatternType;
  spacing?: number;
  angle?: number;
  secondaryAngle?: number;
}

export class HatchGenerator {
  /**
   * Generate hatch lines for a polygon
   * @param polygon The polygon to hatch
   * @param scale Drawing scale (100 = 1:100)
   * @param customSettings Optional override settings (type, spacing, angle)
   */
  generateHatch(
    polygon: DrawingPolygon,
    scale: number = 100,
    customSettings?: CustomHatchSettings
  ): HatchResult {
    // Use custom settings if provided, otherwise lookup by IFC type
    const basePattern = getHatchPattern(polygon.ifcType);
    const pattern: HatchPattern = customSettings
      ? {
          ...basePattern,
          type: customSettings.type,
          spacing: customSettings.spacing ?? basePattern.spacing,
          angle: customSettings.angle ?? basePattern.angle,
          secondaryAngle: customSettings.secondaryAngle ?? basePattern.secondaryAngle,
        }
      : basePattern;

    if (pattern.type === 'none' || pattern.type === 'solid' || pattern.type === 'glass') {
      return { lines: [], pattern, polygon };
    }

    // Adjust spacing for drawing scale
    const spacing = pattern.spacing * (scale / 100);

    let lines: HatchLine[] = [];

    // Generate primary hatch direction
    const primaryLines = this.generateParallelLines(
      polygon.polygon,
      spacing,
      pattern.angle,
      polygon.entityId,
      polygon.ifcType,
      polygon.modelIndex
    );
    lines.push(...primaryLines);

    // Generate secondary direction for cross-hatch
    if (pattern.type === 'cross-hatch' && pattern.secondaryAngle !== undefined) {
      const secondaryLines = this.generateParallelLines(
        polygon.polygon,
        spacing,
        pattern.secondaryAngle,
        polygon.entityId,
        polygon.ifcType,
        polygon.modelIndex
      );
      lines.push(...secondaryLines);
    }

    // Special patterns
    if (pattern.type === 'concrete') {
      // Concrete uses random dots - we'll approximate with offset diagonal lines
      const offsetLines = this.generateParallelLines(
        polygon.polygon,
        spacing * 1.5,
        pattern.angle + 90,
        polygon.entityId,
        polygon.ifcType,
        polygon.modelIndex
      );
      lines.push(...offsetLines);
    }

    return { lines, pattern, polygon };
  }

  /**
   * Generate hatching for multiple polygons
   * @param polygons Polygons to hatch
   * @param scale Drawing scale
   * @param getCustomSettings Optional function to get custom settings per polygon
   */
  generateHatches(
    polygons: DrawingPolygon[],
    scale: number = 100,
    getCustomSettings?: (polygon: DrawingPolygon) => CustomHatchSettings | undefined
  ): HatchResult[] {
    return polygons.map((polygon) => {
      const customSettings = getCustomSettings?.(polygon);
      return this.generateHatch(polygon, scale, customSettings);
    });
  }

  /**
   * Generate parallel lines at a given angle, clipped to polygon
   */
  private generateParallelLines(
    polygon: Polygon2D,
    spacing: number,
    angleDegrees: number,
    entityId: number,
    ifcType: string,
    modelIndex: number
  ): HatchLine[] {
    if (spacing < EPSILON) return [];

    const angleRad = (angleDegrees * Math.PI) / 180;

    // Direction perpendicular to hatch lines (for stepping)
    const perpX = Math.cos(angleRad);
    const perpY = Math.sin(angleRad);

    // Direction along hatch lines
    const alongX = -perpY;
    const alongY = perpX;

    // Compute bounds of polygon
    const bounds = this.computePolygonBounds(polygon);
    if (!bounds) return [];

    // Project corners onto perpendicular direction to find range
    const corners = [
      { x: bounds.min.x, y: bounds.min.y },
      { x: bounds.max.x, y: bounds.min.y },
      { x: bounds.max.x, y: bounds.max.y },
      { x: bounds.min.x, y: bounds.max.y },
    ];

    let minD = Infinity;
    let maxD = -Infinity;
    for (const c of corners) {
      const d = c.x * perpX + c.y * perpY;
      minD = Math.min(minD, d);
      maxD = Math.max(maxD, d);
    }

    // Extent for lines (diagonal of bounds)
    const extent =
      Math.sqrt(
        Math.pow(bounds.max.x - bounds.min.x, 2) + Math.pow(bounds.max.y - bounds.min.y, 2)
      ) * 1.5;

    const lines: HatchLine[] = [];

    // Generate lines at regular intervals
    for (let d = minD; d <= maxD; d += spacing) {
      // Point on the perpendicular at distance d
      const originX = d * perpX;
      const originY = d * perpY;

      // Line endpoints extending in both directions
      const lineStart: Point2D = {
        x: originX - alongX * extent,
        y: originY - alongY * extent,
      };
      const lineEnd: Point2D = {
        x: originX + alongX * extent,
        y: originY + alongY * extent,
      };

      // Clip line against polygon
      const clippedSegments = this.clipLineToPolygon({ start: lineStart, end: lineEnd }, polygon);

      for (const segment of clippedSegments) {
        lines.push({
          line: segment,
          entityId,
          ifcType,
          modelIndex,
        });
      }
    }

    return lines;
  }

  /**
   * Clip a line to a polygon (with holes)
   * Returns array of line segments inside the polygon
   */
  private clipLineToPolygon(line: Line2D, polygon: Polygon2D): Line2D[] {
    // First clip to outer boundary
    let segments = this.clipLineToRing(line, polygon.outer, true);

    // Then subtract holes
    for (const hole of polygon.holes) {
      const newSegments: Line2D[] = [];
      for (const segment of segments) {
        const clipped = this.clipLineToRing(segment, hole, false);
        newSegments.push(...clipped);
      }
      segments = newSegments;
    }

    return segments;
  }

  /**
   * Clip a line to a polygon ring
   * @param inside If true, keep segments inside ring. If false, keep segments outside.
   */
  private clipLineToRing(line: Line2D, ring: Point2D[], inside: boolean): Line2D[] {
    const dx = line.end.x - line.start.x;
    const dy = line.end.y - line.start.y;

    // Signed side of the (infinite) hatch line a ring vertex falls on. An
    // edge counts as a crossing only when its two endpoints have opposite
    // signs, with the tie-break "not > 0" applied to whatever the sign
    // actually computes as. That is what makes a ring VERTEX sitting on the
    // hatch line resolve correctly however it occurs: at a tangent spike
    // (the ring stays on one side and only touches) the two adjacent edges
    // contribute an EVEN number of crossings — zero when the vertex buckets
    // with its neighbours, two when it buckets against them — so parity is
    // unchanged; at a genuine pass-through (neighbours on opposite sides)
    // exactly one of the two adjacent edges crosses, net 1. The previous
    // implementation computed a literal geometric intersection per EDGE
    // regardless of side and de-duplicated near-equal `t` values, which
    // collapsed a spike's two touching intersections into ONE instead of
    // zero, inverting the inside/outside sense of every segment built past
    // it — including the final "run off the far end of the line" segment,
    // which is how a hatch line ended up running dozens of units outside
    // the polygon it was clipped to.
    //
    // The tie-break reads as an infinitesimal displacement of the hatch line
    // BACKWARDS along the sweep direction — `sideOf`'s `> 0` half-plane is
    // the `-perp` one, and `generateParallelLines` steps along `+perp` from
    // the bounding-box minimum. Every ring is nudged by that same amount in
    // that same direction, so a row lying exactly on an edge resolves to
    // whichever side of the ring the sweep has not reached yet: the sweep's
    // first line sits on the outer ring's minimum-side edge and falls
    // outside the polygon, a line flush with a hole's minimum-side edge
    // falls outside that hole and is kept, and a line flush with a hole's
    // far edge falls inside it and is subtracted. All three are the one
    // rule, and none of them moves a line off the boundary into an
    // interior.
    const sideOf = (p: Point2D): number =>
      dx * (p.y - line.start.y) - dy * (p.x - line.start.x);

    const lenSq = dx * dx + dy * dy;
    // Crossings anywhere on the INFINITE line, not only the stretch between
    // `line.start` and `line.end`. That is what lets the walk below seed
    // itself: the ring is closed, so its vertices end in the bucket they
    // started in, the crossing count is therefore even, and the state out at
    // `t = -Infinity` is "outside the ring" for any ring whatever. The
    // earlier version kept only crossings within `[0, 1]` and seeded the
    // walk by ray-casting `line.start` instead, which decides a point lying
    // exactly ON the ring by its own rule — the opposite of the tie-break
    // above. On a row flush with a hole's edge the two disagreed: no
    // crossings by side, `inside` by ray cast, so the whole row was thrown
    // away, taking interior fill with it that never touched the hole.
    const ts: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const sa = sideOf(ring[i]);
      const sb = sideOf(ring[j]);
      if (sa > 0 === sb > 0) continue;
      // Locate the crossing by interpolating the very side values the test
      // above used, then project it back onto the line. Deriving `t` from a
      // separate segment-intersection solve instead would let the two
      // disagree: an edge nominally COLLINEAR with the hatch line still has
      // endpoints a few ULPs either side of it, so the side test calls it a
      // crossing while a cross-product test calls it parallel and drops it —
      // one lost crossing inverts parity for the rest of the line.
      const u = sa / (sa - sb);
      const px = ring[i].x + u * (ring[j].x - ring[i].x);
      const py = ring[i].y + u * (ring[j].y - ring[i].y);
      ts.push(((px - line.start.x) * dx + (py - line.start.y) * dy) / lenSq);
    }
    ts.sort((a, b) => a - b);

    // `t <= 0` and `t >= 1` return copies of the line's own endpoints rather
    // than `start + t * d`, which in floating point is not exactly the
    // endpoint. A segment handed on to the next ring's clip therefore
    // carries the coordinates it arrived with, unrounded.
    const pointAt = (t: number): Point2D => {
      if (t <= 0) return { x: line.start.x, y: line.start.y };
      if (t >= 1) return { x: line.end.x, y: line.end.y };
      return { x: line.start.x + t * dx, y: line.start.y + t * dy };
    };

    const segments: Line2D[] = [];
    const keep = (from: number, to: number): void => {
      const lo = Math.max(from, 0);
      const hi = Math.min(to, 1);
      if (hi > lo) segments.push({ start: pointAt(lo), end: pointAt(hi) });
    };

    // Walk the whole line from `t = -Infinity`, where every ring is outside,
    // and clip each kept run back to the `[0, 1]` stretch that was asked for.
    let currentlyInside = false;
    let lastT = -Infinity;
    for (const t of ts) {
      if (currentlyInside === inside) keep(lastT, t);
      lastT = t;
      currentlyInside = !currentlyInside;
    }
    if (currentlyInside === inside) keep(lastT, Infinity);

    // Filter out degenerate segments
    return segments.filter((seg) => {
      const len =
        Math.abs(seg.end.x - seg.start.x) + Math.abs(seg.end.y - seg.start.y);
      return len > EPSILON;
    });
  }

  /**
   * Compute bounding box of polygon
   */
  private computePolygonBounds(polygon: Polygon2D): Bounds2D | null {
    if (polygon.outer.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const p of polygon.outer) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    return {
      min: { x: minX, y: minY },
      max: { x: maxX, y: maxY },
    };
  }
}
