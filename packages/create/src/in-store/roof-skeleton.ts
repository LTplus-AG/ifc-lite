/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Weighted straight skeleton of a simple polygon, by wavefront simulation (#9296 round 3).
 *
 * Every edge's line moves inward at its own speed as time τ grows: edge i is the
 * line `n_i · p = k_i + s_i τ`, `n_i` its inward unit normal. Read τ as height and
 * `s_i` as the cotangent of the edge's slope, and the swept faces are the planes
 * of a roof by footprint: each face is the part of the roof that drains to its
 * edge. A speed of 0 is an edge that does not move, a gable end.
 *
 * Events are processed one at a time, earliest first:
 * - an edge event: a wavefront edge shrinks to a point and its neighbours meet;
 * - a split event: a reflex vertex runs into another edge and the wavefront splits;
 * - a zip: two anti-parallel lines meet (a ridge or a narrow wing closing up),
 *   and the overlapping run of the two edges ends there.
 * A wavefront that has lost its area ends, and its last edges close their faces.
 *
 * The caller decides which polygons it trusts this with (the roof builder takes
 * convex and rectilinear footprints). Anything the simulation cannot close
 * throws, rather than returning a face that is not one.
 */

export type SkeletonPoint = readonly [x: number, y: number];
/** A face corner: plan position and the time (height) it is reached. */
export type SkeletonNode = readonly [x: number, y: number, t: number];

export interface SkeletonLine {
  /** Inward unit normal. */
  readonly nx: number;
  readonly ny: number;
  /** Line constant at τ = 0. */
  readonly k: number;
  /** Inward speed; 0 holds the line still. */
  readonly s: number;
}

const EPS = 1e-9;

interface Vertex {
  prev: Vertex;
  next: Vertex;
  /** Incoming edge (prev → this) and outgoing edge (this → next): line indices. */
  readonly a: number;
  readonly b: number;
  readonly node: number;
  readonly t0: number;
  readonly x0: number;
  readonly y0: number;
  vx: number;
  vy: number;
  parallel: boolean;
  alive: boolean;
}

interface Segment { readonly face: number; readonly from: number; readonly to: number }

/** Intersection of two lines at time t; null when parallel. */
function meet(l1: SkeletonLine, l2: SkeletonLine, t: number): SkeletonPoint | null {
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  if (Math.abs(det) < EPS) return null;
  const c1 = l1.k + l1.s * t, c2 = l2.k + l2.s * t;
  return [(c1 * l2.ny - l1.ny * c2) / det, (l1.nx * c2 - c1 * l2.nx) / det];
}

/**
 * The faces of the weighted straight skeleton: `faces[i]` is the closed outline
 * swept by line i, as plan positions with the time each corner is reached.
 * Lines are given in counter-clockwise order; consecutive lines must not be parallel.
 */
export function weightedStraightSkeleton(lines: readonly SkeletonLine[]): SkeletonNode[][] {
  const n = lines.length;
  if (n < 3) throw new Error('A skeleton needs at least three edges');
  // Normalise to a unit-sized problem so one tolerance fits every model unit.
  const start = lines.map((_, i) => meet(lines[(i + n - 1) % n], lines[i], 0));
  if (start.some((p) => p === null)) throw new Error('Consecutive footprint edges are parallel');
  const pts = start as SkeletonPoint[];
  const cx = pts.reduce((sum, p) => sum + p[0], 0) / n, cy = pts.reduce((sum, p) => sum + p[1], 0) / n;
  const size = Math.max(...pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy)), EPS);
  const L: SkeletonLine[] = lines.map((l) => ({ nx: l.nx, ny: l.ny, k: (l.k - l.nx * cx - l.ny * cy) / size, s: l.s }));

  const nodes: Array<[number, number, number]> = [];
  const segments: Segment[] = [];
  const addNode = (x: number, y: number, t: number) => nodes.push([x, y, t]) - 1;
  const at = (v: Vertex, t: number): [number, number] => [v.x0 + v.vx * (t - v.t0), v.y0 + v.vy * (t - v.t0)];

  const makeVertex = (a: number, b: number, node: number): Vertex => {
    const [x0, y0, t0] = nodes[node];
    const v = { a, b, node, t0, x0, y0, vx: 0, vy: 0, parallel: false, alive: true } as Vertex;
    const det = L[a].nx * L[b].ny - L[a].ny * L[b].nx;
    if (Math.abs(det) < EPS) {
      v.parallel = true;
    } else {
      v.vx = (L[a].s * L[b].ny - L[a].ny * L[b].s) / det;
      v.vy = (L[a].nx * L[b].s - L[a].s * L[b].nx) / det;
    }
    return v;
  };
  /** End a vertex's trace at `node`; the trace bounds both of its faces. */
  const close = (v: Vertex, node: number) => {
    v.alive = false;
    if (node === v.node) return;
    segments.push({ face: v.a, from: v.node, to: node }, { face: v.b, from: v.node, to: node });
  };
  const nodeAt = (v: Vertex, t: number) => (nodes[v.node][2] === t ? v.node : addNode(...at(v, t), t));
  const link = (a: Vertex, b: Vertex) => { a.next = b; b.prev = a; };

  const initial = L.map((_, i) => makeVertex((i + n - 1) % n, i, addNode(...meetOrThrow(L, i), 0)));
  initial.forEach((v, i) => link(v, initial[(i + 1) % n]));
  initial.forEach((v, i) => segments.push({ face: i, from: v.node, to: initial[(i + 1) % n].node }));
  if (initial.some((v) => v.parallel)) throw new Error('Consecutive footprint edges are parallel');

  let now = 0;
  const cycles = (): Vertex[][] => {
    const seen = new Set<Vertex>(), out: Vertex[][] = [];
    for (const head of alive) {
      if (seen.has(head)) continue;
      const cycle: Vertex[] = [];
      let v = head;
      do { seen.add(v); cycle.push(v); v = v.next; } while (v !== head && cycle.length <= alive.size);
      out.push(cycle);
    }
    return out;
  };
  const alive = new Set<Vertex>(initial);
  const add = (v: Vertex) => { alive.add(v); return v; };
  const drop = (v: Vertex, node: number) => { close(v, node); alive.delete(v); };

  /** A wavefront with no area left closes each face it still carries along its last edge. */
  const finish = (cycle: Vertex[]) => {
    const ends = new Map(cycle.map((v) => [v, nodeAt(v, now)] as const));
    for (const v of cycle) {
      const from = ends.get(v)!, to = ends.get(v.next)!;
      if (from !== to) segments.push({ face: v.b, from, to });
    }
    for (const v of cycle) drop(v, ends.get(v)!);
  };
  const area = (cycle: Vertex[]) => {
    let sum = 0;
    for (const v of cycle) {
      const [x1, y1] = at(v, now), [x2, y2] = at(v.next, now);
      sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
  };

  /** Two anti-parallel lines meet at `v`: their overlapping run closes, the longer one carries on. */
  const zip = (v: Vertex) => {
    const x = v.prev, y = v.next;
    const pv = at(v, now), px = at(x, now), py = at(y, now);
    const dx = Math.hypot(pv[0] - px[0], pv[1] - px[1]), dy = Math.hypot(pv[0] - py[0], pv[1] - py[1]);
    const nv = nodeAt(v, now);
    drop(v, nv);
    if (Math.abs(dx - dy) <= 1e-7) {
      const shared = addNode((px[0] + py[0]) / 2, (px[1] + py[1]) / 2, now);
      segments.push({ face: v.a, from: shared, to: nv }, { face: v.b, from: nv, to: shared });
      const before = x.prev, after = y.next;
      drop(x, shared);
      if (y !== x) drop(y, shared);
      if (before === y || x === y) return;
      const w = add(makeVertex(x.a, y.b, shared));
      link(before, w); link(w, after);
    } else if (dx < dy) {
      const nx = nodeAt(x, now);
      segments.push({ face: v.a, from: nx, to: nv }, { face: v.b, from: nv, to: nx });
      const before = x.prev;
      drop(x, nx);
      const w = add(makeVertex(x.a, v.b, nx));
      link(before, w); link(w, y);
    } else {
      const ny = nodeAt(y, now);
      segments.push({ face: v.a, from: ny, to: nv }, { face: v.b, from: nv, to: ny });
      const after = y.next;
      drop(y, ny);
      const w = add(makeVertex(v.a, y.b, ny));
      link(x, w); link(w, after);
    }
  };

  /** Settle every wavefront after an event: close empty ones, zip met lines. */
  const settle = () => {
    for (let guard = 0; guard < 4 * n + 16; guard++) {
      let changed = false;
      for (const cycle of cycles()) {
        if (cycle.length <= 2 || Math.abs(area(cycle)) < EPS) { finish(cycle); changed = true; break; }
        const met = cycle.find((v) => v.parallel);
        if (!met) continue;
        const la = L[met.a], lb = L[met.b];
        if (la.nx * lb.nx + la.ny * lb.ny > 0) {
          // A straight run of two collinear lines moves as one only at one speed.
          if (Math.abs(la.s - lb.s) > EPS) throw new Error('Collinear edges with different slopes meet');
          met.parallel = false; met.vx = la.nx * la.s; met.vy = la.ny * la.s;
        } else {
          zip(met);
        }
        changed = true;
        break;
      }
      if (!changed) return;
    }
    throw new Error('The roof skeleton did not settle');
  };

  const reflex = (v: Vertex) => L[v.a].ny * -L[v.b].nx - -L[v.a].nx * L[v.b].ny < -EPS;
  const budget = 20 * n * n + 100;
  for (let step = 0; alive.size > 0; step++) {
    if (step > budget) throw new Error('The roof skeleton did not converge');
    // Earliest first; at the same moment an edge event wins over a split (it is the same meeting seen from the edge).
    let best: { t: number; rank: number; run: () => void } | null = null;
    const offer = (t: number, rank: number, run: () => void) => {
      if (!best || t < best.t - EPS || (t <= best.t + EPS && rank < best.rank)) best = { t, rank, run };
    };
    for (const cycle of cycles()) {
      for (const u of cycle) {
        const w = u.next, line = L[u.b];
        const dirX = line.ny, dirY = -line.nx;
        const [ux, uy] = at(u, now), [wx, wy] = at(w, now);
        const length = (wx - ux) * dirX + (wy - uy) * dirY;
        const rate = (w.vx - u.vx) * dirX + (w.vy - u.vy) * dirY;
        if (length < EPS && rate < EPS) offer(now, 0, () => edgeEvent(u));
        else if (rate < -EPS) offer(now + Math.max(0, length) / -rate, 0, () => edgeEvent(u));
      }
      for (const v of cycle) {
        if (!reflex(v)) continue;
        for (const a of cycle) {
          const b = a.next;
          if (a === v || b === v) continue;
          const line = L[a.b];
          const [vx, vy] = at(v, now);
          const gap = line.nx * vx + line.ny * vy - (line.k + line.s * now);
          const rate = line.nx * v.vx + line.ny * v.vy - line.s;
          if (gap < -EPS || rate > -EPS) continue;
          const t = now + Math.max(0, gap) / -rate;
          const [hx, hy] = at(v, t), [ax, ay] = at(a, t), [bx, by] = at(b, t);
          const dirX = line.ny, dirY = -line.nx;
          const along = hx * dirX + hy * dirY;
          if (along < ax * dirX + ay * dirY - 1e-7 || along > bx * dirX + by * dirY + 1e-7) continue;
          offer(t, 1, () => splitEvent(v, a, [hx, hy]));
        }
      }
    }
    if (!best) throw new Error('The roof skeleton cannot close this footprint');
    const chosen = best as { t: number; run: () => void };
    now = Math.max(now, chosen.t);
    chosen.run();
    settle();
  }

  function edgeEvent(u: Vertex) {
    const w = u.next;
    const pu = at(u, now), pw = at(w, now);
    const node = addNode((pu[0] + pw[0]) / 2, (pu[1] + pw[1]) / 2, now);
    const before = u.prev, after = w.next;
    drop(u, node); drop(w, node);
    if (before === w) return; // A two-vertex wavefront closes on itself.
    const v = add(makeVertex(u.a, w.b, node));
    link(before, v); link(v, after);
  }

  function splitEvent(v: Vertex, a: Vertex, hit: [number, number]) {
    const b = a.next;
    const node = addNode(hit[0], hit[1], now);
    const before = v.prev, after = v.next;
    drop(v, node);
    const left = add(makeVertex(v.a, a.b, node));
    const right = add(makeVertex(a.b, v.b, node));
    link(before, left); link(left, b);
    link(a, right); link(right, after);
  }

  // Chain each face's segments into one closed outline.
  const faces: SkeletonNode[][] = [];
  for (let face = 0; face < n; face++) {
    const own = segments.filter((s) => s.face === face && s.from !== s.to);
    const ring = chain(own, face);
    const outline = ring.map((id) => [nodes[id][0] * size + cx, nodes[id][1] * size + cy, nodes[id][2] * size] as const);
    const line = lines[face];
    // Every corner of face i lies on line i at its own time: anything else is not that face.
    for (const [x, y, t] of outline) {
      if (Math.abs(line.nx * x + line.ny * y - line.k - line.s * t) > 1e-6 * Math.max(1, size)) {
        throw new Error(`The roof skeleton produced an inconsistent plane for edge ${face}`);
      }
    }
    faces.push(dedupe(outline, 1e-9 * size));
  }
  return faces;
}

