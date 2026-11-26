/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The collinear-run merge of `snap-edge-runs.ts` (see there for what a run is
 * and why it is built this way) as a resumable build (#11504): one `step`
 * orients, sorts, indexes or merges a bounded block, so a piece with tens of
 * thousands of segments does not hold an idle slice. `mergeCollinearRuns` is
 * this class run to completion.
 */

import type { Vec3 } from './raycaster.js';
import { ChunkedSort } from './snap-chunked-sort.js';
import {
  MIN_CORNER_VALENCE, compareVec3, perpDistance,
  type SnapEdge, type SnapEdgeJunction, type WeldedSegment,
} from './snap-edge-runs.js';

interface Interval {
  t0: number;
  t1: number;
  v0: number;
  v1: number;
}

/** Items one `step` handles per phase; the valence and run phases are per-vertex / per-seed work counted in segments. */
const ITEM_CHUNK = 2048;
const VERTEX_CHUNK = 256;
const SEED_WORK = 512;

type Phase = 'orient' | 'sort' | 'permute' | 'incident' | 'valence' | 'adjacency' | 'runs' | 'done';

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
  const build = new RunMergeBuild(segments, points, tol);
  while (!build.step()) { /* one call to completion */ }
  return build.result();
}

export class RunMergeBuild {
  private phase: Phase = 'orient';
  private next = 0;
  private oriented: WeldedSegment[] = [];
  private sort: ChunkedSort | null = null;
  private sorted: Int32Array | null = null;
  private ordered: WeldedSegment[] = [];
  private incident = new Map<number, number[]>();
  private incidentVertices: number[] = [];
  private readonly valence = new Map<number, number>();
  private readonly adjacency = new Map<number, number[]>();
  private visited = new Uint8Array(0);
  private readonly edges: SnapEdge[] = [];

  constructor(
    private readonly segments: WeldedSegment[],
    private readonly points: Vec3[],
    private readonly tol: number
  ) {}

  get done(): boolean { return this.phase === 'done'; }

  /** Do one bounded piece of work; true once every run is built. */
  step(): boolean {
    switch (this.phase) {
      case 'orient': this.orient(); break;
      case 'sort': this.sortSegments(); break;
      case 'permute': this.permute(); break;
      case 'incident': this.indexIncident(); break;
      case 'valence': this.computeValences(); break;
      case 'adjacency': this.indexAdjacency(); break;
      case 'runs': this.growRuns(); break;
      case 'done': break;
    }
    return this.phase === 'done';
  }

  result(): SnapEdge[] { return this.edges; }

  // Orient each segment lexicographically, then sort the whole set the same way.
  private orient(): void {
    const { segments, points } = this;
    const end = Math.min(segments.length, this.next + ITEM_CHUNK);
    for (let i = this.next; i < end; i++) {
      const s = segments[i];
      if (s.a === s.b || points[s.a] === undefined || points[s.b] === undefined) continue;
      this.oriented.push(compareVec3(points[s.a], points[s.b]) <= 0 ? { a: s.a, b: s.b } : { a: s.b, b: s.a });
    }
    this.next = end;
    if (end < segments.length) return;
    const oriented = this.oriented;
    const idx = new Int32Array(oriented.length);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    this.sort = new ChunkedSort(idx, (i, j) => {
      const s1 = oriented[i], s2 = oriented[j];
      const byA = compareVec3(points[s1.a], points[s2.a]);
      return byA !== 0 ? byA : compareVec3(points[s1.b], points[s2.b]);
    });
    this.phase = 'sort';
  }

  private sortSegments(): void {
    if (!this.sort!.step()) return;
    this.sorted = this.sort!.result();
    this.sort = null;
    this.next = 0;
    this.phase = 'permute';
  }

  private permute(): void {
    const sorted = this.sorted!;
    const end = Math.min(sorted.length, this.next + ITEM_CHUNK * 4);
    for (let i = this.next; i < end; i++) this.ordered.push(this.oriented[sorted[i]]);
    this.next = end;
    if (end < sorted.length) return;
    this.oriented = [];
    this.sorted = null;
    this.next = 0;
    this.phase = 'incident';
  }

  // Valences are computed on the CANONICAL order, after the sort: they are the
  // one channel that survives into user-visible behaviour (corner detection and
  // confidence), so they must be as order-free as the runs themselves.
  private indexIncident(): void {
    const ordered = this.ordered, incident = this.incident;
    const add = (v: number, other: number) => {
      const list = incident.get(v);
      if (list) list.push(other);
      else incident.set(v, [other]);
    };
    const end = Math.min(ordered.length, this.next + ITEM_CHUNK);
    for (let i = this.next; i < end; i++) {
      add(ordered[i].a, ordered[i].b);
      add(ordered[i].b, ordered[i].a);
    }
    this.next = end;
    if (end < ordered.length) return;
    this.incidentVertices = [...incident.keys()];
    this.next = 0;
    this.phase = 'valence';
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
  private computeValences(): void {
    const { points, tol, incident, incidentVertices } = this;
    const end = Math.min(incidentVertices.length, this.next + VERTEX_CHUNK);
    for (let n = this.next; n < end; n++) {
      const v = incidentVertices[n];
      const others = incident.get(v)!;
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
      this.valence.set(v, reps.length);
    }
    this.next = end;
    if (end < incidentVertices.length) return;
    this.incident = new Map();
    this.incidentVertices = [];
    this.next = 0;
    this.phase = 'adjacency';
  }

  private indexAdjacency(): void {
    const ordered = this.ordered, adjacency = this.adjacency;
    const end = Math.min(ordered.length, this.next + ITEM_CHUNK);
    for (let i = this.next; i < end; i++) {
      for (const v of [ordered[i].a, ordered[i].b]) {
        const list = adjacency.get(v);
        if (list) list.push(i);
        else adjacency.set(v, [i]);
      }
    }
    this.next = end;
    if (end < ordered.length) return;
    this.visited = new Uint8Array(ordered.length);
    this.next = 0;
    this.phase = 'runs';
  }

  /** Grow runs from successive seeds until about `SEED_WORK` segments are handled. */
  private growRuns(): void {
    const ordered = this.ordered;
    let work = 0;
    while (this.next < ordered.length && work < SEED_WORK) {
      const seed = this.next++;
      if (this.visited[seed]) continue;
      work += this.growRun(seed);
    }
    if (this.next >= ordered.length) {
      this.phase = 'done';
      this.ordered = [];
    }
  }

  /** The run seeded at `seed`; returns the number of segments it consumed. */
  private growRun(seed: number): number {
    const { ordered: oriented, points, tol, adjacency, visited, valence, edges } = this;
    const origin = points[oriented[seed].a];
    const far = points[oriented[seed].b];
    const dx = far.x - origin.x, dy = far.y - origin.y, dz = far.z - origin.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len <= tol) {
      visited[seed] = 1;
      return 1;
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
    return members.length;
  }
}
