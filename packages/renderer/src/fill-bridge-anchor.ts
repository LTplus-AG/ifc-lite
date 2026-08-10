/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a hole's bridge edge attaches to the boundary it is being spliced into
 * (see `joinHoles` in `fill-triangulate.ts`).
 *
 * "Nearest vertex to the right" alone is not enough. The bridge has to be a
 * segment that stays inside the material — if it crosses a boundary edge, an
 * already-spliced hole, or an earlier bridge, the merged ring is no longer a
 * simple polygon and ear clipping is entitled to emit nonsense. A concave
 * boundary makes this reachable: the nearest vertex to the right of a hole can
 * sit on the far side of a wall, in a lobe the hole cannot see.
 *
 * So candidates are ranked exactly as before (to the right first, then by
 * distance) and the first one whose bridge crosses nothing wins. The ranking is
 * unchanged for the common convex case, which is why simple profiles produce
 * byte-identical rings to before.
 */

import type { Pt } from './fill-triangulate.js';

/** Cross product of (q - p) x (r - p). Sign gives which side of pq r is on. */
function cross(p: Pt, q: Pt, r: Pt): number {
  return (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
}

const EPS = 1e-12;

/** True when ab and cd cross at a point interior to both — shared endpoints
 *  and touching do not count, they are handled by {@link vertexOnSegment}. */
function properlyCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return (
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
    ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
  );
}

/** True when `p` lies on the open segment ab. A vertex sitting on the bridge
 *  makes the merged ring degenerate rather than simple, so it disqualifies the
 *  anchor just as a crossing does. */
function vertexOnSegment(p: Pt, a: Pt, b: Pt): boolean {
  if (Math.abs(cross(a, b, p)) > EPS) return false;
  const dot = (p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z);
  const len = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
  return dot > EPS && dot < len - EPS;
}

/**
 * True when the segment `boundary[anchorIdx]` → `hole[startIdx]` crosses
 * nothing. Edges incident to either endpoint are skipped: they share that
 * endpoint by construction and can never be a genuine crossing.
 */
function bridgeIsClear(
  boundary: readonly Pt[],
  hole: readonly Pt[],
  anchorIdx: number,
  startIdx: number,
): boolean {
  const a = boundary[anchorIdx];
  const b = hole[startIdx];

  for (let i = 0; i < boundary.length; i++) {
    const j = (i + 1) % boundary.length;
    if (i !== anchorIdx && j !== anchorIdx && properlyCross(a, b, boundary[i], boundary[j])) {
      return false;
    }
    if (i !== anchorIdx && vertexOnSegment(boundary[i], a, b)) return false;
  }

  for (let i = 0; i < hole.length; i++) {
    const j = (i + 1) % hole.length;
    if (i !== startIdx && j !== startIdx && properlyCross(a, b, hole[i], hole[j])) {
      return false;
    }
    if (i !== startIdx && vertexOnSegment(hole[i], a, b)) return false;
  }

  return true;
}

/**
 * Pick the boundary vertex the hole's bridge should attach to, or -1 when the
 * boundary has no vertices at all.
 *
 * Candidates to the right of the bridge start come first (the direction the
 * hole's rightmost vertex looks in), then everything else, each group ordered
 * by distance. The first candidate with a clear bridge wins. If none is clear —
 * only reachable on malformed input such as a hole that pokes outside its
 * boundary — the nearest candidate is used anyway, which is what this did
 * before any visibility check existed.
 */
export function chooseBridgeAnchor(
  boundary: readonly Pt[],
  hole: readonly Pt[],
  startIdx: number,
): number {
  if (boundary.length === 0) return -1;
  const start = hole[startIdx];

  const ranked = boundary
    .map((p, i) => ({
      i,
      right: p.x > start.x,
      d: (p.x - start.x) ** 2 + (p.z - start.z) ** 2,
    }))
    .sort((a, b) => (a.right === b.right ? a.d - b.d : a.right ? -1 : 1));

  for (const candidate of ranked) {
    if (bridgeIsClear(boundary, hole, candidate.i, startIdx)) return candidate.i;
  }
  return ranked[0].i;
}