function meetOrThrow(lines: readonly SkeletonLine[], i: number): [number, number] {
  const p = meet(lines[(i + lines.length - 1) % lines.length], lines[i], 0);
  if (!p) throw new Error('Consecutive footprint edges are parallel');
  return [p[0], p[1]];
}

/** Walk a face's segments from its own edge round to where it started. */
function chain(own: readonly Segment[], face: number): number[] {
  if (own.length === 0) throw new Error(`The roof skeleton left edge ${face} without a face`);
  const byNode = new Map<number, number[]>();
  own.forEach((s, i) => {
    for (const node of [s.from, s.to]) byNode.set(node, [...(byNode.get(node) ?? []), i]);
  });
  const used = new Set<number>([0]);
  const ring = [own[0].from];
  let current = own[0].to;
  for (let guard = 0; current !== ring[0]; guard++) {
    if (guard > own.length) throw new Error(`The roof skeleton could not close the face of edge ${face}`);
    ring.push(current);
    const nextIndex = (byNode.get(current) ?? []).find((i) => !used.has(i));
    if (nextIndex === undefined) throw new Error(`The roof skeleton could not close the face of edge ${face}`);
    used.add(nextIndex);
    const s = own[nextIndex];
    current = s.from === current ? s.to : s.from;
  }
  return ring;
}

function dedupe(points: ReadonlyArray<readonly [number, number, number]>, tolerance: number): SkeletonNode[] {
  const out: SkeletonNode[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > tolerance || Math.abs(p[2] - last[2]) > tolerance) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= tolerance) out.pop();
  return out;
}
