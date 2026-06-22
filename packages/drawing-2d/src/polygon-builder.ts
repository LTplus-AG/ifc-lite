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
import { makeEntityKey, colorKey } from './types.js';
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
   * Build polygons for a single entity.
   *
   * Sub-groups the entity's segments by material colour so an
   * `IfcMaterialLayerSet` wall/slab — sliced into one sub-mesh (hence one
   * colour) per layer — reconstructs as one polygon set per layer, each
   * carrying that layer's colour. A single-material entity yields exactly one
   * colour group and is built identically to before, with no colour stamped
   * (so renderers keep their per-`ifcType` / per-entity fill for it).
   */
  private buildEntityPolygons(segments: CutSegment[]): DrawingPolygon[] {
    if (segments.length === 0) return [];

    const byColor = new Map<string, CutSegment[]>();
    for (const seg of segments) {
      const key = colorKey(seg.color);
      let bucket = byColor.get(key);
      if (!bucket) {
        bucket = [];
        byColor.set(key, bucket);
      }
      bucket.push(seg);
    }

    // Only a genuinely multi-material cut (≥2 colours) gets per-layer fills;
    // ordinary elements stay colourless so existing fill rules apply.
    const multiMaterial = byColor.size > 1;

    const out: DrawingPolygon[] = [];
    for (const groupSegments of byColor.values()) {
      const groupColor = multiMaterial ? groupSegments[0].color : undefined;
      out.push(...this.buildColorGroupPolygons(groupSegments, groupColor));
    }
    return out;
  }

  /**
   * Reconstruct closed polygons from one colour group's segments, stamping the
   * given fill colour (when present) on each result.
   */
  private buildColorGroupPolygons(
    segments: CutSegment[],
    color: [number, number, number, number] | undefined,
  ): DrawingPolygon[] {
    const first = segments[0];
    const { entityId, ifcType, modelIndex } = first;

    // Convert to 2D segments
    const segments2D: Segment2D[] = segments.map((seg) => ({
      start: seg.p0_2d,
      end: seg.p1_2d,
      used: false,
    }));

    // Build closed loops. Multi-material (per-layer) groups additionally STITCH
    // disconnected open band segments at the interface chords (see `buildLoops`).
    const loops = this.buildLoops(segments2D, color !== undefined);

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
      ...(color ? { color } : {}),
    }));
  }

  /**
   * Build closed loops from segments using a greedy chain-building algorithm.
   *
   * `stitchOpen` (multi-material / per-layer groups only): an INTERIOR layer band
   * of a 3+ layer wall has no wall face — its plan section is two disconnected
   * end strips that no single chain can close. Such fragments are collected and
   * stitched end-to-end at the interface chords (`stitchOpenChains`) so the core
   * layer still fills. Chains that close into a non-degenerate loop on their own
   * (a 2-layer U-band, the finish-on-both-faces case) stay separate, preserving
   * existing per-loop behaviour.
   */
  private buildLoops(segments: Segment2D[], stitchOpen: boolean): Loop[] {
    const loops: Loop[] = [];
    const fragments: Point2D[][] = [];

    while (true) {
      const startIdx = segments.findIndex((s) => !s.used);
      if (startIdx === -1) break;

      const chain = this.buildSingleLoop(segments, startIdx);
      if (!chain) continue;

      const standalone =
        chain.points.length >= 3 &&
        (chain.closed || Math.abs(polygonSignedArea(chain.points)) > 1e-9);

      if (standalone) {
        loops.push({ points: chain.points, area: polygonSignedArea(chain.points) });
      } else if (stitchOpen) {
        fragments.push(chain.points); // too short/degenerate to close alone — stitch it
      }
      // else (single-material, sub-loop fragment): dropped, as before.
    }

    if (stitchOpen && fragments.length > 0) {
      loops.push(...this.stitchOpenChains(fragments));
    }

    return loops;
  }

  /**
   * Stitch open band fragments (each a polyline) into closed loops by joining the
   * nearest endpoints ACROSS fragments, only closing a chain on itself once no
   * other fragment is left to attach. Merging across-first is essential: an
   * interior band is thin, so its interface chord (along the wall length) is
   * longer than the band thickness — a naive "close the nearest endpoints" rule
   * would collapse the band instead of spanning it.
   */
  private stitchOpenChains(fragments: Point2D[][]): Loop[] {
    const loops: Loop[] = [];
    const used = new Array(fragments.length).fill(false);

    for (let s = 0; s < fragments.length; s++) {
      if (used[s]) continue;
      let chain = fragments[s].slice();
      used[s] = true;

      // Attach the nearest remaining fragment to the tail until none are left.
      for (;;) {
        const tail = chain[chain.length - 1];
        let best = -1;
        let reverse = false;
        let bestDist = Infinity;
        for (let i = 0; i < fragments.length; i++) {
          if (used[i]) continue;
          const f = fragments[i];
          const dStart = point2DDistance(f[0], tail);
          const dEnd = point2DDistance(f[f.length - 1], tail);
          if (dStart < bestDist) {
            bestDist = dStart;
            best = i;
            reverse = false;
          }
          if (dEnd < bestDist) {
            bestDist = dEnd;
            best = i;
            reverse = true;
          }
        }
        if (best === -1) break;
        used[best] = true;
        const next = reverse ? fragments[best].slice().reverse() : fragments[best].slice();
        if (point2DDistance(chain[chain.length - 1], next[0]) < this.tolerance) next.shift();
        chain = chain.concat(next);
      }

      if (chain.length >= 3 && Math.abs(polygonSignedArea(chain)) > 1e-9) {
        loops.push({ points: chain, area: polygonSignedArea(chain) });
      }
    }

    return loops;
  }

  /**
   * Build a single loop starting from a segment.
   *
   * BIDIRECTIONAL: the chain is extended from BOTH ends (append at the tail,
   * prepend at the head) until neither end finds a connecting segment. A purely
   * forward walk strands segments when it starts mid-chain — fatal for an OPEN
   * contour, which is exactly what a material-layer band is now that the slicer
   * no longer caps the interface planes (the cap was a doubled, non-watertight
   * 3D sheet). A cap-free band's section is a U (outer face + the two end
   * strips); extending from both ends assembles all of it, and the implicit
   * head→tail closing chord of the returned ring IS the interface line the cap
   * used to draw — so per-layer section fills are unchanged. Genuinely closed
   * cross-sections still close here (tail meets head) and return identically.
   */
  private buildSingleLoop(
    segments: Segment2D[],
    startIdx: number,
  ): { points: Point2D[]; closed: boolean } | null {
    const startSeg = segments[startIdx];
    startSeg.used = true;

    const points: Point2D[] = [startSeg.start, startSeg.end];

    const maxIterations = segments.length;
    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      const head = points[0];
      const tail = points[points.length - 1];

      // Closed ring: the tail has come back to the head. Drop the duplicate
      // endpoint and return the closed loop (the pre-existing behaviour).
      if (points.length >= 3 && point2DDistance(tail, head) < this.tolerance) {
        points.pop();
        return { points, closed: true };
      }

      // Prefer extending the tail forward.
      const tailIdx = this.findConnectingSegment(segments, tail);
      if (tailIdx !== -1) {
        const seg = segments[tailIdx];
        seg.used = true;
        const next =
          point2DDistance(seg.start, tail) < this.tolerance ? seg.end : seg.start;
        points.push(next);
        continue;
      }

      // Otherwise extend the head backward.
      const headIdx = this.findConnectingSegment(segments, head);
      if (headIdx !== -1) {
        const seg = segments[headIdx];
        seg.used = true;
        const prev =
          point2DDistance(seg.start, head) < this.tolerance ? seg.end : seg.start;
        points.unshift(prev);
        continue;
      }

      // Neither end extends: an OPEN contour (a cap-free layer band, or genuinely
      // open geometry).
      break;
    }

    return points.length >= 2 ? { points, closed: false } : null;
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
