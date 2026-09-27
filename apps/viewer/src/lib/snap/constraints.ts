/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Constraint set of the snap engine: turns the typed locks / modifiers of a
 * query into one locus (typed length → circle, angle → ray, axis/ortho → line,
 * two of them → point) and projects points and candidates onto it.
 *
 * Generalises the Space Sketch `snapAlongOrtho`: under a linear lock a point
 * target aligns ALONG the lock (orthogonal projection) and an edge target
 * snaps to where the lock crosses it. The result can never leave the lock.
 */

import type { CollectHint, Guide, Locus, SnapCandidate, SnapProfile, SnapQuery, Vec2 } from './types.js';

export type { Locus };

const FREE: Locus = { kind: 'free' };
const DEG = Math.PI / 180;

export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const dot = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0];
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Unit direction at `deg`, exact for multiples of 90°. */
export function unitAt(deg: number): Vec2 {
  const r = ((deg % 360) + 360) % 360;
  if (r === 0) return [1, 0];
  if (r === 90) return [0, 1];
  if (r === 180) return [-1, 0];
  if (r === 270) return [0, -1];
  return [Math.cos(r * DEG), Math.sin(r * DEG)];
}

/** Direction from `anchor` towards `cursor`, quantised to `stepDeg`. 90° uses the Space Sketch |dx| ≥ |dy| rule. */
function quantisedDir(cursor: Vec2, anchor: Vec2, stepDeg: number): Vec2 {
  const dx = cursor[0] - anchor[0];
  const dy = cursor[1] - anchor[1];
  if (stepDeg === 90) return Math.abs(dx) >= Math.abs(dy) ? [1, 0] : [0, 1];
  const deg = Math.atan2(dy, dx) / DEG;
  return unitAt(Math.round(deg / stepDeg) * stepDeg);
}

/** The single locus the query's locks constrain the result to. */
export function buildLocus(q: SnapQuery, p: SnapProfile): Locus {
  const a = q.anchor;
  if (!a) return FREE;
  const { length, angleDeg, axis } = q.locks;
  const hasLength = length !== undefined && Number.isFinite(length) && length >= 0;
  let dir: Vec2 | null = null;
  let ray = false;
  if (angleDeg !== undefined && Number.isFinite(angleDeg)) {
    dir = unitAt(angleDeg);
    ray = true;
  } else if (axis) {
    dir = axis === 'u' ? [1, 0] : [0, 1];
  } else if (q.modifiers.shift) {
    const step = p.angleStepDeg ?? 90;
    dir = quantisedDir(q.cursor, a, step > 0 ? step : 90);
  }
  if (dir && hasLength) {
    // A linear lock is two-sided: take the side the cursor is on.
    const s = ray || dot(sub(q.cursor, a), dir) >= 0 ? 1 : -1;
    return { kind: 'point', p: [a[0] + s * length * dir[0], a[1] + s * length * dir[1]] };
  }
  if (dir) return ray ? { kind: 'ray', origin: a, dir } : { kind: 'line', origin: a, dir };
  if (hasLength) return length === 0 ? { kind: 'point', p: a } : { kind: 'circle', center: a, radius: length };
  return FREE;
}

/** Closest point of the locus to `p`. Axis-aligned lines keep the pinned coordinate exact. */
export function projectOntoLocus(p: Vec2, l: Locus): Vec2 {
  switch (l.kind) {
    case 'free':
      return p;
    case 'point':
      return l.p;
    case 'line':
    case 'ray': {
      const { origin: o, dir: d } = l;
      if (d[1] === 0 && l.kind === 'line') return [p[0], o[1]];
      if (d[0] === 0 && l.kind === 'line') return [o[0], p[1]];
      let t = dot(sub(p, o), d) / dot(d, d);
      if (l.kind === 'ray' && t < 0) t = 0;
      return [o[0] + t * d[0], o[1] + t * d[1]];
    }
    case 'circle': {
      const v = sub(p, l.center);
      const len = Math.hypot(v[0], v[1]);
      if (len === 0) return [l.center[0] + l.radius, l.center[1]];
      return [l.center[0] + (v[0] * l.radius) / len, l.center[1] + (v[1] * l.radius) / len];
    }
  }
}

/** Distance from `p` to the locus (0 for free). */
export function distanceToLocus(p: Vec2, l: Locus): number {
  return dist(p, projectOntoLocus(p, l));
}

/** The lock drawn as a guide (none when free). */
export function locusGuides(l: Locus): Guide[] {
  switch (l.kind) {
    case 'line':
    case 'ray':
      return [{ kind: l.kind, origin: l.origin, dir: l.dir, role: 'lock' }];
    case 'circle':
      return [{ kind: 'circle', center: l.center, radius: l.radius, role: 'lock' }];
    default:
      return [];
  }
}

/** Parametric form of a linear guide or locus: o + t·d with t ∈ [lo, hi]. */
interface Linear { o: Vec2; d: Vec2; lo: number; hi: number }

const PARAM_EPS = 1e-12;

export function toLinear(g: Guide | Locus): Linear | null {
  switch (g.kind) {
    case 'segment':
      return { o: g.a, d: sub(g.b, g.a), lo: 0, hi: 1 };
    case 'line':
      return { o: g.origin, d: g.dir, lo: -Infinity, hi: Infinity };
    case 'ray':
      return { o: g.origin, d: g.dir, lo: 0, hi: Infinity };
    default:
      return null;
  }
}

const inRange = (t: number, l: Linear): boolean => t >= l.lo - PARAM_EPS && t <= l.hi + PARAM_EPS;

