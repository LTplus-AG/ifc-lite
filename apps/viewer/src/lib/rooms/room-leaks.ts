/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Leak diagnostics for the Room tool (charter #6232 M4): why an area the user sees as a room is not one.
 *
 *   - Each wall is classified as BOUNDING (its axis lies along a room edge)
 *     or not: a wall that bounds no room encloses nothing, so the region it
 *     was meant to close leaks somewhere along it (purely geometric, so it needs no source provenance).
 *   - Each wall end that touches no other wall is an OPEN END: a gap a region
 *     can leak out through (a free-standing partition's end is one too).
 */

import { distToSeg, pointInPoly, type Pt } from '@/lib/rooms/plate-geometry';
import type { LayoutFace } from './room-layout';

/** A segment midpoint this close (m) to a room edge bounds that room. */
const BOUNDING_TOL = 0.35;
/** A wall end this close (m) to another wall touches it. */
const TOUCH_TOL = 0.1;

export interface LeakWall {
  a: Pt;
  b: Pt;
  bounding: boolean;
}

export interface Leaks {
  walls: LeakWall[];
  /** Wall ends that touch no other wall: where a region can leak out. */
  openEnds: Pt[];
}

/** Distance from `p` to a convex / simple polygon: 0 inside. */
function distToPolygon(p: Pt, ring: readonly Pt[]): number {
  if (pointInPoly(p[0], p[1], ring as Pt[])) return 0;
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    d = Math.min(d, distToSeg(p[0], p[1], a[0], a[1], b[0], b[1]));
  }
  return d;
}

/** Classify the storey's walls against its layout faces; `weld` widens "touching". */
export function wallLeaks(
  walls: readonly { corners: Pt[]; centreline: [Pt, Pt] }[],
  faces: readonly LayoutFace[],
  weld = 0,
): Leaks {
  const out: Leaks = { walls: [], openEnds: [] };
  walls.forEach((wall, i) => {
    const [a, b] = wall.centreline;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const bounding = faces.some((f) => f.centre.some((p, k) => {
      const q = f.centre[(k + 1) % f.centre.length];
      return distToSeg(mx, my, p[0], p[1], q[0], q[1]) <= BOUNDING_TOL;
    }));
    out.walls.push({ a, b, bounding });
    for (const end of [a, b]) {
      const touches = walls.some((other, j) => j !== i && distToPolygon(end, other.corners) <= TOUCH_TOL + weld);
      if (!touches) out.openEnds.push(end);
    }
  });
  return out;
}
