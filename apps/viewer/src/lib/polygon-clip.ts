/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 2D polygon half-plane clipping. Used by slab / roof / plate /
 * space split to divide a footprint polygon into two halves by a
 * cut line.
 *
 * The cut line is defined by two points in the polygon's local
 * plane. We derive the line's normal (rotated 90° CCW from the
 * direction) and use it to assign each polygon vertex to one of
 * the two half-planes. Sutherland-Hodgman-style edge walk
 * produces the clipped polygon for each side; the union of the
 * two output polygons reconstructs the input (minus any sliver
 * vertices that landed exactly on the cut line, which both halves
 * include as boundary).
 *
 * Returns:
 *
 *   - `{ ok: true, left, right }` when the cut intersects the
 *     polygon and both halves have ≥ 3 vertices (a valid polygon).
 *   - `{ ok: false, reason }` when the cut misses the polygon, is
 *     tangent to a single vertex, or produces a degenerate sliver
 *     (< 3 vertices on either side).
 *
 * "Left" / "right" naming follows the cut-line direction: walking
 * from A to B, "left" is the half-plane on the user's left
 * (positive cross product of (B-A) with (vertex-A)).
 */

export type Point2D = [number, number];

export type PolygonClipResult =
  | { ok: true; left: Point2D[]; right: Point2D[] }
  | { ok: false; reason: string };

const EPS = 1e-9;

/**
 * Signed perpendicular distance of `p` to the directed line through
 * `a → b`. Positive means `p` is to the LEFT of A→B in standard
 * math coords (y-up) — i.e. the side reached by rotating the A→B
 * direction 90° counter-clockwise.
 */
function signedDistance(a: Point2D, b: Point2D, p: Point2D): number {
  // Standard 2D cross product (b - a) × (p - a).
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

/**
 * Linear interpolation between two polygon vertices at the cut line.
 * `da`, `db` are signed distances of `a` and `b` from the line; the
 * intersection sits where the signed distance crosses zero.
 */
function intersectEdge(a: Point2D, b: Point2D, da: number, db: number): Point2D {
  const t = da / (da - db); // never 0/0 because callers ensure signs differ
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/**
 * Clip a polygon to one side of the cut line. `keep` selects which
 * side to retain: `'positive'` keeps vertices with signed distance
 * > 0 (left of A→B); `'negative'` keeps vertices with signed
 * distance < 0 (right). On-line vertices (|d| < EPS) belong to
 * both halves and are emitted unchanged.
 *
 * Standard Sutherland-Hodgman: walk each edge of the input polygon,
 * decide whether to emit the current vertex and/or an intersection
 * with the cut line based on which side current and previous
 * vertices are on.
 */
function clipPolygonHalfPlane(
  polygon: Point2D[],
  a: Point2D,
  b: Point2D,
  keep: 'positive' | 'negative',
): Point2D[] {
  if (polygon.length === 0) return [];
  const out: Point2D[] = [];
  const sign = keep === 'positive' ? 1 : -1;
  const pushUnique = (p: Point2D) => {
    // Skip duplicate emits — the on-line edge case (prev outside,
    // curr on the line) would otherwise emit the intersection AND
    // curr, which are the same point. Cheap O(1) check against the
    // most recent vertex; the polygon body itself is allowed to
    // have repeated adjacent vertices in pathological input but we
    // don't want to manufacture them.
    if (out.length > 0) {
      const last = out[out.length - 1];
      if (Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) return;
    }
    out.push(p);
  };

  let prev = polygon[polygon.length - 1];
  let prevD = signedDistance(a, b, prev) * sign;
  for (const curr of polygon) {
    const currD = signedDistance(a, b, curr) * sign;
    if (currD >= -EPS) {
      // Current vertex is inside (or on the line).
      if (prevD < -EPS) {
        // Crossing into the half-plane — emit the intersection.
        pushUnique(intersectEdge(prev, curr, prevD, currD));
      }
      pushUnique(curr);
    } else if (prevD >= -EPS) {
      // Crossing out of the half-plane — emit the intersection.
      pushUnique(intersectEdge(prev, curr, prevD, currD));
    }
    // Else both outside — skip.
    prev = curr;
    prevD = currD;
  }
  // The pushUnique guard runs against the previous push; the
  // wrap-around (last vs first) can also produce a dup when the
  // polygon closes on a near-coincident pair. Trim once.
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.abs(last[0] - first[0]) < EPS && Math.abs(last[1] - first[1]) < EPS) {
      out.pop();
    }
  }
  return out;
}

/**
 * Split a polygon into two halves by a cut line.
 *
 * Inputs:
 *   - `polygon` — outer curve as an ordered list of 2D vertices
 *     (CW or CCW; the algorithm is orientation-independent).
 *     First vertex should NOT repeat at the end.
 *   - `a`, `b` — two points defining the cut line. The line
 *     extends infinitely in both directions through these points,
 *     so the user-clicked endpoints don't need to lie on the
 *     polygon edge.
 *
 * Returns `{ ok: true, left, right }` when both halves are valid
 * polygons (≥ 3 vertices). Otherwise returns `{ ok: false, reason }`.
 */
export function clipPolygonByLine(
  polygon: Point2D[],
  a: Point2D,
  b: Point2D,
): PolygonClipResult {
  if (polygon.length < 3) {
    return { ok: false, reason: 'Polygon must have at least 3 vertices' };
  }
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (Math.hypot(dx, dy) < EPS) {
    return { ok: false, reason: 'Cut endpoints are coincident' };
  }

  // Count how many vertices land strictly on each side. If all
  // vertices are on one side, the cut line misses the polygon.
  let pos = 0;
  let neg = 0;
  for (const p of polygon) {
    const d = signedDistance(a, b, p);
    if (d > EPS) pos++;
    else if (d < -EPS) neg++;
  }
  if (pos === 0 || neg === 0) {
    return { ok: false, reason: 'Cut line does not cross the polygon' };
  }

  const left = clipPolygonHalfPlane(polygon, a, b, 'positive');
  const right = clipPolygonHalfPlane(polygon, a, b, 'negative');

  if (left.length < 3 || right.length < 3) {
    return { ok: false, reason: 'Cut produces a degenerate half (< 3 vertices)' };
  }

  return { ok: true, left, right };
}

/**
 * Test helper: is `p` strictly inside `polygon` (ray-cast). Used by
 * the slab-split tool to figure out which half the user clicked on
 * after committing the cut, so we can move selection to that half.
 */
export function pointInPolygon(polygon: Point2D[], p: Point2D): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  let j = polygon.length - 1;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects =
      (a[1] > p[1]) !== (b[1] > p[1]) &&
      p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] + EPS) + a[0];
    if (intersects) inside = !inside;
    j = i;
  }
  return inside;
}