/** Point of `a` where it crosses `b`, or null (parallel, or outside either range). Computed on `a`'s parameter. */
export function intersectLinear(a: Linear, b: Linear): Vec2 | null {
  const den = cross(a.d, b.d);
  const scale = Math.hypot(a.d[0], a.d[1]) * Math.hypot(b.d[0], b.d[1]);
  if (scale === 0 || Math.abs(den) <= 1e-12 * scale) return null;
  const w = sub(b.o, a.o);
  const t = cross(w, b.d) / den;
  const u = cross(w, a.d) / den;
  if (!inRange(t, a) || !inRange(u, b)) return null;
  return [a.o[0] + t * a.d[0], a.o[1] + t * a.d[1]];
}

/** Parameters where a linear element meets a circle, within its range. */
function linearCircleParams(l: Linear, center: Vec2, radius: number): number[] {
  const w = sub(l.o, center);
  const A = dot(l.d, l.d);
  if (A === 0) return [];
  const B = 2 * dot(w, l.d);
  const C = dot(w, w) - radius * radius;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const roots = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return roots.filter((t) => inRange(t, l));
}

const at = (l: Linear, t: number): Vec2 => [l.o[0] + t * l.d[0], l.o[1] + t * l.d[1]];

/**
 * An axis-aligned line lock crossing a linear guide, solved on the GUIDE's
 * parameter: the fixed coordinate is the lock's exactly, and the free one is
 * interpolated along the guide, so an axis-aligned guide yields its own
 * coordinate bit-for-bit (the `snapAlongOrtho` formula).
 */
function crossAxisLine(l: Extract<Locus, { kind: 'line' }>, g: Linear): Vec2[] {
  const fixed = l.dir[1] === 0 ? 1 : 0;
  const free = 1 - fixed;
  const den = g.d[fixed];
  if (Math.abs(den) <= 1e-12 * Math.hypot(g.d[0], g.d[1])) return [];
  const u = (l.origin[fixed] - g.o[fixed]) / den;
  if (!inRange(u, g)) return [];
  const f = g.o[free] + u * g.d[free];
  return [fixed === 1 ? [f, l.origin[1]] : [l.origin[0], f]];
}

/** All points where the locus meets a guide. Points are computed on the locus so they stay on it. */
export function intersectLocusWithGuide(l: Locus, g: Guide): Vec2[] {
  const gl = toLinear(g);
  if (l.kind === 'line' && gl && (l.dir[0] === 0 || l.dir[1] === 0)) return crossAxisLine(l, gl);
  if (l.kind === 'line' || l.kind === 'ray') {
    const ll = toLinear(l);
    if (!ll) return [];
    if (gl) {
      const p = intersectLinear(ll, gl);
      return p ? [p] : [];
    }
    if (g.kind === 'circle') return linearCircleParams(ll, g.center, g.radius).map((t) => at(ll, t));
    return [];
  }
  if (l.kind === 'circle' && gl) {
    return linearCircleParams(gl, l.center, l.radius).map((t) => projectOntoLocus(at(gl, t), l));
  }
  return [];
}

/** Kinds whose target is a curve (slid along its guide under a lock) rather than a point. */
const EDGE_LIKE = new Set<SnapCandidate['kind']>(['edge', 'extension', 'parallel']);

/**
 * Where a candidate lands on the locus, or null when it cannot (an edge
 * parallel to the lock, or not crossing it). Point targets project
 * orthogonally (alignment); edge targets land where the lock crosses them,
 * nearest `ref` (the cursor already projected onto the locus).
 */
export function projectCandidate(c: SnapCandidate, l: Locus, ref: Vec2): Vec2 | null {
  if (l.kind === 'free') return c.local;
  if (l.kind === 'point') return l.p;
  if (!EDGE_LIKE.has(c.kind) || !c.guide) return projectOntoLocus(c.local, l);
  const hits = intersectLocusWithGuide(l, c.guide);
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const h of hits) {
    const d = dist(h, ref);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

/**
 * Cheap SUPERSET test for source-side pruning: can a point target at `p`, or
 * an edge target on segment a→b, land within `radius` of the constrained
 * cursor? Never false for a target the solver would accept; may be true for
 * one it rejects. Scalar only, no allocation.
 */
export function mayLandNear(h: CollectHint, radius: number, a: Vec2, b?: Vec2): boolean {
  const l = h.locus;
  const cx = h.cursor[0], cy = h.cursor[1];
  // Slack so this sqrt-based test never rejects what the solver's hypot accepts at the boundary.
  const r = radius * (1 + 1e-9);
  if (l.kind === 'free') {
    let px = a[0], py = a[1];
    if (b) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cy - a[1]) * dy) / len2));
      px += t * dx;
      py += t * dy;
    }
    return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= r * r;
  }
  if (l.kind !== 'line' && l.kind !== 'ray') return l.kind !== 'point';
  // Along a linear lock a point target lands at its projection; an edge lands
  // where it crosses the lock, between its ends' projections.
  const dx = l.dir[0], dy = l.dir[1];
  const n = Math.sqrt(dx * dx + dy * dy);
  const sa = ((a[0] - cx) * dx + (a[1] - cy) * dy) / n;
  if (!b) return Math.abs(sa) <= r || (l.kind === 'ray' && sa < 0);
  const ox = l.origin[0], oy = l.origin[1];
  const pa = (a[0] - ox) * dy - (a[1] - oy) * dx;
  const pb = (b[0] - ox) * dy - (b[1] - oy) * dx;
  if ((pa > 0 && pb > 0) || (pa < 0 && pb < 0)) return false; // never crosses the lock line
  const sb = ((b[0] - cx) * dx + (b[1] - cy) * dy) / n;
  return (Math.min(sa, sb) <= r && Math.max(sa, sb) >= -r) || l.kind === 'ray';
}
