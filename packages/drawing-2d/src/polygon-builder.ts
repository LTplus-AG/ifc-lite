/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Polygon Builder - Reconstructs closed polygons from cut line segments
 *
 * Takes the line segments from section cutting and connects them into
 * closed polygon rings, handling:
 * - Multiple disconnected polygons per entity
 * - Holes (inner boundaries)
 * - Floating point tolerance for vertex matching
 */

import type { Point2D, Polygon2D, CutSegment, DrawingPolygon, EntityKey } from './types.js';
import { makeEntityKey } from './types.js';
import {
  EPSILON,
  point2DDistance,
  point2DEquals,
  polygonSignedArea,
  ensureCCW,
  ensureCW,
} from './math.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface Segment2D {
  start: Point2D;
  end: Point2D;
  used: boolean;
}

interface Loop {
  points: Point2D[];
  area: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// POLYGON BUILDER CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class PolygonBuilder {
  /** Tolerance for vertex matching */
  private tolerance: number;

  constructor(tolerance: number = 0.0001) {
    this.tolerance = tolerance;
  }

  /**
   * Build polygons from cut segments
   * Groups segments by entity and reconstructs closed loops
   */
  buildPolygons(segments: CutSegment[]): DrawingPolygon[] {
    // Group segments by entity
    const byEntity = new Map<EntityKey, CutSegment[]>();

    for (const seg of segments) {
      const key = makeEntityKey(seg.modelIndex, seg.entityId);
      if (!byEntity.has(key)) {
        byEntity.set(key, []);
      }
      byEntity.get(key)!.push(seg);
    }

    // Build polygons for each entity - collect arrays for efficient flattening
    const polygonArrays: DrawingPolygon[][] = [];

    for (const [key, entitySegments] of byEntity) {
      const entityPolygons = this.buildEntityPolygons(entitySegments);
      polygonArrays.push(entityPolygons);
    }

    return polygonArrays.flat();
  }

  /**
   * Build polygons for a single entity
   */
  private buildEntityPolygons(segments: CutSegment[]): DrawingPolygon[] {
    if (segments.length === 0) return [];

    const first = segments[0];
    const { entityId, ifcType, modelIndex } = first;

    // Convert to 2D segments
    const segments2D: Segment2D[] = segments.map((seg) => ({
      start: seg.p0_2d,
      end: seg.p1_2d,
      used: false,
    }));

    // Build closed loops
    const loops = this.buildLoops(segments2D);

    if (loops.length === 0) return [];

    // Classify loops as outer boundaries or holes
    const classified = this.classifyLoops(loops);

    // Build final polygons
    return classified.map((c) => ({
      polygon: {
        outer: c.outer,
        holes: c.holes,
      },
      entityId,
      ifcType,
      modelIndex,
      isCut: true,
    }));
  }

  /**
   * Build closed loops from segments using a greedy chain-building algorithm
   */
  private buildLoops(segments: Segment2D[]): Loop[] {
    const loops: Loop[] = [];

    // Keep building loops until no more unused segments
    while (true) {
      // Find first unused segment
      const startIdx = segments.findIndex((s) => !s.used);
      if (startIdx === -1) break;

      const loop = this.buildSingleLoop(segments, startIdx);
      if (loop && loop.length >= 3) {
        const area = polygonSignedArea(loop);
        loops.push({ points: loop, area });
      }
    }

    return loops;
  }

  /**
   * Build a single closed loop starting from a segment
   */
  private buildSingleLoop(segments: Segment2D[], startIdx: number): Point2D[] | null {
    const points: Point2D[] = [];
    const startSeg = segments[startIdx];
    startSeg.used = true;

    points.push(startSeg.start);
    let currentEnd = startSeg.end;
    const loopStart = startSeg.start;

    const maxIterations = segments.length;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      // Check if we've closed the loop
      if (point2DDistance(currentEnd, loopStart) < this.tolerance) {
        return points;
      }

      // Find next connecting segment
      const nextIdx = this.findConnectingSegment(segments, currentEnd);
      if (nextIdx === -1) {
        // Can't close loop - mark remaining as unused and return partial
        // This can happen with open geometry or numerical issues
        break;
      }

      const nextSeg = segments[nextIdx];
      nextSeg.used = true;

      // Determine which end connects
      if (point2DDistance(nextSeg.start, currentEnd) < this.tolerance) {
        points.push(nextSeg.start);
        currentEnd = nextSeg.end;
      } else {
        points.push(nextSeg.end);
        currentEnd = nextSeg.start;
      }
    }

