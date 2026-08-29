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

    // Which side of the (infinite) hatch line a ring vertex is on. A vertex
    // exactly ON the line buckets with the "not > 0" side — the same
    // strict, consistent tie-break `pointInRing` below uses for its own ray
    // cast — so an edge is a genuine crossing only when its two endpoints
    // land on OPPOSITE sides. That is what makes a ring VERTEX sitting
    // exactly on the hatch line resolve correctly either way it occurs: at
    // a tangent spike (both neighbouring edges climbing away on the SAME
    // side) neither adjacent edge crosses, net 0; at a genuine pass-through
    // (neighbours on opposite sides) exactly one of the two adjacent edges
    // crosses, net 1 — the even/odd parity a robust point-in-polygon test
    // relies on. The previous implementation computed a literal geometric
    // intersection per EDGE regardless of side and de-duplicated near-equal
    // `t` values, which collapsed a spike's two touching intersections into
    // ONE instead of zero, inverting the inside/outside sense of every
    // segment built past it — including the final "run off the far end of
    // the line" segment, which is how a hatch line ended up running dozens
    // of units outside the polygon it was clipped to.
    const side = (p: Point2D): boolean =>
      dx * (p.y - line.start.y) - dy * (p.x - line.start.x) > 0;

    const ts: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      if (side(ring[i]) === side(ring[j])) continue;
      const intersection = this.lineLineIntersection(line.start, line.end, ring[i], ring[j]);
      if (intersection !== null && intersection.t >= 0 && intersection.t <= 1) {
        ts.push(intersection.t);
      }
    }
    ts.sort((a, b) => a - b);

    // A line with zero crossings has a CONSTANT inside/outside state along
    // its whole length, so testing at `line.start` (rather than the line's
    // midpoint, as before) is exact — and unlike the midpoint it cannot
    // coincide with the very vertex that made the crossing count zero: the
    // caller always extends `line` well past the ring before this is
    // reached (`generateParallelLines`'s `extent`), so a hatch row that
    // merely grazes the ring's boundary (no interior on either side to
    // enter) resolves to "outside" rather than to whichever side the
    // midpoint happened to land on.
    if (ts.length === 0) {
      return this.pointInRing(line.start, ring) === inside ? [line] : [];
    }

    // Build segments based on intersections
    const segments: Line2D[] = [];

    // Check if we start inside
    let currentlyInside = this.pointInRing(line.start, ring);
    let lastT = 0;

    for (const t of ts) {
      if (currentlyInside === inside) {
        // Add segment from lastT to this intersection
        segments.push({
          start: {
            x: line.start.x + lastT * dx,
            y: line.start.y + lastT * dy,
          },
          end: {
            x: line.start.x + t * dx,
            y: line.start.y + t * dy,
          },
        });
      }
      lastT = t;
      currentlyInside = !currentlyInside;
    }

    // Handle final segment to end
    if (currentlyInside === inside) {
      segments.push({
        start: {
          x: line.start.x + lastT * dx,
          y: line.start.y + lastT * dy,
        },
        end: line.end,
      });
    }

    // Filter out degenerate segments
    return segments.filter((seg) => {
      const len =
        Math.abs(seg.end.x - seg.start.x) + Math.abs(seg.end.y - seg.start.y);
      return len > EPSILON;
    });
  }

  /**
   * Line-line intersection
   * Returns t parameter on first line, or null if no intersection
   */
  private lineLineIntersection(
    p1: Point2D,
    p2: Point2D,
    p3: Point2D,
    p4: Point2D
  ): { t: number; u: number } | null {
    const d1x = p2.x - p1.x;
    const d1y = p2.y - p1.y;
    const d2x = p4.x - p3.x;
    const d2y = p4.y - p3.y;

    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < EPSILON) {
      return null; // Parallel
    }

    const dx = p3.x - p1.x;
    const dy = p3.y - p1.y;

    const t = (dx * d2y - dy * d2x) / cross;
    const u = (dx * d1y - dy * d1x) / cross;

    // Check if intersection is within edge segment. Tolerant at the
    // boundary: `clipLineToRing` only calls this for an edge whose two
    // endpoints its own side test already found on OPPOSITE sides of the
    // query line, so the true intersection is at u = 0 or 1 exactly when
    // that edge's ON-line endpoint IS the crossing point — and once the
    // query line has any tilt at all, that u routinely computes a few ULPs
    // past the boundary rather than landing exactly on it.
    if (u < -EPSILON || u > 1 + EPSILON) {
      return null;
    }

    return { t, u };
  }

  /**
   * Point in polygon ring test (ray casting)
   */
  private pointInRing(point: Point2D, ring: Point2D[]): boolean {
    let inside = false;
    const n = ring.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = ring[i];
      const pj = ring[j];

      if (
        pi.y > point.y !== pj.y > point.y &&
        point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x
      ) {
        inside = !inside;
      }
    }

    return inside;
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
