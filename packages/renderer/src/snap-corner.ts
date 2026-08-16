/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Corner detection and the deterministic ordering of edge snap candidates.
 */

import type { Vec3 } from './raycaster.js';
import { distance } from './snap-geometry-utils.js';
import { compareVec3, MIN_CORNER_VALENCE, type SnapEdge } from './snap-edge-runs.js';

/** Distance from an edge end, as a fraction of edge length, that reads as "at the end". */
const CORNER_THRESHOLD = 0.08;

export interface CornerInfo {
  isCorner: boolean;
  valence: number;
  vertex: Vec3 | null;
}

/**
 * Is the cursor at a corner of this edge?
 *
 * Candidates are the two run endpoints (when the cursor is near one of them
 * along the edge) plus every interior junction of the run. Interior junctions
 * matter because runs are merged THROUGH real junctions so that the reported
 * length is the visible edge: without them, a crease edge terminating mid-run
 * (an opening corner landing on a straight boundary) would lose its vertex snap
 * entirely, since the magnetic path never reaches `findVertices` while an edge
 * is nearby.
 */
export function detectCorner(
  edge: SnapEdge,
  t: number,
  radius: number,
  point: Vec3
): CornerInfo {
  // A junction is gated exactly like an endpoint: the cursor has to be within
  // CORNER_THRESHOLD of it ALONG the run (an endpoint sits at t = 0 or t = 1),
  // and then within `radius` of it in space. Without the along-run gate a run
  // merged through a junction would read as a corner over its whole length,
  // because `radius` is several times the screen snap radius.
  const candidates: Array<{ vertex: Vec3; valence: number }> = [];
  if (t < CORNER_THRESHOLD) candidates.push({ vertex: edge.v0, valence: edge.v0Valence });
  if (t > 1 - CORNER_THRESHOLD) candidates.push({ vertex: edge.v1, valence: edge.v1Valence });
  for (const junction of edge.junctions) {
    if (Math.abs(t - junction.t) < CORNER_THRESHOLD) {
      candidates.push({ vertex: junction.point, valence: junction.valence });
    }
  }

  let best: { vertex: Vec3; valence: number } | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const dist = distance(point, candidate.vertex);
    if (dist < bestDistance) {
      best = candidate;
      bestDistance = dist;
    }
  }

  if (!best) return { isCorner: false, valence: 0, vertex: null };
  return {
    isCorner: bestDistance < radius && best.valence >= MIN_CORNER_VALENCE,
    valence: best.valence,
    vertex: best.vertex,
  };
}

export interface EdgeCandidate {
  edge: SnapEdge;
  closestPoint: Vec3;
  distance: number;
  t: number;
}

/**
 * Total order over edge snap candidates.
 *
 * Sorting on distance alone left equidistant candidates to be separated by
 * array order, i.e. by wasm triangle emission order — the exact defect class of
 * #2388, and reachable here because two fragments of one model edge sat at
 * bit-identical distances from the cursor. Run merging removes that particular
 * pair, but distinct edges can still tie (a cursor centred between two parallel
 * edges), so the tiebreak is made geometric and total:
 *
 * 1. closer wins;
 * 2. then the edge that actually spans the cursor (its closest point is
 *    interior, not clamped to an end) — a clamped candidate means the cursor is
 *    off the end of that edge, so it is the worse description of what the user
 *    is pointing along;
 * 3. then the longer run — the more model-like edge, and the one that survives
 *    a retessellation unchanged;
 * 4. then the endpoints lexicographically, which depends on nothing but the
 *    geometry.
 */
function compareEdgeCandidates(a: EdgeCandidate, b: EdgeCandidate): number {
  if (a.distance !== b.distance) return a.distance - b.distance;

  const aInterior = a.t > 0 && a.t < 1;
  const bInterior = b.t > 0 && b.t < 1;
  if (aInterior !== bInterior) return aInterior ? -1 : 1;

  if (a.edge.length !== b.edge.length) return b.edge.length - a.edge.length;

  const byV0 = compareVec3(a.edge.v0, b.edge.v0);
  return byV0 !== 0 ? byV0 : compareVec3(a.edge.v1, b.edge.v1);
}

/** The single best candidate under `compareEdgeCandidates`, or null when empty. */
export function bestEdgeCandidate(candidates: EdgeCandidate[]): EdgeCandidate | null {
  let best: EdgeCandidate | null = null;
  for (const candidate of candidates) {
    if (best === null || compareEdgeCandidates(candidate, best) < 0) best = candidate;
  }
  return best;
}
