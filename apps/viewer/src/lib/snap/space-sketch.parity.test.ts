/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Space Sketch parity (#6232 WP3): the engine-backed `snapSketchPoint` must
 * answer exactly like the standalone solver it replaced. The old body of
 * `lib/space-snap.ts` is frozen below VERBATIM as the oracle (only renamed and
 * un-exported), and 10k seeded inputs are compared: same kind, same point
 * (1e-9; the ortho × wall crossing is computed by a different but equivalent
 * formula, so it may differ in the last bits).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { snapSketchPoint } from './space-sketch.js';
import { rng } from '@/test/snap-fixture.js';

// ── Frozen oracle: lib/space-snap.ts snapPoint as of 585bdb4e4 ──────────────
type Pt = [number, number];
type SnapKind = 'vertex' | 'line' | 'none';
interface SnapOptions {
  vertices?: ReadonlyArray<Pt>;
  segments?: ReadonlyArray<readonly [Pt, Pt]>;
  tol: number;
  ortho?: boolean;
  anchor?: Pt | null;
}
interface SnapResult { pt: Pt; kind: SnapKind }

/** Closest point on segment a→b to p (clamped to the segment). */
function projectOnSeg(p: Pt, a: readonly [number, number], b: readonly [number, number]): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

/**
 * Snap ALONG the ortho line through `anchor` (Shift held): the point stays on the
 * horizontal/vertical line, and only the free coordinate is snapped — to a nearby
 * corner's aligned coordinate (so the new node lines up with an existing one) or
 * to where the ortho line crosses a wall. Never breaks the straight constraint.
 */
function snapAlongOrtho(
  p: Pt,
  anchor: Pt,
  vertices: ReadonlyArray<Pt>,
  segments: ReadonlyArray<readonly [Pt, Pt]>,
  tol: number,
): SnapResult {
  const horizontal = Math.abs(p[0] - anchor[0]) >= Math.abs(p[1] - anchor[1]);
  const free = horizontal ? 0 : 1; // coordinate that varies along the line
  const fixed = horizontal ? 1 : 0; // coordinate pinned to the anchor
  const fixedVal = anchor[fixed];
  const target = p[free];
  let best = target, bestD = tol;
  let kind: SnapKind = 'none';
  // (a) align the free coord with a nearby corner (room vertex or wall endpoint).
  const alignTo = (q: Pt) => {
    const d = Math.abs(q[free] - target);
    if (d < bestD) { bestD = d; best = q[free]; kind = 'vertex'; }
  };
  for (const q of vertices) alignTo(q);
  for (const seg of segments) { alignTo(seg[0]); alignTo(seg[1]); }
  // (b) where the ortho line (fixed = fixedVal) crosses a wall segment.
  for (const seg of segments) {
    const fa = seg[0][fixed], fb = seg[1][fixed];
    const denom = fb - fa;
    if (Math.abs(denom) < 1e-9 || (fa - fixedVal) * (fb - fixedVal) > 0) continue; // parallel / no crossing
    const t = (fixedVal - fa) / denom;
    if (t < 0 || t > 1) continue;
    const cross = seg[0][free] + t * (seg[1][free] - seg[0][free]);
    const d = Math.abs(cross - target);
    if (d < bestD) { bestD = d; best = cross; kind = 'line'; }
  }
  const pt: Pt = horizontal ? [best, fixedVal] : [fixedVal, best];
  return { pt, kind };
}

function legacySnapPoint(p: Pt, opts: SnapOptions): SnapResult {
  const { vertices = [], segments = [], tol, ortho = false, anchor = null } = opts;
  // Shift held → ortho dominates: snap only along the straight line.
  if (ortho && anchor) return snapAlongOrtho(p, anchor, vertices, segments, tol);
  const base: Pt = [p[0], p[1]];

  // 1. Corner snap — room vertices + segment endpoints. Scalar trackers (not a
  // `Pt | null`) so TS control-flow doesn't narrow the accumulator to `never`.
  let bestX = 0, bestY = 0, bestD = tol, foundCorner = false;
  const consider = (qx: number, qy: number) => {
    const d = Math.hypot(qx - base[0], qy - base[1]);
    if (d < bestD) { bestD = d; bestX = qx; bestY = qy; foundCorner = true; }
  };
  for (const q of vertices) consider(q[0], q[1]);
  for (const seg of segments) { consider(seg[0][0], seg[0][1]); consider(seg[1][0], seg[1][1]); }
  if (foundCorner) return { pt: [bestX, bestY], kind: 'vertex' };

  // 2. On-wall snap — nearest segment projection.
  let projX = 0, projY = 0, projD = tol, foundLine = false;
  for (const seg of segments) {
    const q = projectOnSeg(base, seg[0], seg[1]);
    const d = Math.hypot(q[0] - base[0], q[1] - base[1]);
    if (d < projD) { projD = d; projX = q[0]; projY = q[1]; foundLine = true; }
  }
  if (foundLine) return { pt: [projX, projY], kind: 'line' };

  // 3. No snap — the ortho-adjusted (or raw) point.
  return { pt: base, kind: 'none' };
}
// ── end oracle ──────────────────────────────────────────────────────────────

function randomCase(r: () => number): { p: Pt; opts: SnapOptions } {
  const c = (): number => r() * 20 - 10;
  const vertices: Pt[] = Array.from({ length: Math.floor(r() * 9) }, () => [c(), c()]);
  const segments: [Pt, Pt][] = Array.from({ length: Math.floor(r() * 9) }, () => {
    const a: Pt = [c(), c()];
    // A third of the walls axis-aligned, like real plans.
    const axis = r();
    const b: Pt = axis < 0.17 ? [c(), a[1]] : axis < 0.34 ? [a[0], c()] : [c(), c()];
    return [a, b];
  });
  const tol = 0.05 + r() * 1.5;
  // Half the cursors land near a target, so snaps actually fire.
  const targets: Pt[] = [...vertices, ...segments.flat()];
  const near = targets.length > 0 && r() < 0.5 ? targets[Math.floor(r() * targets.length)] : null;
  const p: Pt = near ? [near[0] + (r() - 0.5) * tol * 3, near[1] + (r() - 0.5) * tol * 3] : [c(), c()];
  const ortho = r() < 0.4;
  const anchor: Pt | null = r() < 0.8 ? [c(), c()] : null;
  return { p, opts: { vertices, segments, tol, ortho, anchor } };
}

describe('snapSketchPoint parity with the replaced space-snap solver (#6232 WP3)', () => {
  it('agrees on 10k seeded inputs (kind exact, point within 1e-9)', () => {
    const r = rng(6232);
    const kinds: Record<SnapKind, number> = { vertex: 0, line: 0, none: 0 };
    let orthoSnaps = 0;
    for (let i = 0; i < 10_000; i++) {
      const { p, opts } = randomCase(r);
      const want = legacySnapPoint(p, opts);
      const got = snapSketchPoint(p, opts);
      const ctx = `case ${i}: ${JSON.stringify({ p, opts, want, got })}`;
      assert.equal(got.kind, want.kind, ctx);
      assert.ok(Math.abs(got.pt[0] - want.pt[0]) <= 1e-9 && Math.abs(got.pt[1] - want.pt[1]) <= 1e-9, ctx);
      kinds[want.kind]++;
      if (opts.ortho && opts.anchor && want.kind !== 'none') orthoSnaps++;
    }
    // Coverage: every branch of the oracle was exercised, not just "no snap".
    assert.ok(kinds.vertex > 1000 && kinds.line > 500 && kinds.none > 1000 && orthoSnaps > 500, JSON.stringify({ kinds, orthoSnaps }));
  });
});
