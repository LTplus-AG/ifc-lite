/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  robustFitBoundsFull,
  createRobustFitBoundsAccumulator,
  type RobustFitMeshInput,
} from './robustFitBoundsAccumulator.js';

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function meshAt(cx: number, cy: number, cz: number, spread: number, n: number, rng: () => number): RobustFitMeshInput {
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = cx + (rng() - 0.5) * spread;
    positions[i * 3 + 1] = cy + (rng() - 0.5) * spread;
    positions[i * 3 + 2] = cz + (rng() - 0.5) * spread;
  }
  return { positions };
}

// A cluster of `count` compact meshes plus a handful of far outlier meshes —
// shaped to trigger the `robust` (outlier-trimmed) branch: count >= 8,
// dropping the outliers meaningfully shrinks the box (< 0.66x).
function clusterWithOutliers(count: number, outliers: number, rng: () => number): RobustFitMeshInput[] {
  const meshes: RobustFitMeshInput[] = [];
  for (let i = 0; i < count; i++) {
    // Vertex mass matters more than mesh count for the 99.5%-mass keep
    // threshold — keep each cluster mesh's vertex count well above the
    // outliers' so the outliers stay under the ~0.5% trim margin.
    meshes.push(meshAt(rng() * 2, rng() * 2, rng() * 2, 0.5, 40, rng));
  }
  for (let i = 0; i < outliers; i++) {
    // A single vertex each keeps total outlier mass tiny relative to the
    // cluster, so the 99.5%-mass threshold actually drops them.
    meshes.push(meshAt(5000 + rng() * 10, 5000 + rng() * 10, 5000 + rng() * 10, 1, 1, rng));
  }
  return meshes;
}