    // Loop didn't close - return points anyway for potential use
    // Some entities may have open cross-sections
    return points.length >= 3 ? points : null;
  }

  /**
   * Find an unused segment that connects to the given point
   */
  private findConnectingSegment(segments: Segment2D[], point: Point2D): number {
    let bestIdx = -1;
    let bestDist = this.tolerance;

    for (let i = 0; i < segments.length; i++) {
      if (segments[i].used) continue;

      const seg = segments[i];

      // Check start point
      const distStart = point2DDistance(seg.start, point);
      if (distStart < bestDist) {
        bestDist = distStart;
        bestIdx = i;
      }

      // Check end point
      const distEnd = point2DDistance(seg.end, point);
      if (distEnd < bestDist) {
        bestDist = distEnd;
        bestIdx = i;
      }
    }

    return bestIdx;
  }

  /**
   * Classify loops as outer boundaries or holes
   * Uses containment testing and area sign
   */
  private classifyLoops(loops: Loop[]): Array<{ outer: Point2D[]; holes: Point2D[][] }> {
    if (loops.length === 0) return [];

    // Sort by absolute area (largest first)
    const sorted = [...loops].sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

    const result: Array<{ outer: Point2D[]; holes: Point2D[][] }> = [];
    const assigned = new Set<number>();

    for (let i = 0; i < sorted.length; i++) {
      if (assigned.has(i)) continue;

      const outer = sorted[i];

      // Ensure outer boundary is CCW
      const outerPoints = ensureCCW(outer.points);

      // Find holes (smaller loops contained within this one)
      const holes: Point2D[][] = [];

      for (let j = i + 1; j < sorted.length; j++) {
        if (assigned.has(j)) continue;

        const inner = sorted[j];

        // Check if inner is contained in outer
        if (this.isLoopContainedIn(inner.points, outerPoints)) {
          // Ensure hole is CW (opposite winding)
          holes.push(ensureCW(inner.points));
          assigned.add(j);
        }
      }

      assigned.add(i);
      result.push({ outer: outerPoints, holes });
    }

    return result;
  }

  /**
   * Check if a loop is contained within another loop
   * Uses point-in-polygon test on the first point
   */
  private isLoopContainedIn(inner: Point2D[], outer: Point2D[]): boolean {
    // Test the first point of inner against outer
    const testPoint = inner[0];
    return this.pointInPolygon(testPoint, outer);
  }

  /**
   * Ray casting point-in-polygon test
   */
  private pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
    let inside = false;
    const n = polygon.length;

    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = polygon[i];
      const pj = polygon[j];

      if (
        pi.y > point.y !== pj.y > point.y &&
        point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x
      ) {
        inside = !inside;
      }
    }

    return inside;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simplify polygon by removing collinear points
 */
export function simplifyPolygon(points: Point2D[], tolerance: number = 0.001): Point2D[] {
  if (points.length < 3) return points;

  const result: Point2D[] = [];

  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];

    // Check if current point is on the line between prev and next
    if (!isCollinear(prev, curr, next, tolerance)) {
      result.push(curr);
    }
  }

  return result.length >= 3 ? result : points;
}

/**
 * Check if three points are collinear
 */
function isCollinear(a: Point2D, b: Point2D, c: Point2D, tolerance: number): boolean {
  // Area of triangle formed by the three points
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
  return area < tolerance;
}

/**
 * Compute polygon bounds
 */
export function polygonBounds(
  points: Point2D[]
): { min: Point2D; max: Point2D } {
  let minX = Infinity,
    minY = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity;

  for (const p of points) {
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
