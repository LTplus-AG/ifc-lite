/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 2D room-footprint geometry helpers shared by `generate-spaces.ts`: offset a
 * detected room's centreline outline to its net (inner) or gross (outer)
 * wall-face boundary, plus the small polygon primitives that offset needs.
 * Split out of `generate-spaces.ts` to keep that file's orchestration logic
 * under the module-size budget — no behavioural change from the move.
 */

import type { Segment, Vec2 } from './auto-space-detect.js';

/** Absolute polygon area (shoelace), m². */
export function polygonArea(pts: Vec2[]): number {
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    acc += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(acc) / 2;
}

/** Ray-cast point-in-polygon test. */
export function pointInPolygon(x: number, y: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Intersection of two lines given as point + unit direction; null if parallel. */
function lineIntersect(
  p0: Vec2, d0: Vec2, p1: Vec2, d1: Vec2,
): Vec2 | null {
  const denom = d0[0] * d1[1] - d0[1] * d1[0];
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p1[0] - p0[0]) * d1[1] - (p1[1] - p0[1]) * d1[0]) / denom;
  return [p0[0] + d0[0] * t, p0[1] + d0[1] * t];
}

/** Does outline edge a→b run along wall segment `seg` (parallel, on its
 *  centreline, overlapping extent)? */
function edgeRunsAlong(a: Vec2, b: Vec2, seg: Segment): boolean {
  const PERP_TOL = 0.2, PARALLEL_TOL = 0.03, OVERLAP_MARGIN = 0.3;
  let ex = b[0] - a[0], ey = b[1] - a[1];
  const el = Math.hypot(ex, ey);
  if (el < 1e-6) return false;
  ex /= el; ey /= el;
  let sx = seg.b[0] - seg.a[0], sy = seg.b[1] - seg.a[1];
  const sl = Math.hypot(sx, sy);
  if (sl < 1e-6) return false;
  sx /= sl; sy /= sl;
  if (Math.abs(ex * sy - ey * sx) > PARALLEL_TOL) return false;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const t = (mx - seg.a[0]) * sx + (my - seg.a[1]) * sy;
  const px = seg.a[0] + sx * t, py = seg.a[1] + sy * t;
  if (Math.hypot(mx - px, my - py) > PERP_TOL) return false;
  return t >= -OVERLAP_MARGIN && t <= sl + OVERLAP_MARGIN;
}

/** How a space boundary relates to its bounding walls. */
export type BoundaryMode = 'center' | 'inner' | 'outer';

/** Drop vertices whose two adjacent edges are collinear (e.g. a T-junction
 *  point left on a straight wall run). Such a vertex makes its two adjacent
 *  offset lines parallel, so they don't intersect — the offset then falls back
 *  to the un-offset centreline point and the corner skews. */
function simplifyCollinear(pts: Vec2[]): Vec2[] {
  const n = pts.length;
  if (n < 4) return pts;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    let ax = c[0] - p[0], ay = c[1] - p[1];
    let bx = q[0] - c[0], by = q[1] - c[1];
    const al = Math.hypot(ax, ay) || 1, bl = Math.hypot(bx, by) || 1;
    ax /= al; ay /= al; bx /= bl; by /= bl;
    if (Math.abs(ax * by - ay * bx) > 1e-4) out.push(c); // keep real corners only
  }
  return out.length >= 3 ? out : pts;
}

/**
 * Offset a (centreline) room outline to the chosen wall boundary: `center` =
 * the centreline as-is; `inner` = each edge shifted toward the room by half the
 * wall thickness (net / inner face); `outer` = shifted away by half (gross /
 * outer face). Re-corners by intersecting adjacent offset edges. `segments[k]`
 * has thickness `wallThicknesses[k]`. `otherRooms` (other rooms' centreline
 * outlines) lets `outer` keep shared/internal edges on the centreline so
 * neighbouring rooms meet there instead of overlapping inside the wall.
 * Returns the original outline if the offset degenerates (e.g. an inner inset
 * of a room thinner than its walls). Exact for orthogonal rooms.
 */
export function offsetRoomFootprint(
  outline: Vec2[],
  segments: Segment[],
  wallThicknesses: ReadonlyArray<number | undefined>,
  mode: BoundaryMode = 'inner',
  otherRooms: Vec2[][] = [],
): Vec2[] {
  if (mode === 'center') return outline;
  const simple = simplifyCollinear(outline);
  const n = simple.length;
  if (n < 3) return outline;
  const sign = mode === 'inner' ? 1 : -1; // inner → inward, outer → outward
  const lines: { p: Vec2; d: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = simple[i];
    const b = simple[(i + 1) % n];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-6) return outline;
    dx /= l; dy /= l;
    let half = 0; // half the thickest wall this edge runs along
    for (let k = 0; k < segments.length; k++) {
      const t = wallThicknesses[k];
      if (t !== undefined && t / 2 > half && edgeRunsAlong(a, b, segments[k])) half = t / 2;
    }
    let off = sign * half;
    // A shared (internal) edge has another room on its OUTWARD side. Pushing it
    // outward (outer mode) would overlap that room, so pin shared edges to the
    // centreline; only edges facing outside the building actually push out.
    if (mode === 'outer' && half > 0 && otherRooms.length) {
      const mx = (a[0] + b[0]) / 2 + dy * 0.1; // outward = right normal (dy, -dx)
      const my = (a[1] + b[1]) / 2 - dx * 0.1;
      if (otherRooms.some((poly) => pointInPolygon(mx, my, poly))) off = 0;
    }
    // Inward normal of a CCW outline is to the left of a→b: (-dy, dx).
    lines.push({ p: [a[0] - dy * off, a[1] + dx * off], d: [dx, dy] });
  }
  const verts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i - 1 + n) % n];
    const cur = lines[i];
    verts.push(lineIntersect(prev.p, prev.d, cur.p, cur.d) ?? simple[i]);
  }
  if (!verts.every((v) => Number.isFinite(v[0]) && Number.isFinite(v[1]))) return outline;
  const gross = polygonArea(simple);
  const got = polygonArea(verts);
  if (got <= 1e-6) return outline;
  if (mode === 'inner' && got > gross + 1e-6) return outline; // inset inverted
  return verts;
}