describe('robustFitBounds: incremental accumulator matches full rescan', () => {
  it('zero meshes → both null', () => {
    const acc = createRobustFitBoundsAccumulator();
    const meshes: RobustFitMeshInput[] = [];
    assert.deepEqual(acc.update(meshes), robustFitBoundsFull(meshes));
    assert.equal(acc.update(meshes), null);
  });

  it('one mesh → full bounds only (count < 8), robust null', () => {
    const rng = mulberry32(1);
    const meshes = [meshAt(0, 0, 0, 10, 5, rng)];
    const acc = createRobustFitBoundsAccumulator();
    const result = acc.update(meshes);
    assert.deepEqual(result, robustFitBoundsFull(meshes));
    assert.notEqual(result, null);
    assert.equal(result!.robust, null);
  });

  it('mesh with zero vertices (empty positions) contributes nothing, does not crash', () => {
    const rng = mulberry32(2);
    const meshes = [meshAt(0, 0, 0, 5, 3, rng), { positions: new Float32Array(0) }, meshAt(1, 1, 1, 5, 3, rng)];
    const acc = createRobustFitBoundsAccumulator();
    assert.deepEqual(acc.update(meshes), robustFitBoundsFull(meshes));
  });

  it('mesh with ALL non-finite / garbage coordinates is filtered out (n stays 0 for it)', () => {
    const rng = mulberry32(3);
    const garbage: RobustFitMeshInput = { positions: Float32Array.of(NaN, NaN, NaN, Infinity, -Infinity, 1e20) };
    const meshes = [meshAt(0, 0, 0, 5, 4, rng), garbage, meshAt(2, 2, 2, 5, 4, rng)];
    const acc = createRobustFitBoundsAccumulator();
    const result = acc.update(meshes);
    assert.deepEqual(result, robustFitBoundsFull(meshes));
    assert.notEqual(result, null);
  });

  it('a mesh with a MIX of finite and garbage vertices only folds the finite ones into that mesh\'s box', () => {
    const rng = mulberry32(4);
    const mixed: RobustFitMeshInput = {
      positions: Float32Array.of(1, 1, 1, NaN, NaN, NaN, 2, 2, 2, 1e13, 1e13, 1e13),
    };
    const meshes = [mixed, meshAt(0, 0, 0, 3, 6, rng)];
    const acc = createRobustFitBoundsAccumulator();
    assert.deepEqual(acc.update(meshes), robustFitBoundsFull(meshes));
  });

  it('per-element origin is folded in identically', () => {
    const rng = mulberry32(5);
    const withOrigin: RobustFitMeshInput = {
      positions: Float32Array.of(1, 1, 1, -1, -1, -1),
      origin: [1000, 2000, 3000],
    };
    const meshes = [withOrigin, meshAt(0, 0, 0, 5, 6, rng)];
    const acc = createRobustFitBoundsAccumulator();
    assert.deepEqual(acc.update(meshes), robustFitBoundsFull(meshes));
  });

  it('outlier-robust branch: incremental result matches full rescan once the tail triggers `robust`', () => {
    const rng = mulberry32(6);
    const meshes = clusterWithOutliers(20, 2, rng);
    const acc = createRobustFitBoundsAccumulator();
    const result = acc.update(meshes);
    const expected = robustFitBoundsFull(meshes);
    assert.deepEqual(result, expected);
    // Sanity: this fixture is actually supposed to exercise the robust path.
    assert.notEqual(expected, null);
    assert.notEqual(expected!.robust, null);
  });

  it('streaming simulation: same array reference growing via push, matches full rescan at every commit (compact model)', () => {
    const rng = mulberry32(7);
    const acc = createRobustFitBoundsAccumulator();
    const meshes: RobustFitMeshInput[] = [];
    for (let commit = 0; commit < 30; commit++) {
      const batchSize = 1 + Math.floor(rng() * 10);
      for (let i = 0; i < batchSize; i++) {
        meshes.push(meshAt(rng() * 3, rng() * 3, rng() * 3, 1, 1 + Math.floor(rng() * 8), rng));
      }
      assert.deepEqual(acc.update(meshes), robustFitBoundsFull(meshes), `mismatch at commit ${commit}`);
    }
  });

  it('streaming simulation with a growing outlier tail: robust/full both track the full rescan every commit', () => {
    const rng = mulberry32(8);
    const acc = createRobustFitBoundsAccumulator();
    const meshes: RobustFitMeshInput[] = [];
    for (let commit = 0; commit < 25; commit++) {
      const batchSize = 1 + Math.floor(rng() * 6);
      for (let i = 0; i < batchSize; i++) {
        const isOutlier = commit > 10 && rng() < 0.1;
        meshes.push(
          isOutlier
            ? meshAt(8000 + rng() * 20, 8000 + rng() * 20, 8000 + rng() * 20, 2, 4, rng)
            : meshAt(rng() * 2, rng() * 2, rng() * 2, 0.8, 1 + Math.floor(rng() * 6), rng),
        );
      }
      assert.deepEqual(acc.update(meshes), robustFitBoundsFull(meshes), `mismatch at commit ${commit}`);
    }
  });

  it('new array identity (new file) resets the accumulator instead of mixing in stale meshes', () => {
    const rng = mulberry32(9);
    const acc = createRobustFitBoundsAccumulator();
    const first = [meshAt(0, 0, 0, 2, 5, rng), meshAt(1, 1, 1, 2, 5, rng)];
    assert.deepEqual(acc.update(first), robustFitBoundsFull(first));

    const second = [meshAt(500, 500, 500, 3, 6, rng)];
    const result = acc.update(second);
    assert.deepEqual(result, robustFitBoundsFull(second));
    // Confirms the old cluster's bounds are gone, not unioned in.
    assert.ok(result!.full.min.x > 400);
  });

  it('array shrink (same reference, spliced shorter) triggers a full refold, not a stale/overcounted result', () => {
    const rng = mulberry32(10);
    const meshes = [meshAt(0, 0, 0, 2, 5, rng), meshAt(1, 1, 1, 2, 5, rng), meshAt(2, 2, 2, 2, 5, rng)];
    const acc = createRobustFitBoundsAccumulator();
    assert.deepEqual(acc.update(meshes), robustFitBoundsFull(meshes));

    meshes.length = 1;
    const result = acc.update(meshes);
    assert.deepEqual(result, robustFitBoundsFull(meshes));
  });

  it('explicit reset() matches a brand-new accumulator on the next update', () => {
    const rng = mulberry32(11);
    const meshes = clusterWithOutliers(15, 1, rng);

    const fresh = createRobustFitBoundsAccumulator();
    const fromFresh = fresh.update(meshes);

    const reused = createRobustFitBoundsAccumulator();
    reused.update(meshes);
    reused.reset();
    const fromReset = reused.update(meshes);

    assert.deepEqual(fromReset, fromFresh);
  });

  it('a call with no new meshes since the last call is idempotent and matches the full rescan', () => {
    const rng = mulberry32(12);
    const meshes = clusterWithOutliers(20, 2, rng);
    const acc = createRobustFitBoundsAccumulator();
    const first = acc.update(meshes);
    const second = acc.update(meshes); // no growth
    assert.deepEqual(second, first);
    assert.deepEqual(second, robustFitBoundsFull(meshes));
  });
});

