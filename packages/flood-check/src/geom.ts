/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Planar helpers over footprint rings in map coordinates. */

import type { MapBBox, MapPoint } from './types.js';

/** Even-odd point-in-ring test. */
export function insideRing(p: MapPoint, ring: readonly MapPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * A point inside ANY ring is inside the footprint: rings may overlap (several
 * slabs), and even-odd across rings would turn an overlap into "outside" and
 * accept samples inside the building. So a courtyard drawn as its own ring is
 * filled; see {@link nestedRings}.
 */
export function insideAny(p: MapPoint, rings: readonly (readonly MapPoint[])[]): boolean {
  return rings.some((ring) => insideRing(p, ring));
}

/**
 * Indices of courtyard rings: a ring whose whole boundary lies inside the
 * union of the other rings (its edges, sampled every 0.25 m, not only its
 * vertices, so a slab that spans a notch between two others is not taken for
 * one). {@link insideAny} fills such a ring; the outline functions below treat
 * it as open ground, a hole of the footprint.
 */
export function nestedRings(rings: readonly (readonly MapPoint[])[]): Set<number> {
  const out = new Set<number>();
  rings.forEach((ring, j) => {
    const others = rings.filter((_, i) => i !== j);
    if (ring.length < 3 || others.length === 0) return;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.25));
      for (let k = 0; k < steps; k++) {
        if (!insideAny({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps }, others)) return;
      }
    }
    out.add(j);
  });
  return out;
}

function closestOnSegment(p: MapPoint, a: MapPoint, b: MapPoint): MapPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** The closest point on any ring's boundary, its distance and the index of that ring. */
export function closestBoundaryPoint(
  p: MapPoint,
  rings: readonly (readonly MapPoint[])[],
): { point: MapPoint; distance: number; ring: number } | null {
  let best: { point: MapPoint; distance: number; ring: number } | null = null;
  rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) {
      const q = closestOnSegment(p, ring[i], ring[(i + 1) % ring.length]);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.distance) best = { point: q, distance: d, ring: r };
    }
  });
  return best;
}

/**
 * A boundary point is footprint OUTLINE only if open ground reaches beyond
 * it: some disc of radius `OUTLINE_CLEARANCE` centred `OUTLINE_PROBE` from it
 * lies outside the building (courtyard rings count as open ground). So the
 * seam between adjacent slabs, and a gap between slabs narrower than about
 * 0.9 m (under an interior wall), are inside; a passage or courtyard 1 m wide
 * or wider is outside. One rule for anchor, courtyard guard and façade test.
 */
export const OUTLINE_PROBE = 0.55;
export const OUTLINE_CLEARANCE = 0.38;

type Rings = readonly (readonly MapPoint[])[];

/** Inside the building: inside a ring that is not a courtyard and inside no courtyard ring. */
function solid(p: MapPoint, rings: Rings, courtyards: ReadonlySet<number>): boolean {
  let inBuilding = false;
  for (let i = 0; i < rings.length; i++) {
    if (!insideRing(p, rings[i])) continue;
    if (courtyards.has(i)) return false;
    inBuilding = true;
  }
  return inBuilding;
}

const unit = (x: number, y: number) => {
  const l = Math.hypot(x, y);
  return l > 0 ? { x: x / l, y: y / l } : null;
};

/** Open ground reaches beyond `q`, a point of ring `r`'s segment `i` (see {@link OUTLINE_PROBE}). */
function isOutline(q: MapPoint, rings: Rings, courtyards: ReadonlySet<number>, r: number, i: number): boolean {
  const ring = rings[r];
  const normalOf = (k: number) => {
    const a = ring[(k + ring.length) % ring.length];
    const b = ring[(k + 1) % ring.length];
    return unit(b.y - a.y, -(b.x - a.x));
  };
  const dirs: Array<{ x: number; y: number } | null> = [];
  const n = normalOf(i);
  dirs.push(n, n && { x: -n.x, y: -n.y });
  // At a vertex, the neighbouring segment's normal and the bisector (a convex or a reflex corner).
  const a = ring[i];
  const b = ring[(i + 1) % ring.length];
  const at = Math.hypot(q.x - a.x, q.y - a.y) < 1e-9 ? i - 1 : Math.hypot(q.x - b.x, q.y - b.y) < 1e-9 ? i + 1 : null;
  if (at !== null && n) {
    const m = normalOf(at);
    if (m) {
      const bis = unit(n.x + m.x, n.y + m.y);
      dirs.push(m, { x: -m.x, y: -m.y }, bis, bis && { x: -bis.x, y: -bis.y });
    }
  }
  for (let k = 0; k < 16; k++) dirs.push({ x: Math.cos((2 * Math.PI * k) / 16), y: Math.sin((2 * Math.PI * k) / 16) });
  // The ground must be open right from `q` to the disc (not across a strip of building into a courtyard behind it).
  const openPath = (u: { x: number; y: number }) => {
    for (let t = 0.01; t < OUTLINE_PROBE; t += 0.05) if (solid({ x: q.x + t * u.x, y: q.y + t * u.y }, rings, courtyards)) return false;
    return true;
  };
  for (const u of dirs) {
    if (!u) continue;
    const c = { x: q.x + OUTLINE_PROBE * u.x, y: q.y + OUTLINE_PROBE * u.y };
    if (!solid(c, rings, courtyards) && (closestBoundaryPoint(c, rings)?.distance ?? Infinity) >= OUTLINE_CLEARANCE && openPath(u)) return true;
  }
  return false;
}

