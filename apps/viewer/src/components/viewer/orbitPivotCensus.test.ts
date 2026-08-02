/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPivotRaycastTooExpensive,
  PIVOT_RAYCAST_MAX_ENTITIES,
  PIVOT_RAYCAST_MAX_INDICES,
  type PivotCensusScene,
} from './orbitPivotCensus.js';

const scene = (opts: {
  meshes?: number;
  instanced?: number;
  batches?: Array<{ ids: number; indices: number }>;
}): PivotCensusScene => ({
  getMeshes: () => new Array(opts.meshes ?? 0),
  getInstancedEntityCount: () => opts.instanced ?? 0,
  getBatchedMeshes: () =>
    (opts.batches ?? []).map((b) => ({
      expressIds: new Array(b.ids),
      indexCount: b.indices,
    })),
});

describe('isPivotRaycastTooExpensive', () => {
  it('allows the raycast on small models', () => {
    const small = scene({ meshes: 10, instanced: 100, batches: [{ ids: 5_000, indices: 300_000 }] });
    assert.equal(isPivotRaycastTooExpensive(small), false);
  });

  it('skips above the entity threshold (flat batch entities)', () => {
    const big = scene({ batches: [{ ids: PIVOT_RAYCAST_MAX_ENTITIES + 1, indices: 0 }] });
    assert.equal(isPivotRaycastTooExpensive(big), true);
  });

  it('counts GPU-instanced entities: an instanced-heavy model must not read small', () => {
    // The CATIA regression: ~22K flat entities (under the threshold) but tens
    // of thousands of instanced occurrences that the raycast materializes.
    const catiaLike = scene({ instanced: 37_000, batches: [{ ids: 22_000, indices: 0 }] });
    assert.equal(isPivotRaycastTooExpensive(catiaLike), true);
    const flatOnly = scene({ instanced: 0, batches: [{ ids: 22_000, indices: 0 }] });
    assert.equal(isPivotRaycastTooExpensive(flatOnly), false);
  });

  it('skips a purely-instanced scene with NO batched meshes (loop never runs)', () => {
    const instancedOnly = scene({ instanced: PIVOT_RAYCAST_MAX_ENTITIES + 1 });
    assert.equal(isPivotRaycastTooExpensive(instancedOnly), true);
  });

  it('skips above the triangle threshold even with few entities', () => {
    const dense = scene({ batches: [{ ids: 100, indices: PIVOT_RAYCAST_MAX_INDICES + 3 }] });
    assert.equal(isPivotRaycastTooExpensive(dense), true);
  });

  it('accumulates across batches', () => {
    const half = { ids: 20_000, indices: PIVOT_RAYCAST_MAX_INDICES / 2 };
    assert.equal(isPivotRaycastTooExpensive(scene({ batches: [half] })), false);
    assert.equal(isPivotRaycastTooExpensive(scene({ batches: [half, half, half] })), true);
  });
});
