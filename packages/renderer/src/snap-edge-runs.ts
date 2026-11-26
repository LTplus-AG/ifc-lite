/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collinear-run reconstruction: turn the mesh's per-triangle edge segments back
 * into the model edges a user actually sees.
 *
 * A straight model edge is routinely crossed by several triangles (the faces on
 * either side subdivide it independently, at different interior points), so the
 * mesh carries it as several segments that abut, overlap, or duplicate each
 * other. Reporting one of those segments as "the edge" reports a fragment: on
 * `building-architecture.ifc` the 2.000 m opening edge of IfcSlab #52 arrives as
 * 0.200 / 1.800 / 1.600 / 0.200, and no cursor position on it ever measured
 * 2.000. Worse, the two overlapping fragments sit at bit-identical distances
 * from a cursor in the overlap, so which one won was decided purely by wasm
 * triangle emission order (the #2388 failure class).
 *
 * The fix is a group-by-supporting-line plus 1D interval union, not a chain
 * walk: interval union is the only formulation that handles abutment, overlap,
 * exact duplication and reversed orientation with one mechanism.
 *
 * A tessellated curve must NOT fuse into one straight edge — that would report a
 * confidently wrong number, worse than the fragment it replaces. Two things
 * prevent it: the tolerance is a perpendicular distance of ~15 um (see
 * `snapToleranceFor`), while the finest arc the Rust tessellator can emit
 * (`calculate_circle_segments`, min 8 segments) has a single-chord sagitta of
 * ~381 um at a 5 mm radius — 25x larger; and every candidate is tested against
 * the GROUP's seed line rather than against its predecessor, so collinearity
 * error cannot accumulate along a chain of chords.
 */

import type { Vec3 } from './raycaster.js';

/**
 * Minimum number of distinct edge lines meeting at a vertex for it to count as
 * a corner. Two lines meeting is the weakest thing that still looks like a
 * corner; one line means the vertex is an interior split of a straight run.
 */
export const MIN_CORNER_VALENCE = 2;

/** A vertex strictly inside a merged run where other edges terminate. */
export interface SnapEdgeJunction {
  point: Vec3;
  valence: number;
  /** Parameter of the junction along the run, in the same 0-1 space as edge `t`. */
  t: number;
}

/** One reconstructed model edge. */
export interface SnapEdge {
  v0: Vec3;
  v1: Vec3;
  index: number;
  /** World-space length of the whole run — the number a length readout reports. */
  length: number;
  /** Distinct edge lines meeting at `v0` / `v1`. */
  v0Valence: number;
  v1Valence: number;
  /**
   * Interior vertices where other edges meet this run. Merging through them is
   * what makes the reported length match the visible edge; keeping them here is
   * what stops a real junction (an opening corner landing on a straight
   * boundary) from losing its vertex snap in the process.
   */
  junctions: SnapEdgeJunction[];
  /** Where a clip plane crosses the mesh rather than a model edge (#8659). */
  cut?: boolean;
}

/** A mesh edge as a pair of welded vertex ids. */
export interface WeldedSegment {
  a: number;
  b: number;
}

/** Lexicographic order on a point — the geometric tiebreak used for determinism. */
export function compareVec3(a: Vec3, b: Vec3): number {
  if (a.x !== b.x) return a.x < b.x ? -1 : 1;
  if (a.y !== b.y) return a.y < b.y ? -1 : 1;
  if (a.z !== b.z) return a.z < b.z ? -1 : 1;
  return 0;
}

/** Perpendicular distance from `p` to the line through `origin` with unit direction `dir`. */
export function perpDistance(p: Vec3, origin: Vec3, dir: Vec3): number {
  const rx = p.x - origin.x, ry = p.y - origin.y, rz = p.z - origin.z;
  const along = rx * dir.x + ry * dir.y + rz * dir.z;
  const px = rx - along * dir.x, py = ry - along * dir.y, pz = rz - along * dir.z;
  return Math.sqrt(px * px + py * py + pz * pz);
}
