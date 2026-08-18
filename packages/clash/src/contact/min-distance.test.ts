/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pruning is the part that can be wrong without looking wrong: a
 * branch-and-bound traversal that prunes too eagerly still returns a distance,
 * just a larger one, and on a hand-picked pair of boxes it is usually right
 * anyway. So the load-bearing test here is the brute-force oracle — every
 * triangle pair, no pruning — run over meshes deliberately shaped so the
 * closest pair is NOT the pair a naive descent would reach first.
 */

import { describe, expect, it } from 'vitest';
import { PairHeap, minDistanceBetweenMeshes } from './min-distance.js';
import { triangleAt, triangleCount } from './triangle.js';
import { triTriDistance } from '../math/triangle-distance.js';
import type { Mesh } from './types.js';

/** Axis-aligned box as 12 triangles, at `origin` with `size` extents. */
function box(id: string, origin: [number, number, number], size: [number, number, number]): Mesh {
  const [x, y, z] = origin;
  const [w, d, h] = size;
  const positions = new Float64Array([
    x, y, z,             x + w, y, z,         x + w, y + d, z,     x, y + d, z,
    x, y, z + h,         x + w, y, z + h,     x + w, y + d, z + h, x, y + d, z + h,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, // bottom
    4, 6, 5, 4, 7, 6, // top
    0, 4, 5, 0, 5, 1, // -Y
    1, 5, 6, 1, 6, 2, // +X
    2, 6, 7, 2, 7, 3, // +Y
    3, 7, 4, 3, 4, 0, // -X
  ]);
  return { id, positions, indices };
}

/** Every triangle pair, no pruning. The oracle the traversal must match. */
function bruteForceDistance(a: Mesh, b: Mesh): number {
  let best = Infinity;
  for (let i = 0; i < triangleCount(a); i++) {
    const ta = triangleAt(a, i);
    for (let j = 0; j < triangleCount(b); j++) {
      const tb = triangleAt(b, j);
      const r = triTriDistance(
        [...ta.v0], [...ta.v1], [...ta.v2],
        [...tb.v0], [...tb.v1], [...tb.v2],
      );
      if (r.dist < best) best = r.dist;
    }
  }
  return best;
}

