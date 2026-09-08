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
function perpDistance(p: Vec3, origin: Vec3, dir: Vec3): number {
  const rx = p.x - origin.x, ry = p.y - origin.y, rz = p.z - origin.z;
  const along = rx * dir.x + ry * dir.y + rz * dir.z;
  const px = rx - along * dir.x, py = ry - along * dir.y, pz = rz - along * dir.z;
  return Math.sqrt(px * px + py * py + pz * pz);
}

/**
 * Distinct edge lines meeting at each vertex.
 *
 * Counting incident SEGMENTS (what the cache used to do) scores an interior
 * split of a straight run as valence 2 and declares it a corner, which froze the
 * snap point there for centimetres of cursor travel and painted corner rings on
 * nothing. Counting distinct LINES scores that same vertex 1.
 *
 * MUST be fed the canonically ordered segment list (see `mergeCollinearRuns`),
 * never the raw input: the grouping below is greedy, so the representative set
 * - and with it the valence, the `isCorner` gate and the corner confidence - is
 * a function of segment order. Fed the raw array, that order is wasm triangle
 * emission order, and the valence at a junction moved when the mesher's output
 * order did (the #2388 failure class, measured as valence 3 vs 4 at one vertex
 * for the same geometry).
 *
 * The same-line test is symmetric in the pair. Comparing one segment's far
 * POINT against the other's line (the previous test) scales with whichever
 * segment happens to be the candidate, so which of two near-parallel segments
 * was seen first decided whether they merged. Instead the angle between the
 * two lines is scaled by the SHORTER length: a segment of length L built from
 * welded points only pins its direction to within ~tol/L, so two directions
 * are indistinguishable when their angle is inside the shorter segment's own
 * uncertainty - an order-free statement about the pair. (Scaling by the longer
 * length would be symmetric too, but it splits a genuinely straight run at its
 * interior weld vertex whenever the two half-segments are lopsided, because
 * the vertex's f32 noise is amplified by the length ratio.)
 */
function computeValences(
  segments: WeldedSegment[],
  points: Vec3[],
  tol: number
): Map<number, number> {
  const incident = new Map<number, number[]>();
  const add = (v: number, other: number) => {
    const list = incident.get(v);
    if (list) list.push(other);
    else incident.set(v, [other]);
  };
  for (const s of segments) {
    add(s.a, s.b);
    add(s.b, s.a);
  }

  const valence = new Map<number, number>();
  for (const [v, others] of incident) {
    const origin = points[v];
    const reps: Array<{ dir: Vec3; len: number }> = [];
    for (const o of others) {
      const p = points[o];
      const dx = p.x - origin.x, dy = p.y - origin.y, dz = p.z - origin.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len <= tol) continue;
      const dir = { x: dx / len, y: dy / len, z: dz / len };
      let matched = false;
      for (const rep of reps) {
        // Sine of the angle between the two LINES: the cross product magnitude
        // of the unit directions, which is identical for opposite orientations,
        // so a straight run passing through the vertex still counts as one line.
        const cx = dir.y * rep.dir.z - dir.z * rep.dir.y;
        const cy = dir.z * rep.dir.x - dir.x * rep.dir.z;
        const cz = dir.x * rep.dir.y - dir.y * rep.dir.x;
        const sin = Math.sqrt(cx * cx + cy * cy + cz * cz);
        if (sin * Math.min(len, rep.len) <= tol) {
          matched = true;
          break;
        }
      }
      if (!matched) reps.push({ dir, len });
    }
    valence.set(v, reps.length);
  }
  return valence;
}

interface Interval {
  t0: number;
  t1: number;
  v0: number;
  v1: number;
}

/**
 * Merge the mesh's edge segments into model-edge runs.
 *
 * Deterministic by construction: segments are processed in a canonical
 * GEOMETRIC order (lexicographic on their endpoints), never in array order, so
 * the output is identical under any permutation of the input.
 */
