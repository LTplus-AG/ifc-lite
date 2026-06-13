/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Snapping for the 2D Space Sketch editor — shared by both dragging existing
 * room vertices and drawing new room corners, so every node behaves the same.
 *
 * Candidates, in priority order (nearest within `tol` wins per tier):
 *   1. Corners — room vertices + building-line endpoints.
 *   2. On-wall — projection onto the nearest building segment.
 * Both work in the room (model-metre) frame, the same frame the underlay lines
 * and room outlines already live in.
 *
 * Ortho (Shift) is applied first, relative to `anchor`, so straight runs still
 * land on corners/walls; an in-range snap then overrides the ortho point (snap
 * beats straightness, matching the drag behaviour the editor already had).
 */

export type Pt = [number, number];

export type SnapKind = 'vertex' | 'line' | 'none';

export interface SnapOptions {
  /** Corner targets — existing room vertices. */
  vertices?: ReadonlyArray<Pt>;
  /** Building wall lines (room frame); endpoints snap as corners, bodies as on-wall. */
  segments?: ReadonlyArray<readonly [Pt, Pt]>;
  /** Snap radius in world (metre) units. */
  tol: number;
  /** Constrain to horizontal/vertical from `anchor` before snapping. */
  ortho?: boolean;
  /** Reference point for ortho (e.g. the previous drawn corner or drag start). */
  anchor?: Pt | null;
}

export interface SnapResult {
  pt: Pt;
  kind: SnapKind;
}

/** Constrain `p` to a horizontal or vertical line through `anchor`, whichever
 *  axis the cursor has moved further along. */
function applyOrtho(p: Pt, anchor: Pt): Pt {
  const dx = Math.abs(p[0] - anchor[0]);
  const dy = Math.abs(p[1] - anchor[1]);
  return dx >= dy ? [p[0], anchor[1]] : [anchor[0], p[1]];
}

/** Closest point on segment a→b to p (clamped to the segment). */
function projectOnSeg(p: Pt, a: readonly [number, number], b: readonly [number, number]): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

export function snapPoint(p: Pt, opts: SnapOptions): SnapResult {
  const { vertices = [], segments = [], tol, ortho = false, anchor = null } = opts;
  const base: Pt = ortho && anchor ? applyOrtho(p, anchor) : [p[0], p[1]];

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
