/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Space Sketch snapping on the shared snap engine (#6232 WP3). Replaces the
 * standalone `lib/space-snap.ts` solver with a compatibility profile: the
 * same inputs, the same `{ pt, kind }` answer (pinned by a seeded 10k-input
 * parity test against the old implementation).
 *
 * Behaviour, as before:
 *   1. corners (room vertices + building-line endpoints) beat on-wall
 *      projections; nearest within `tol` wins per tier;
 *   2. Shift (ortho) DOMINATES snap: the point is locked to the
 *      horizontal/vertical line through `anchor` and snapping only moves it
 *      ALONG that line, ranked purely by distance along it (`lockedTiers`).
 * All in the room (model-metre) frame.
 */

import { solveSnap } from './solve.js';
import { createLineworkSource } from './sources/linework.js';
import type { SnapProfile } from './types.js';

export type SketchPt = [number, number];

export type SketchSnapKind = 'vertex' | 'line' | 'none';

export interface SketchSnapOptions {
  /** Corner targets — existing room vertices. */
  vertices?: ReadonlyArray<SketchPt>;
  /** Building wall lines (room frame); endpoints snap as corners, bodies as on-wall. */
  segments?: ReadonlyArray<readonly [SketchPt, SketchPt]>;
  /** Snap radius in world (metre) units. */
  tol: number;
  /** Constrain to horizontal/vertical from `anchor` before snapping. */
  ortho?: boolean;
  /** Reference point for ortho (e.g. the previous drawn corner or drag start). */
  anchor?: SketchPt | null;
}

export interface SketchSnapResult {
  pt: SketchPt;
  kind: SketchSnapKind;
}

export const SPACE_SKETCH_PROFILE: SnapProfile = {
  // Nominal: callers give `tol` in metres, converted with metresPerPixel = tol / radiusPx.
  radiusPx: 10,
  tiers: [['endpoint', 'vertex'], ['edge']],
  lockedTiers: [['endpoint', 'vertex', 'edge']],
  sources: ['linework'],
  angleStepDeg: 90,
  hysteresisPx: 0,
};

export function snapSketchPoint(p: SketchPt, opts: SketchSnapOptions): SketchSnapResult {
  const { vertices = [], segments = [], tol, ortho = false, anchor = null } = opts;
  const res = solveSnap(
    {
      cursor: p,
      metresPerPixel: tol / SPACE_SKETCH_PROFILE.radiusPx,
      anchor: ortho ? anchor : null,
      chain: [],
      modifiers: { shift: ortho, alt: false },
      locks: {},
    },
    [createLineworkSource({ vertices, segments })],
    SPACE_SKETCH_PROFILE,
  );
  const k = res.winner?.kind;
  const kind: SketchSnapKind = k === 'vertex' || k === 'endpoint' ? 'vertex' : k === 'edge' ? 'line' : 'none';
  return { pt: [res.local[0], res.local[1]], kind };
}

export interface AlignResult {
  pt: SketchPt;
  /** Reference point whose X the result aligned to (vertical guide), if any. */
  vRef: SketchPt | null;
  /** Reference point whose Y the result aligned to (horizontal guide), if any. */
  hRef: SketchPt | null;
}

/**
 * Alignment / object-snap tracking: independently snap `p`'s X to the nearest
 * reference point's X (a vertical guide) and its Y to the nearest reference's Y
 * (a horizontal guide). Lets a drawn corner lock under/level-with an earlier
 * corner — e.g. the closing point aligns vertically with the first point — so
 * rectangles close cleanly. X and Y snap independently, so the result can sit at
 * the intersection of two different references' axes.
 */
export function alignToAxes(p: SketchPt, refs: ReadonlyArray<SketchPt>, tol: number): AlignResult {
  let x = p[0], y = p[1];
  let vRef: SketchPt | null = null, hRef: SketchPt | null = null;
  let bestVX = tol, bestHY = tol;
  for (const r of refs) {
    const dx = Math.abs(r[0] - p[0]);
    if (dx < bestVX) { bestVX = dx; x = r[0]; vRef = r; }
    const dy = Math.abs(r[1] - p[1]);
    if (dy < bestHY) { bestHY = dy; y = r[1]; hRef = r; }
  }
  return { pt: [x, y], vRef, hRef };
}
