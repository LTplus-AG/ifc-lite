/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the cursor is over in the Room tool's Edit mode (charter #6232 M4): a layout corner, else a layout edge (with the
 * rooms on either side), within a screen-sized tolerance. Pure geometry on
 * the faces' wall-axis outlines, so a hover never calls into wasm.
 */

import { distToSeg, projectOnSeg, type Pt } from '@/lib/rooms/plate-geometry';
import type { LayoutFace } from './room-layout';

export type LayoutHit =
  | { kind: 'vertex'; at: Pt }
  | { kind: 'edge'; at: Pt; a: Pt; b: Pt; faces: number[] };

const key = (p: Pt) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

/** The layout corner, else edge, nearest `p` within `tol` metres. */
export function layoutHit(faces: readonly LayoutFace[], p: readonly [number, number], tol: number): LayoutHit | null {
  let vertex: Pt | null = null;
  let vd = tol;
  for (const f of faces) {
    for (const q of f.centre) {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= vd) { vd = d; vertex = q; }
    }
  }
  if (vertex) return { kind: 'vertex', at: vertex };
  let edge: { a: Pt; b: Pt; d: number } | null = null;
  for (const f of faces) {
    f.centre.forEach((a, i) => {
      const b = f.centre[(i + 1) % f.centre.length];
      const d = distToSeg(p[0], p[1], a[0], a[1], b[0], b[1]);
      if (d <= tol && (!edge || d < edge.d)) edge = { a, b, d };
    });
  }
  if (!edge) return null;
  const { a, b } = edge as { a: Pt; b: Pt };
  const ends = new Set([`${key(a)}|${key(b)}`, `${key(b)}|${key(a)}`]);
  const sides = faces.filter((f) => f.centre.some((q, i) => ends.has(`${key(q)}|${key(f.centre[(i + 1) % f.centre.length])}`)));
  return { kind: 'edge', at: projectOnSeg([p[0], p[1]], a, b), a, b, faces: sides.map((f) => f.face) };
}
