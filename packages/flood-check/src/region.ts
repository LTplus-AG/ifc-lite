/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The building's footprint as ONE prepared object: its rings, its courtyards
 * as holes, and one rule for which boundary is outline. Every question asked
 * of the footprint (inside, signed distance, closest outline point, the
 * courtyard guard, closed gaps) is a function of this object, so no two
 * callers can hold different ideas of where the building is. Raw rings are
 * not queried anywhere else.
 *
 * Outline: a boundary point is outline only if open ground reaches beyond it,
 * a disc of radius `OUTLINE_CLEARANCE` centred `OUTLINE_PROBE` from it,
 * outside the building, with open ground all the way to it. So the seam where
 * two slabs meet, and a gap between slabs narrower than about 0.9 m, are
 * inside the building; a passage or courtyard 1 m wide or wider is outside.
 *
 * Courtyards: a footprint the caller gives draws a hole as its own ring (a
 * ring whose whole boundary lies inside the union of the others); a slab
 * outline lists the holes of its profiles that no slab above covers
 * (`courtyardRings`). Otherwise slab outlines and wall loops are material, so
 * a ring within the others there is a slab on or within another, never open
 * ground. A courtyard ring enclosing less than 1 m² is below the closing
 * scale and stays closed.
 */

import { closestBoundaryPoint, insideRing, ringArea } from './geom.js';
import type { MapPoint } from './types.js';

export const OUTLINE_PROBE = 0.55;
export const OUTLINE_CLEARANCE = 0.38;

type Rings = readonly (readonly MapPoint[])[];

export interface PreparedFootprint {
  readonly rings: Rings;
  /** Rings that are holes: open ground everywhere. */
  readonly courtyards: ReadonlySet<number>;
  /** Inner rings of a given footprint enclosing less than 1 m²: below the closing scale, so closed. */
  readonly closedSmallRings: readonly number[];
}

/** Rings whose whole boundary (edges sampled every 0.25 m, not only vertices) lies inside the union of the others. */
function nestedRings(rings: Rings): Set<number> {
  const out = new Set<number>();
  rings.forEach((ring, j) => {
    const others = rings.filter((_, i) => i !== j);
    if (ring.length < 3 || others.length === 0) return;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.25));
      for (let k = 0; k < steps; k++) {
        const p = { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps };
        if (!others.some((o) => insideRing(p, o))) return;
      }
    }
    out.add(j);
  });
  return out;
}

/** Prepare a footprint once; build it again whenever its rings change (facts are plain data). */
export function prepareFootprint(footprint: { rings: Rings; source: string; courtyardRings?: readonly number[] }): PreparedFootprint {
  const courtyards = new Set<number>();
  const closedSmallRings: number[] = [];
  // A slab outline's holes open to the sky, found by the reader (`footprint.ts`), 1 m² or more like a given courtyard.
  for (const r of footprint.courtyardRings ?? []) if (footprint.rings[r] && ringArea(footprint.rings[r]) >= 1) courtyards.add(r);
  if (footprint.source === 'given') {
    for (const r of nestedRings(footprint.rings)) {
      if (ringArea(footprint.rings[r]) >= 1) courtyards.add(r);
      else closedSmallRings.push(r);
    }
  }
  return { rings: footprint.rings, courtyards, closedSmallRings };
}

export function hasRings(fp: PreparedFootprint): boolean {
  return fp.rings.length > 0;
}

/** Inside a ring that is not a courtyard and inside no courtyard ring. */
function solid(fp: PreparedFootprint, p: MapPoint): boolean {
  let inBuilding = false;
  for (let i = 0; i < fp.rings.length; i++) {
    if (!insideRing(p, fp.rings[i])) continue;
    if (fp.courtyards.has(i)) return false;
    inBuilding = true;
  }
  return inBuilding;
}

const unit = (x: number, y: number) => {
  const l = Math.hypot(x, y);
  return l > 0 ? { x: x / l, y: y / l } : null;
};