/**
 * The closest point of the footprint's true outline ({@link OUTLINE_PROBE}):
 * along each segment, the closest point and then points further along it,
 * every 0.25 m, until one is outline or none can be closer than the best.
 * Falls back to the closest boundary point when no outline point exists.
 */
export function closestOutlinePoint(
  p: MapPoint,
  rings: Rings,
  courtyards: ReadonlySet<number> = nestedRings(rings),
): { point: MapPoint; distance: number; ring: number } | null {
  let best: { point: MapPoint; distance: number; ring: number } | null = null;
  rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const q0 = closestOnSegment(p, a, b);
      const t0 = len > 0 ? Math.hypot(q0.x - a.x, q0.y - a.y) : 0;
      // Distances along the segment from the closest point outwards, both ways, ending at the vertices.
      const ts = [t0];
      for (let s = 0.25; t0 - s > 0 || t0 + s < len; s += 0.25) {
        if (t0 + s < len) ts.push(t0 + s);
        if (t0 - s > 0) ts.push(t0 - s);
      }
      ts.push(0, len);
      const cands = ts
        .map((t) => (len > 0 ? { x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len } : a))
        .map((q) => ({ q, d: Math.hypot(q.x - p.x, q.y - p.y) }))
        .sort((u, v) => u.d - v.d);
      for (const { q, d } of cands) {
        if (best && d >= best.distance) break;
        if (isOutline(q, rings, courtyards, r, i)) {
          best = { point: q, distance: d, ring: r };
          break;
        }
      }
    }
  });
  return best ?? closestBoundaryPoint(p, rings);
}

/**
 * Signed distance to the footprint's true outline: negative inside the
 * building, including a gap between slabs too narrow to be open ground and
 * the seam between them, positive outside. Infinity when there are no rings.
 */
export function outlineDistance(p: MapPoint, rings: Rings, courtyards: ReadonlySet<number> = nestedRings(rings)): number {
  const c = closestBoundaryPoint(p, rings);
  if (!c) return Infinity;
  if (!insideAny(p, rings)) {
    if (c.distance >= OUTLINE_CLEARANCE) return c.distance;
    const ring = rings[c.ring];
    let seg = 0;
    let bestSeg = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const q = closestOnSegment(p, ring[i], ring[(i + 1) % ring.length]);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestSeg) [bestSeg, seg] = [d, i];
    }
    if (isOutline(c.point, rings, courtyards, c.ring, seg)) return c.distance;
  }
  return -(closestOutlinePoint(p, rings, courtyards)?.distance ?? c.distance);
}

/** Boundary stretches facing a gap closed by {@link outlineDistance} (sampled at segment midpoints). */
export function closedGaps(rings: Rings, courtyards: ReadonlySet<number> = nestedRings(rings)): number {
  let n = 0;
  rings.forEach((ring, r) => {
    if (courtyards.has(r)) return;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const u = unit(b.y - a.y, -(b.x - a.x));
      if (!u) continue;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      for (const sgn of [1, -1]) {
        const p = { x: m.x + sgn * 0.01 * u.x, y: m.y + sgn * 0.01 * u.y };
        if (!insideAny(p, rings) && outlineDistance(p, rings, courtyards) < 0) n++;
      }
    }
  });
  return n;
}

/**
 * Signed distance to the footprint: positive outside, negative inside, in
 * metres. Infinity when there are no rings.
 */
export function signedDistance(p: MapPoint, rings: readonly (readonly MapPoint[])[]): number {
  const c = closestBoundaryPoint(p, rings);
  if (!c) return Infinity;
  return insideAny(p, rings) ? -c.distance : c.distance;
}

export function ringArea(ring: readonly MapPoint[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  return Math.abs(s) / 2;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, without the closing point. */
export function convexHull(points: readonly MapPoint[]): MapPoint[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const turn = (o: MapPoint, a: MapPoint, b: MapPoint) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: MapPoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: MapPoint[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function bboxOf(points: Iterable<MapPoint>): MapBBox | null {
  let box: MapBBox | null = null;
  for (const p of points) {
    if (!box) box = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
    else {
      box.minX = Math.min(box.minX, p.x);
      box.minY = Math.min(box.minY, p.y);
      box.maxX = Math.max(box.maxX, p.x);
      box.maxY = Math.max(box.maxY, p.y);
    }
  }
  return box;
}

export function expandBBox(box: MapBBox, by: number): MapBBox {
  return { minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by };
}

/**
 * Join polylines end to end into ONE closed ring, matching endpoints within
 * `tolerance`. Null unless every polyline is used and the chain closes (a
 * T-junction, a gap or two separate loops all give null).
 */
export function chainIntoRing(polylines: readonly (readonly MapPoint[])[], tolerance: number): MapPoint[] | null {
  const lines = polylines.filter((l) => l.length >= 2);
  if (lines.length < 3) return null;
  const near = (a: MapPoint, b: MapPoint) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
  const used = new Uint8Array(lines.length);
  const ring: MapPoint[] = [...lines[0]];
  used[0] = 1;
  for (let placed = 1; placed < lines.length; placed++) {
    const end = ring[ring.length - 1];
    let next = -1;
    let reversed = false;
    for (let i = 0; i < lines.length && next < 0; i++) {
      if (used[i]) continue;
      if (near(lines[i][0], end)) next = i;
      else if (near(lines[i][lines[i].length - 1], end)) {
        next = i;
        reversed = true;
      }
    }
    if (next < 0) return null;
    used[next] = 1;
    const pts = reversed ? [...lines[next]].reverse() : lines[next];
    ring.push(...pts.slice(1));
  }
  if (!near(ring[ring.length - 1], ring[0])) return null;
  ring.pop();
  return ring.length >= 3 ? ring : null;
}