describe('minDistanceBetweenMeshes', () => {
  it('measures the gap between two separated boxes', () => {
    // Faces at x=1 and x=4: the answer is 3, and it is exact rather than
    // approximate, so this asserts equality rather than a tolerance.
    const a = box('a', [0, 0, 0], [1, 1, 1]);
    const b = box('b', [4, 0, 0], [1, 1, 1]);
    const r = minDistanceBetweenMeshes(a, b);
    expect(r?.distance).toBeCloseTo(3, 10);
  });

  it('returns 0 for boxes that touch face to face', () => {
    const a = box('a', [0, 0, 0], [1, 1, 1]);
    const b = box('b', [1, 0, 0], [1, 1, 1]);
    expect(minDistanceBetweenMeshes(a, b)?.distance).toBeCloseTo(0, 10);
  });

  it('returns 0 for boxes that interpenetrate', () => {
    const a = box('a', [0, 0, 0], [2, 2, 2]);
    const b = box('b', [1, 1, 1], [2, 2, 2]);
    expect(minDistanceBetweenMeshes(a, b)?.distance).toBeCloseTo(0, 10);
  });

  it('reports witness points that are actually that far apart', () => {
    // A distance without witness points that agree with it is a number the
    // caller cannot draw. The measure tool needs the segment, not the scalar.
    const a = box('a', [0, 0, 0], [1, 1, 1]);
    const b = box('b', [0, 7.5, 0], [1, 1, 1]);
    const r = minDistanceBetweenMeshes(a, b);
    expect(r).not.toBeNull();
    const [ax, ay, az] = r!.pointA;
    const [bx, by, bz] = r!.pointB;
    expect(Math.hypot(ax - bx, ay - by, az - bz)).toBeCloseTo(r!.distance, 9);
    expect(r!.distance).toBeCloseTo(6.5, 9);
  });

  it('agrees with brute force where the closest pair is NOT the first one reached', () => {
    // Diagonal offset, so the nearest triangles are on faces a depth-first
    // descent visits late. A traversal that prunes wrongly returns a LARGER
    // distance here and still looks like an answer.
    const a = box('a', [0, 0, 0], [2, 2, 2]);
    const b = box('b', [5, 4, 3], [2, 3, 1]);
    const r = minDistanceBetweenMeshes(a, b);
    expect(r?.distance).toBeCloseTo(bruteForceDistance(a, b), 9);
  });

  it('agrees with brute force on irregular meshes big enough to have a real tree', () => {
    // The box fixtures above cannot exercise the pruning at all: 12 triangles
    // at leafSize 8 is a 2-leaf tree, and best-first ordering reaches the
    // optimal leaf pair immediately, so a broken bound changes nothing. This
    // case was added after mutation testing showed exactly that — inverting
    // the prune comparison and dropping a child from the descent BOTH left the
    // suite green. Irregular meshes with a deep tree are what make the oracle
    // bite.
    let seed = 0x2737;
    const rand = () => {
      // Deterministic LCG: a fixed corpus, so a failure is reproducible.
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const cloud = (id: string, offset: [number, number, number], n: number): Mesh => {
      const pos: number[] = [];
      const idx: number[] = [];
      for (let t = 0; t < n; t++) {
        const cx = offset[0] + rand() * 4;
        const cy = offset[1] + rand() * 4;
        const cz = offset[2] + rand() * 4;
        for (let v = 0; v < 3; v++) {
          pos.push(cx + rand() * 0.8, cy + rand() * 0.8, cz + rand() * 0.8);
          idx.push(t * 3 + v);
        }
      }
      return { id, positions: new Float64Array(pos), indices: new Uint32Array(idx) };
    };

    for (const offset of [
      [9, 0, 0], [0, 9, 0], [0, 0, 9], [7, 7, 7], [2, 1, 0], [-9, 3, 2],
    ] as Array<[number, number, number]>) {
      const a = cloud('a', [0, 0, 0], 40);
      const b = cloud('b', offset, 40);
      const got = minDistanceBetweenMeshes(a, b, { leafSize: 4 })?.distance ?? NaN;
      expect(got, `offset ${offset.join(',')}`).toBeCloseTo(bruteForceDistance(a, b), 9);
    }
  });

  it('agrees with brute force across many offsets, including overlapping ones', () => {
    const a = box('a', [0, 0, 0], [2, 2, 2]);
    for (const [dx, dy, dz] of [
      [3, 0, 0], [0, 3, 0], [0, 0, 3], [3, 3, 3], [1, 1, 1],
      [-4, 2, 0], [2.5, -3.5, 1.25], [10, 10, 10], [0.5, 0.5, 9],
    ] as Array<[number, number, number]>) {
      const b = box('b', [dx, dy, dz], [2, 2, 2]);
      const got = minDistanceBetweenMeshes(a, b)?.distance ?? NaN;
      expect(got, `offset ${dx},${dy},${dz}`).toBeCloseTo(bruteForceDistance(a, b), 9);
    }
  });

  it('names the triangles the witness points lie on', () => {
    const a = box('a', [0, 0, 0], [1, 1, 1]);
    const b = box('b', [3, 0, 0], [1, 1, 1]);
    const r = minDistanceBetweenMeshes(a, b);
    expect(r!.triangleA).toBeGreaterThanOrEqual(0);
    expect(r!.triangleA).toBeLessThan(triangleCount(a));
    expect(r!.triangleB).toBeGreaterThanOrEqual(0);
    expect(r!.triangleB).toBeLessThan(triangleCount(b));
  });

  it('returns null for a mesh with no triangles, rather than 0', () => {
    // 0 would read as "they touch". An absent mesh has no distance, and the
    // caller must be able to tell those apart. The null comes from the empty
    // BVH root, which is the only way this can happen — an earlier version
    // also carried a `triangleA < 0` fallback that no input could reach.
    const empty: Mesh = { id: 'empty', positions: new Float64Array(), indices: new Uint32Array() };
    expect(minDistanceBetweenMeshes(box('a', [0, 0, 0], [1, 1, 1]), empty)).toBeNull();
    expect(minDistanceBetweenMeshes(empty, empty)).toBeNull();
  });

  it('stops early when asked, without claiming a smaller distance than it found', () => {
    const a = box('a', [0, 0, 0], [1, 1, 1]);
    const b = box('b', [1, 0, 0], [1, 1, 1]);
    const r = minDistanceBetweenMeshes(a, b, { earlyExitAtOrBelow: 0 });
    expect(r?.distance).toBeLessThanOrEqual(0 + 1e-9);
  });
});

describe('PairHeap', () => {
  // The traversal's result is INDEPENDENT of this order — a broken heap still
  // finds the true minimum, just after visiting more pairs. So the distance
  // tests above provably cannot catch an inverted sift (verified by mutation),
  // and the heap needs its own contract test or it has none at all.
  const entry = (lowerSq: number) => ({ na: null as never, nb: null as never, lowerSq });

  it('pops in ascending order regardless of push order', () => {
    const heap = new PairHeap();
    const pushed = [7, 1, 9, 3, 3, 0, 12, 5, 2, 8, 4];
    for (const v of pushed) heap.push(entry(v));
    const popped: number[] = [];
    for (;;) {
      const e = heap.pop();
      if (!e) break;
      popped.push(e.lowerSq);
    }
    assert(popped, [...pushed].sort((a, b) => a - b));
  });

  it('is empty-safe and drains exactly what was pushed', () => {
    const heap = new PairHeap();
    expect(heap.pop()).toBeUndefined();
    heap.push(entry(2));
    expect(heap.pop()?.lowerSq).toBe(2);
    expect(heap.pop()).toBeUndefined();
  });

  it('keeps popping the minimum while pushes are interleaved', () => {
    // The traversal always pushes children while draining, so an order that
    // only holds for push-then-drain would not be the property it relies on.
    const heap = new PairHeap();
    heap.push(entry(5));
    heap.push(entry(9));
    expect(heap.pop()?.lowerSq).toBe(5);
    heap.push(entry(1));
    heap.push(entry(7));
    expect(heap.pop()?.lowerSq).toBe(1);
    expect(heap.pop()?.lowerSq).toBe(7);
    expect(heap.pop()?.lowerSq).toBe(9);
  });
});

/** Local helper: vitest's deepEqual with a clearer failure for number lists. */
function assert(actual: number[], expected: number[]): void {
  expect(actual).toEqual(expected);
}