export function mergeCollinearRuns(
  segments: WeldedSegment[],
  points: Vec3[],
  tol: number
): SnapEdge[] {
  // Orient each segment lexicographically, then sort the whole set the same way.
  const oriented = segments
    .filter((s) => s.a !== s.b && points[s.a] !== undefined && points[s.b] !== undefined)
    .map((s) => (compareVec3(points[s.a], points[s.b]) <= 0 ? { a: s.a, b: s.b } : { a: s.b, b: s.a }));
  oriented.sort((s1, s2) => {
    const byA = compareVec3(points[s1.a], points[s2.a]);
    return byA !== 0 ? byA : compareVec3(points[s1.b], points[s2.b]);
  });

  // Valences are computed on the CANONICAL order, after the sort: they are the
  // one channel that survives into user-visible behaviour (corner detection and
  // confidence), so they must be as order-free as the runs themselves.
  const valence = computeValences(oriented, points, tol);

  const adjacency = new Map<number, number[]>();
  oriented.forEach((s, i) => {
    for (const v of [s.a, s.b]) {
      const list = adjacency.get(v);
      if (list) list.push(i);
      else adjacency.set(v, [i]);
    }
  });

  const visited = new Uint8Array(oriented.length);
  const edges: SnapEdge[] = [];

  for (let seed = 0; seed < oriented.length; seed++) {
    if (visited[seed]) continue;
    const origin = points[oriented[seed].a];
    const far = points[oriented[seed].b];
    const dx = far.x - origin.x, dy = far.y - origin.y, dz = far.z - origin.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len <= tol) {
      visited[seed] = 1;
      continue;
    }
    const dir = { x: dx / len, y: dy / len, z: dz / len };

    // Grow the run over segments that share a vertex with it AND whose BOTH
    // endpoints lie on the SEED's line. Testing against the seed line rather
    // than the previous member is what keeps a tessellated arc unfused: the
    // error is measured globally, so it cannot accumulate chord by chord.
    visited[seed] = 1;
    const members = [seed];
    const queue = [seed];
    while (queue.length > 0) {
      const cur = queue.pop() as number;
      for (const v of [oriented[cur].a, oriented[cur].b]) {
        for (const nb of adjacency.get(v) ?? []) {
          if (visited[nb]) continue;
          if (perpDistance(points[oriented[nb].a], origin, dir) > tol) continue;
          if (perpDistance(points[oriented[nb].b], origin, dir) > tol) continue;
          visited[nb] = 1;
          members.push(nb);
          queue.push(nb);
        }
      }
    }

    const project = (v: number): number => {
      const p = points[v];
      return (p.x - origin.x) * dir.x + (p.y - origin.y) * dir.y + (p.z - origin.z) * dir.z;
    };

    const intervals: Interval[] = [];
    const seen = new Map<number, number>();
    for (const m of members) {
      const { a, b } = oriented[m];
      const ta = project(a), tb = project(b);
      seen.set(a, ta);
      seen.set(b, tb);
      intervals.push(ta <= tb ? { t0: ta, t1: tb, v0: a, v1: b } : { t0: tb, t1: ta, v0: b, v1: a });
    }
    intervals.sort((i1, i2) => i1.t0 - i2.t0 || i1.t1 - i2.t1);

    // 1D union. The gap tolerance is the SAME ~15 um as collinearity, never a
    // round number: two openings aligned on one line in a slab are distinct
    // model edges separated by a real gap, and a centimetre-scale gap tolerance
    // would bridge them and report a length no edge has.
    const runs: Interval[] = [];
    let cur = intervals[0];
    for (let i = 1; i < intervals.length; i++) {
      const next = intervals[i];
      if (next.t0 <= cur.t1 + tol) {
        if (next.t1 > cur.t1) cur = { t0: cur.t0, t1: next.t1, v0: cur.v0, v1: next.v1 };
      } else {
        runs.push(cur);
        cur = next;
      }
    }
    runs.push(cur);

    for (const run of runs) {
      let p0 = points[run.v0], p1 = points[run.v1];
      let val0 = valence.get(run.v0) ?? 0, val1 = valence.get(run.v1) ?? 0;
      const reversed = compareVec3(p0, p1) > 0;
      if (reversed) {
        [p0, p1] = [p1, p0];
        [val0, val1] = [val1, val0];
      }
      const span = run.t1 - run.t0;
      const junctions: SnapEdgeJunction[] = [];
      for (const [v, t] of seen) {
        if (t <= run.t0 + tol || t >= run.t1 - tol) continue;
        const val = valence.get(v) ?? 0;
        if (val < MIN_CORNER_VALENCE) continue;
        const along = span > 0 ? (t - run.t0) / span : 0;
        junctions.push({ point: points[v], valence: val, t: reversed ? 1 - along : along });
      }
      junctions.sort((j1, j2) => j1.t - j2.t);
      const ex = p1.x - p0.x, ey = p1.y - p0.y, ez = p1.z - p0.z;
      edges.push({
        v0: p0,
        v1: p1,
        index: edges.length,
        length: Math.sqrt(ex * ex + ey * ey + ez * ez),
        v0Valence: val0,
        v1Valence: val1,
        junctions,
      });
    }
  }

  return edges;
}