// ── #5387: detached coordination markers ──────────────────────────────────
// The buildingSMART sample files carry an `origin` cube and a `geo-reference`
// compass glyph (IfcBuildingElementProxy) placed at the coordination origin,
// away from the model. The glyph is vertex-heavy (1272 of Building-
// Architecture's 1884 vertices), so the 99.5%-vertex-mass trim could never
// reach it, and Building-Hvac has only 5 meshes, under that trim's minimum of
// 8. The fixtures below reproduce those measured layouts.

/** An axis-aligned box mesh: its 8 corners, repeated up to `verts` vertices. */
function box(min: [number, number, number], max: [number, number, number], verts = 24): RobustFitMeshInput {
  const positions = new Float32Array(verts * 3);
  for (let i = 0; i < verts; i++) {
    positions[i * 3] = i & 1 ? max[0] : min[0];
    positions[i * 3 + 1] = i & 2 ? max[1] : min[1];
    positions[i * 3 + 2] = i & 4 ? max[2] : min[2];
  }
  return { positions };
}

/** The geo-reference glyph: 1.6 x 0.1 x 1.7, 1272 vertices, ~30 m out. */
const GLYPH = () => box([-29.6, -1.35, 13.3], [-28, -1.25, 15], 1272);

type Box = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
function assertBox(actual: Box | null | undefined, min: number[], max: number[], what: string) {
  assert.ok(actual, `${what}: expected a robust framing box`);
  const got = [actual.min.x, actual.min.y, actual.min.z, actual.max.x, actual.max.y, actual.max.z];
  const want = [...min, ...max];
  got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-4, `${what}: ${got} vs ${want}`));
}

describe('robustFitBounds drops detached coordination markers (#5387)', () => {
  it('frames the house, not the vertex-heavy geo-reference glyph (Building-Architecture layout)', () => {
    const house: RobustFitMeshInput[] = [];
    for (let i = 0; i < 12; i++) house.push(box([3 + (i % 4), 0, -9 + (i % 3)], [6 + (i % 4), 3 + (i % 2), -4 + (i % 3)]));
    const meshes = [...house, GLYPH()];
    const result = robustFitBoundsFull(meshes);
    assertBox(result?.robust, [3, 0, -9], [9, 4, -2], 'house framing');
    assert.deepEqual(createRobustFitBoundsAccumulator().update(meshes), result, 'incremental path agrees');
  });

  it('works below the 8-mesh minimum: a 3-mesh chimney, the origin cube and the glyph (Building-Hvac layout)', () => {
    const chimney = [
      box([7.6, 4.7, -8.3], [8.3, 4.9, -7.6]),
      box([7.8, 0.9, -8.1], [8, 4.7, -7.9]),
      box([7.75, 0.7, -8.2], [8.05, 0.9, -7.6]),
    ];
    const origin = box([0, 0, -1], [1, 1, 0]);
    const result = robustFitBoundsFull([...chimney, origin, GLYPH()]);
    assertBox(result?.robust, [7.6, 0.7, -8.3], [8.3, 4.9, -7.6], 'chimney framing');
  });

  it('keeps a second structure of comparable size, even well apart (Infra-Bridge has two bridges)', () => {
    const meshes: RobustFitMeshInput[] = [];
    for (let i = 0; i < 10; i++) meshes.push(box([i * 3, 0, 0], [i * 3 + 3, 5, 8]));
    for (let i = 0; i < 10; i++) meshes.push(box([45 + i * 3, 0, 0], [45 + i * 3 + 3, 5, 8]));
    assert.equal(robustFitBoundsFull(meshes)?.robust, null);
  });

  it('keeps a marker beside the model envelope (Infra-Plumbing: the glyph sits by the pipe runs)', () => {
    const meshes: RobustFitMeshInput[] = [];
    for (let i = 0; i < 10; i++) meshes.push(box([-26 + i * 7, -2, -45], [-20 + i * 7, 0, -5]));
    meshes.push(box([-0.9, 0.05, -0.9], [0.9, 0.15, 0.9], 1272));
    assert.equal(robustFitBoundsFull(meshes)?.robust, null);
  });

  it('keeps a small outbuilding one model-length away (PR #5460 review)', () => {
    const meshes: RobustFitMeshInput[] = [];
    for (let i = 0; i < 10; i++) meshes.push(box([i, 0, 0], [i + 1, 1, 1]));
    meshes.push(box([25, 0, 0], [26, 1, 1]));
    assert.equal(robustFitBoundsFull(meshes)?.robust, null);
  });

  it('never drops a majority: three meshes far apart stay framed together', () => {
    const meshes = [box([0, 0, 0], [1, 1, 1]), box([100, 0, 0], [101, 1, 1]), box([200, 0, 0], [201, 1, 1])];
    assert.equal(robustFitBoundsFull(meshes)?.robust, null);
  });
});
