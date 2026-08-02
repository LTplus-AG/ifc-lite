/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { classifyCacheTier, planCacheWrite, decideMeshOnlyCacheHit, type CacheTierOptions } from './cacheTier.js';

// Mirror the production constants (ifcConfig.ts). Not imported: ifcConfig reads
// import.meta.env at module load and can't be evaluated under `node:test`.
const MB = 1024 * 1024;
const MIN = 10 * MB; // CACHE_SIZE_THRESHOLD
const MAX_SOURCE = 150 * MB; // CACHE_MAX_SOURCE_SIZE
const MAX_MESH_ONLY = 400 * MB; // CACHE_MESH_ONLY_MAX_SIZE

const base: Omit<CacheTierOptions, 'meshOnlyEnabled'> = {
  minSize: MIN,
  maxSourceSize: MAX_SOURCE,
  maxMeshOnlySize: MAX_MESH_ONLY,
};
const on: CacheTierOptions = { ...base, meshOnlyEnabled: true };
const off: CacheTierOptions = { ...base, meshOnlyEnabled: false };

describe('classifyCacheTier', () => {
  it('does not cache files below the min threshold', () => {
    assert.equal(classifyCacheTier(MIN - 1, on), 'none');
    assert.equal(classifyCacheTier(0, on), 'none');
  });

  it('uses the source tier from the min threshold up to and including 150MB', () => {
    assert.equal(classifyCacheTier(MIN, on), 'source');
    assert.equal(classifyCacheTier(MAX_SOURCE, on), 'source');
    // The source tier never depends on the mesh-only flag.
    assert.equal(classifyCacheTier(MAX_SOURCE, off), 'source');
  });

  it('uses the mesh-only tier in (150MB, 400MB] when the flag is on', () => {
    assert.equal(classifyCacheTier(MAX_SOURCE + 1, on), 'mesh-only');
    assert.equal(classifyCacheTier(MAX_MESH_ONLY, on), 'mesh-only');
  });

  it('never uses the mesh-only tier when the flag is off (no <=150MB regression)', () => {
    assert.equal(classifyCacheTier(MAX_SOURCE + 1, off), 'none');
    assert.equal(classifyCacheTier(MAX_MESH_ONLY, off), 'none');
  });

  it('does not cache files above the mesh-only ceiling even with the flag on', () => {
    assert.equal(classifyCacheTier(MAX_MESH_ONLY + 1, on), 'none');
  });
});

describe('planCacheWrite', () => {
  it('persists the source for the <=150MB tier (default path UNCHANGED)', () => {
    // The source tier persists the source regardless of the mesh-only flag: the
    // classic <=150MB behaviour must not regress when the tier is on OR off.
    for (const opts of [on, off]) {
      const plan = planCacheWrite(MAX_SOURCE, opts);
      assert.deepEqual(plan, { tier: 'source', shouldCache: true, persistSource: true });
    }
    const plan = planCacheWrite(MIN, on);
    assert.equal(plan.persistSource, true);
    assert.equal(plan.shouldCache, true);
  });

  it('does NOT persist the source for the mesh-only tier (150-400MB, enabled)', () => {
    const plan = planCacheWrite(MAX_SOURCE + 1, on);
    assert.deepEqual(plan, { tier: 'mesh-only', shouldCache: true, persistSource: false });
    assert.deepEqual(planCacheWrite(MAX_MESH_ONLY, on), {
      tier: 'mesh-only', shouldCache: true, persistSource: false,
    });
  });

  it('does not cache (shouldCache=false) when too small, too big, or mesh-only disabled', () => {
    assert.equal(planCacheWrite(MIN - 1, on).shouldCache, false);
    assert.equal(planCacheWrite(MAX_MESH_ONLY + 1, on).shouldCache, false);
    // Kill switch: a 150-400MB file is not cached when the tier is disabled.
    const disabled = planCacheWrite(MAX_SOURCE + 1, off);
    assert.deepEqual(disabled, { tier: 'none', shouldCache: false, persistSource: false });
  });
});

describe('decideMeshOnlyCacheHit', () => {
  it('MISSES when the fresh mtime differs from the stored one (a real on-disk edit)', () => {
    assert.equal(
      decideMeshOnlyCacheHit({ storedMtime: 1000, freshMtime: 2000, hasFullHash: true }),
      'miss',
    );
    // Even without a full hash to fall back on, a changed mtime is a miss.
    assert.equal(
      decideMeshOnlyCacheHit({ storedMtime: 1000, freshMtime: 2000, hasFullHash: false }),
      'miss',
    );
  });

  it('SERVES when the mtimes match (then the caller background-revalidates)', () => {
    assert.equal(
      decideMeshOnlyCacheHit({ storedMtime: 1000, freshMtime: 1000, hasFullHash: true }),
      'serve',
    );
    assert.equal(
      decideMeshOnlyCacheHit({ storedMtime: 1000, freshMtime: 1000, hasFullHash: false }),
      'serve',
    );
  });

  it('when mtime is UNAVAILABLE, serves only if a full hash can revalidate (never serve unvalidated)', () => {
    // 0 / undefined mtime = unknown. With a full hash → serve (background check
    // will validate); without one → miss (don't serve unvalidated).
    assert.equal(decideMeshOnlyCacheHit({ storedMtime: 0, freshMtime: 1000, hasFullHash: true }), 'serve');
    assert.equal(decideMeshOnlyCacheHit({ storedMtime: 0, freshMtime: 1000, hasFullHash: false }), 'miss');
    assert.equal(decideMeshOnlyCacheHit({ freshMtime: 1000, hasFullHash: true }), 'serve');
    assert.equal(decideMeshOnlyCacheHit({ hasFullHash: false }), 'miss');
  });
});
