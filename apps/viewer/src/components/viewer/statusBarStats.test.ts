/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStatsFull,
  createStatusBarStatsAccumulator,
  type StatusBarGeometryResult,
} from './statusBarStats.js';

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mesh(entityIds?: number[]): { entityIds?: Uint32Array } {
  return entityIds ? { entityIds: Uint32Array.from(entityIds) } : {};
}

function geo(meshes: { entityIds?: Uint32Array }[], totalTriangles = meshes.length * 2): StatusBarGeometryResult {
  return { meshes, totalTriangles };
}

describe('StatusBar stats: accumulator matches full rescan', () => {
  it('zero meshes', () => {
    const acc = createStatusBarStatsAccumulator();
    const g = geo([]);
    assert.deepEqual(acc.update(g), computeStatsFull(g));
    assert.deepEqual(acc.update(g), { elements: 0, triangles: 0 });
  });

  it('null geometryResult', () => {
    const acc = createStatusBarStatsAccumulator();
    assert.deepEqual(acc.update(null), computeStatsFull(null));
    assert.deepEqual(acc.update(null), { elements: 0, triangles: 0 });
  });

  it('one mesh, no entityIds → counts as 1', () => {
    const acc = createStatusBarStatsAccumulator();
    const g = geo([mesh()]);
    assert.deepEqual(acc.update(g), computeStatsFull(g));
    assert.deepEqual(acc.update(g).elements, 1);
  });

  it('one mesh, empty entityIds array → counts as 1 (falls to the `else` branch, same as no entityIds)', () => {
    const acc = createStatusBarStatsAccumulator();
    const g = geo([mesh([])]);
    assert.deepEqual(acc.update(g), computeStatsFull(g));
    assert.deepEqual(acc.update(g).elements, 1);
  });

  it('duplicate entityIds WITHIN a mesh dedupe to 1', () => {
    const acc = createStatusBarStatsAccumulator();
    const g = geo([mesh([5, 5, 5, 7])]);
    assert.deepEqual(acc.update(g), computeStatsFull(g));
    assert.deepEqual(acc.update(g).elements, 2);
  });

  it('duplicate entityIds ACROSS meshes do NOT dedupe globally — counted once per mesh', () => {
    const acc = createStatusBarStatsAccumulator();
    // Same entity id 42 appears in two different merged meshes.
    const g = geo([mesh([42, 1]), mesh([42, 2])]);
    const full = computeStatsFull(g);
    assert.deepEqual(full.elements, 4); // 2 (mesh0) + 2 (mesh1), no cross-mesh dedup
    assert.deepEqual(acc.update(g), full);
  });

  it('mesh with entityIds appended incrementally after a no-entityIds mesh', () => {
    const acc = createStatusBarStatsAccumulator();
    // `meshes` is the SAME array reference across every call below, grown via
    // `push` — mirroring `appendGeometryBatch` in dataSlice.ts. Only the
    // wrapping `geometryResult` object is rebuilt per commit, per the doc
    // comment in statusBarStats.ts. A `.slice()` here would hand the
    // accumulator a NEW identity on the first call, making every later call
    // look like a fresh array too and forcing a full reset+rescan instead of
    // exercising the append path — see PR #2400 review.
    const meshes: { entityIds?: Uint32Array }[] = [mesh()];
    let g = geo(meshes);
    assert.deepEqual(acc.update(g), computeStatsFull(g));
    assert.deepEqual(acc.update(g).elements, 1);

    meshes.push(mesh([1, 2, 3]));
    g = geo(meshes); // same array identity as would happen via appendGeometryBatch's push
    assert.deepEqual(acc.update(g), computeStatsFull(g));
    assert.deepEqual(acc.update(g).elements, 1 + 3);

    // A SECOND append onto the same reference, resuming from a NONZERO
    // scanned offset — the specific case a broken "reset and full-rescan
    // from 0 whenever the array grew" implementation cannot be told apart
    // from a genuinely incremental one without this step.
    meshes.push(mesh([9, 9, 10]));
    g = geo(meshes);
    assert.deepEqual(acc.update(g), computeStatsFull(g));
    assert.deepEqual(acc.update(g).elements, 1 + 3 + 2);
  });

  it('incremental streaming simulation: same array reference, growing via push, matches full rescan at every commit', () => {
    const rng = mulberry32(1234);
    const acc = createStatusBarStatsAccumulator();
    const meshes: { entityIds?: Uint32Array }[] = [];
    let nextId = 0;

    for (let commit = 0; commit < 40; commit++) {
      const batchSize = 1 + Math.floor(rng() * 15);
      for (let i = 0; i < batchSize; i++) {
        const hasEntityIds = rng() < 0.85;
        if (!hasEntityIds) {
          meshes.push(mesh());
          continue;
        }
        const count = 1 + Math.floor(rng() * 5);
        const ids: number[] = [];
        for (let j = 0; j < count; j++) {
          // Occasionally repeat an id seen in an EARLIER mesh, to exercise
          // the "no cross-mesh dedup" semantics, and occasionally repeat
          // WITHIN this mesh's own id list.
          if (ids.length > 0 && rng() < 0.3) {
            ids.push(ids[Math.floor(rng() * ids.length)]);
          } else if (nextId > 0 && rng() < 0.2) {
            ids.push(Math.floor(rng() * nextId));
          } else {
            ids.push(nextId++);
          }
        }
        meshes.push(mesh(ids));
      }
      // `meshes` is the SAME array reference every commit (push, like
      // dataSlice.ts's appendGeometryBatch) — this is the identity the
      // accumulator relies on.
      const g = geo(meshes, meshes.length * 3);
      assert.deepEqual(acc.update(g), computeStatsFull(g), `mismatch at commit ${commit}`);
    }
  });

  it('new array identity (file reload) resets the accumulator instead of serving stale counts', () => {
    const acc = createStatusBarStatsAccumulator();
    const first = geo([mesh([1, 2]), mesh([3])]);
    assert.deepEqual(acc.update(first), computeStatsFull(first));

    // A totally different meshes array (new file load) — must recount from
    // scratch, not append to the old total.
    const second = geo([mesh([9])]);
    assert.deepEqual(acc.update(second), computeStatsFull(second));
    assert.deepEqual(acc.update(second).elements, 1);
  });

  it('array shrink (e.g. a rebuilt/pruned meshes array) triggers a full recount, not a crash or stale count', () => {
    const acc = createStatusBarStatsAccumulator();
    const meshes = [mesh([1]), mesh([2]), mesh([3])];
    const g1 = geo(meshes);
    assert.deepEqual(acc.update(g1), computeStatsFull(g1));

    // Same array reference, but now shorter — mimics a splice/prune. The
    // accumulator's scannedLen would otherwise exceed the new length.
    meshes.length = 1;
    const g2 = geo(meshes);
    assert.deepEqual(acc.update(g2), computeStatsFull(g2));
    assert.deepEqual(acc.update(g2).elements, 1);
  });

  it('explicit reset() forces a full recount on the next update, matching a fresh accumulator', () => {
    const meshes = [mesh([1, 2]), mesh([3, 3, 4])];
    const g = geo(meshes);
    const fresh = createStatusBarStatsAccumulator();
    const fromFresh = fresh.update(g);

    const reused = createStatusBarStatsAccumulator();
    reused.update(g);
    reused.reset();
    const fromReset = reused.update(g);
    assert.deepEqual(fromReset, fromFresh);
  });

  it('triangles always reflects the latest geometryResult.totalTriangles, independent of the element scan', () => {
    const acc = createStatusBarStatsAccumulator();
    const meshes = [mesh([1])];
    assert.deepEqual(acc.update(geo(meshes, 100)).triangles, 100);
    // Same meshes array (no new meshes to scan) but totalTriangles changed.
    assert.deepEqual(acc.update(geo(meshes, 250)).triangles, 250);
  });
});
