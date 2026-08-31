/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boundary-pinning test for the inflated-AABB overlap test in
 * `contact/mesh-bvh.ts`. Mutation testing (flipping `<=` to `<` on
 * `boundsOverlap`'s first axis clause) found zero test coverage: nothing sat
 * exactly on the eps-inflated touching boundary. Unlike `bvh.ts`'s
 * `boundsOverlapInflated`, this `boundsOverlap` has no `eps === 0`
 * short-circuit, so any eps value reaches the same comparison.
 */

import { describe, expect, it } from "vitest";
import { buildMeshBvh, queryMeshCross } from "./mesh-bvh.js";
import type { Mesh } from "./types.js";

function triMesh(id: string, v0: [number, number, number], v1: [number, number, number], v2: [number, number, number]): Mesh {
  return {
    id,
    positions: new Float32Array([...v0, ...v1, ...v2]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe("queryMeshCross — inflated-bounds closed-interval touch (mesh-bvh.ts:107)", () => {
  it("reports a triangle pair whose eps-inflated AABBs touch exactly (not merely overlap)", () => {
    const eps = 0.5;
    // Triangle A's AABB is [1,0,0]-[2,1,1]; triangle B's is [-1,0,0]-[0,1,1].
    // a.min[0] - eps === b.max[0] + eps exactly (1 - 0.5 === 0 + 0.5): the
    // inflated boxes touch exactly on x, and clearly overlap on y/z.
    const meshA = triMesh("A", [1, 0, 0], [2, 1, 0], [1, 0, 1]);
    const meshB = triMesh("B", [-1, 0, 0], [0, 1, 0], [-1, 0, 1]);
    const bvhA = buildMeshBvh(meshA);
    const bvhB = buildMeshBvh(meshB);
    expect(queryMeshCross(bvhA, bvhB, eps)).toEqual([[0, 0]]);
  });
});

/**
 * `queryMeshCross` used to funnel its result through a
 * `Set<`${triA}|${triB}`>` "belt and braces" dedup. That set is
 * O(triangles_A * triangles_B) in both allocation and entry count for a
 * SINGLE element pair, with no cap — and `Set` shares V8's hard 2^24-entry
 * ceiling, above which `set()` throws `RangeError`. It also bought nothing:
 *
 *   - `buildNode` (bvh.ts) splits `indices` into `slice(0, mid)` and
 *     `slice(mid)` — disjoint and covering — and a leaf stores exactly its
 *     own `indices.slice()`. So every triangle index lives in exactly ONE
 *     leaf: leaves PARTITION the triangle set, they do not overlap.
 *   - `crossNode` reaches any node pair (u, w) by a single path from
 *     (rootA, rootB): from a pair it descends BOTH sides when both are
 *     internal, and only the internal side when the other is a leaf. Since
 *     each node has one parent, the route to (u, w) is forced.
 *
 * Hence each (leafA, leafB) pair is visited once and each (triA, triB) is
 * emitted at most once. These tests prove that empirically rather than
 * asserting it: on fixtures built to maximise duplicate opportunities, the
 * raw traversal output already carries no duplicates and already equals the
 * exact brute-force answer — so removing the set cannot change the result.
 */
describe("queryMeshCross — leaves partition, so the traversal cannot emit a duplicate", () => {
  /** A mesh of `n` axis-aligned triangles, all overlapping each other. */
  function overlappingMesh(id: string, n: number, jitter: number): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      const d = i * jitter;
      positions.push(d, d, d, d + 1, d, d, d, d + 1, d);
      indices.push(i * 3, i * 3 + 1, i * 3 + 2);
    }
    return { id, positions: new Float64Array(positions), indices: new Uint32Array(indices) };
  }

  /** Deterministic pseudo-random mesh — no seeded-RNG dependency. */
  function scatterMesh(id: string, n: number, seed: number): Mesh {
    let s = seed;
    const rnd = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = rnd() * 4;
      const y = rnd() * 4;
      const z = rnd() * 4;
      positions.push(x, y, z, x + rnd(), y, z, x, y + rnd(), z + rnd());
      indices.push(i * 3, i * 3 + 1, i * 3 + 2);
    }
    return { id, positions: new Float64Array(positions), indices: new Uint32Array(indices) };
  }

  /** Ground truth: every (iA, iB) whose eps-inflated AABBs overlap. */
  function bruteForce(a: Mesh, b: Mesh, eps: number): Set<string> {
    const bvhA = buildMeshBvh(a, 1);
    const bvhB = buildMeshBvh(b, 1);
    const out = new Set<string>();
    for (const ia of bvhA.bvh.items) {
      for (const ib of bvhB.bvh.items) {
        const x = ia.aabb;
        const y = ib.aabb;
        const hit =
          x.min[0] - eps <= y.max[0] + eps &&
          x.max[0] + eps >= y.min[0] - eps &&
          x.min[1] - eps <= y.max[1] + eps &&
          x.max[1] + eps >= y.min[1] - eps &&
          x.min[2] - eps <= y.max[2] + eps &&
          x.max[2] + eps >= y.min[2] - eps;
        if (hit) out.add(`${ia.id}|${ib.id}`);
      }
    }
    return out;
  }

  const cases: Array<{ name: string; a: Mesh; b: Mesh; leafSize: number; eps: number }> = [
    // Every triangle overlaps every other: the densest possible cross
    // product, and the case a dedup set would have had the most to do.
    { name: "fully overlapping, leafSize 1 (deepest tree)", a: overlappingMesh("A", 24, 0), b: overlappingMesh("B", 24, 0), leafSize: 1, eps: 0 },
    { name: "fully overlapping, leafSize 8 (production default)", a: overlappingMesh("A", 40, 0), b: overlappingMesh("B", 40, 0), leafSize: 8, eps: 0 },
    // Coincident AABBs: every centre ties on the split axis, so the median
    // sort is arbitrary — the harshest test of "one leaf per triangle".
    { name: "degenerate: all AABBs identical", a: overlappingMesh("A", 17, 0), b: overlappingMesh("B", 17, 0), leafSize: 3, eps: 0 },
    // Staircase: partial overlap, so pruning actually fires.
    { name: "staircase, partial overlap", a: overlappingMesh("A", 32, 0.3), b: overlappingMesh("B", 32, 0.3), leafSize: 4, eps: 0.05 },
    // Odd triangle counts exercise the uneven `mid` split at every level.
    { name: "odd counts, scattered", a: scatterMesh("A", 37, 7), b: scatterMesh("B", 53, 991), leafSize: 2, eps: 0.25 },
    { name: "scattered, large eps (near-total overlap)", a: scatterMesh("A", 29, 3), b: scatterMesh("B", 31, 17), leafSize: 5, eps: 10 },
    // Lopsided trees: one mesh a single triangle, the other deep.
    { name: "one triangle vs many", a: overlappingMesh("A", 1, 0), b: overlappingMesh("B", 64, 0), leafSize: 1, eps: 0 },
    { name: "many vs one triangle", a: overlappingMesh("A", 64, 0), b: overlappingMesh("B", 1, 0), leafSize: 1, eps: 0 },
  ];

  for (const c of cases) {
    it(`emits every overlapping pair exactly once — ${c.name}`, () => {
      const pairs = queryMeshCross(buildMeshBvh(c.a, c.leafSize), buildMeshBvh(c.b, c.leafSize), c.eps);

      // 1. No duplicate survives to the caller...
      const keys = pairs.map((p) => `${p[0]}|${p[1]}`);
      expect(new Set(keys).size).toBe(keys.length);

      // 2. ...and none was removed on the way, either: the emitted count
      // equals the exact number of overlapping pairs. A traversal that
      // double-visited a leaf pair would produce MORE than this, so a set
      // that "fixed" it would show up here as a count mismatch.
      const expected = bruteForce(c.a, c.b, c.eps);
      expect(keys.length).toBe(expected.size);
      expect(new Set(keys)).toEqual(expected);
    });
  }

  it("covers a case where a duplicate would actually have been possible", () => {
    // Guard against a vacuous suite: the fixtures above must produce real,
    // plentiful pairs from multi-leaf trees on both sides — not one pair
    // from two single-leaf trees, where nothing could ever duplicate.
    const a = overlappingMesh("A", 40, 0);
    const b = overlappingMesh("B", 40, 0);
    const pairs = queryMeshCross(buildMeshBvh(a, 8), buildMeshBvh(b, 8), 0);
    expect(pairs.length).toBe(40 * 40);
    // leafSize 8 over 40 triangles is 5+ leaves per side, i.e. 25+ distinct
    // leaf-pair visits — the traversal really does revisit nodes, just never
    // the same PAIR of them.
    expect(buildMeshBvh(a, 8).bvh.root?.items).toBeUndefined();
  });

  it("assigns each triangle to exactly one leaf (the partition itself)", () => {
    // The claim the removal rests on, checked directly on the tree.
    const mesh = scatterMesh("A", 100, 42);
    const { bvh } = buildMeshBvh(mesh, 4);
    const seen: number[] = [];
    const walk = (node: NonNullable<typeof bvh.root>): void => {
      if (node.items) {
        seen.push(...node.items);
        return;
      }
      if (node.left) walk(node.left);
      if (node.right) walk(node.right);
    };
    walk(bvh.root!);
    expect(seen.length).toBe(100);
    expect(new Set(seen).size).toBe(100);
    expect([...seen].sort((x, y) => x - y)).toEqual([...Array(100).keys()]);
  });
});

/**
 * Regression: one degenerate (NaN-vertexed) triangle in a mesh must not hide
 * OTHER, perfectly valid triangles from `queryMeshCross` — the false-negative
 * class fixed in `unionAabb` (`aabb.ts`). `buildNode` (`bvh.ts`) folds
 * `unionAabb` bottom-up over every ancestor of a leaf, and with the old
 * `Math.min`/`Math.max` implementation a single NaN leaf poisoned every
 * ancestor's aggregate bounds up to and including the root — so
 * `crossNode`'s `boundsOverlap(rootA.bounds, rootB.bounds)` failed and the
 * traversal was pruned before visiting anything, silently reporting NO
 * contact between two meshes that genuinely intersect.
 */
describe("queryMeshCross — a NaN-vertexed triangle does not poison sibling triangles", () => {
  /**
   * A mesh of `n` triangles spaced apart on a line (gap of 1 between each,
   * so neighbours' AABBs neither touch nor overlap), one of which has NaN
   * vertices.
   */
  function meshWithOneNanTriangle(id: string, n: number, nanAt: number): Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i === nanAt) {
        positions.push(NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN);
      } else {
        const x = i * 2;
        positions.push(x, 0, 0, x + 1, 0, 0, x, 1, 0);
      }
      indices.push(i * 3, i * 3 + 1, i * 3 + 2);
    }
    return { id, positions: new Float64Array(positions), indices: new Uint32Array(indices) };
  }

  /** A single triangle exactly matching mesh index `i`'s slot from above. */
  function overlappingTriangle(i: number): Mesh {
    const x = i * 2;
    return {
      id: "B",
      positions: new Float64Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
  }

  it("still reports a cross with a valid sibling triangle when another triangle is NaN-vertexed", () => {
    // 12 triangles (> the default leafSize of 8) so the tree has internal
    // nodes whose aggregate bounds is what a NaN would poison; the NaN
    // triangle sits at index 0, the crossing triangle (index 5) is in a
    // different subtree.
    const meshA = meshWithOneNanTriangle("A", 12, 0);
    const meshB = overlappingTriangle(5);
    const bvhA = buildMeshBvh(meshA, 4);
    const bvhB = buildMeshBvh(meshB, 4);

    const pairs = queryMeshCross(bvhA, bvhB, 0);

    expect(pairs).toEqual([[5, 0]]);
  });

  it("still reports a cross when the NaN triangle sits deep in the tree, not just at index 0", () => {
    const meshA = meshWithOneNanTriangle("A", 20, 13);
    const meshB = overlappingTriangle(2);
    const bvhA = buildMeshBvh(meshA, 4);
    const bvhB = buildMeshBvh(meshB, 4);

    const pairs = queryMeshCross(bvhA, bvhB, 0);

    expect(pairs).toEqual([[2, 0]]);
  });
});