/** Open ground reaches beyond `q`, a point of ring `r`'s segment `i`. */
function isOutline(fp: PreparedFootprint, q: MapPoint, r: number, i: number): boolean {
  const ring = fp.rings[r];
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
    for (let t = 0.01; t < OUTLINE_PROBE; t += 0.05) if (solid(fp, { x: q.x + t * u.x, y: q.y + t * u.y })) return false;
    return true;
  };
  for (const u of dirs) {
    if (!u) continue;
    const c = { x: q.x + OUTLINE_PROBE * u.x, y: q.y + OUTLINE_PROBE * u.y };
    if (!solid(fp, c) && (closestBoundaryPoint(c, fp.rings)?.distance ?? Infinity) >= OUTLINE_CLEARANCE && openPath(u)) return true;
  }
  return false;
}

/** The segment of ring `r` closest to `p`. */
function closestSegment(fp: PreparedFootprint, p: MapPoint, r: number): number {
  const ring = fp.rings[r];
  let seg = 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
    if (d < best) [best, seg] = [d, i];
  }
  return seg;
}

/**
 * Inside the building: in a ring that is not a courtyard, or in a seam or a
 * gap between rings too narrow to be open ground. The one inside test.
 */
export function insideFootprint(fp: PreparedFootprint, p: MapPoint): boolean {
  if (solid(fp, p)) return true;
  const c = closestBoundaryPoint(p, fp.rings);
  if (!c || c.distance >= OUTLINE_CLEARANCE) return false;
  return !isOutline(fp, c.point, c.ring, closestSegment(fp, c.point, c.ring));
}

/**
 * The closest point of the true outline: along each segment, the closest
 * point and then points further along it, every 0.25 m, until one is outline
 * or none can be closer than the best. Falls back to the closest boundary
 * point when no outline point exists.
 */
export function closestOutlinePoint(fp: PreparedFootprint, p: MapPoint): { point: MapPoint; distance: number; ring: number } | null {
  let best: { point: MapPoint; distance: number; ring: number } | null = null;
  fp.rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const t0 = len > 0 ? Math.max(0, Math.min(len, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len)) : 0;
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
        if (isOutline(fp, q, r, i)) {
          best = { point: q, distance: d, ring: r };
          break;
        }
      }
    }
  });
  return best ?? closestBoundaryPoint(p, fp.rings);
}

/**
 * Signed distance to the true outline, metres: negative inside the building
 * ({@link insideFootprint}), the distance to the closest outline point; positive
 * outside, the distance to the closest boundary. `null` with no rings: inside
 * and outside are then unknown, never "infinitely far outside".
 */
export function signedDistance(fp: PreparedFootprint, p: MapPoint): number | null {
  const c = closestBoundaryPoint(p, fp.rings);
  if (!c) return null;
  if (!insideFootprint(fp, p)) return c.distance;
  return -(closestOutlinePoint(fp, p)?.distance ?? c.distance);
}

/**
 * At least `min` metres outside the building (`min` ≥ 1 m, so no gap rule is
 * involved): `signedDistance(fp, p) >= min` without the inside magnitude.
 * `null` with no rings: inside and outside are unknown, as for
 * `signedDistance`; the caller decides what that means for it.
 */
export function outsideBy(fp: PreparedFootprint, p: MapPoint, min: number): boolean | null {
  if (!(min >= OUTLINE_CLEARANCE)) throw new RangeError(`outsideBy needs min >= ${OUTLINE_CLEARANCE} m, got ${min}`);
  if (!hasRings(fp)) return null;
  if (solid(fp, p)) return false;
  return (closestBoundaryPoint(p, fp.rings)?.distance ?? Infinity) >= min;
}

/** The ring the closest boundary point of `p` lies on (a seam included), or undefined with no rings. */
export function nearestRing(fp: PreparedFootprint, p: MapPoint): number | undefined {
  return closestBoundaryPoint(p, fp.rings)?.ring;
}

/** Boundary stretches facing a gap closed as inside (sampled at segment midpoints, both sides). */
export function closedGaps(fp: PreparedFootprint): number {
  let n = 0;
  fp.rings.forEach((ring, r) => {
    if (fp.courtyards.has(r)) return;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const u = unit(b.y - a.y, -(b.x - a.x));
      if (!u) continue;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      for (const sgn of [1, -1]) {
        const p = { x: m.x + sgn * 0.01 * u.x, y: m.y + sgn * 0.01 * u.y };
        if (!solid(fp, p) && insideFootprint(fp, p)) n++;
      }
    }
  });
  return n;
}
