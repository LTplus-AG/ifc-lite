/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one staleness mechanism for the compare path (#1891): a value must
 * describe the world as of the moment it is returned, whether it came from a
 * cache or from an extraction that yielded while the world moved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildAtCurrentVersion } from './versionedBuild.js';

/** A value stamped with the world version it was built against. */
interface Stamped {
  stamp: number;
  id: string;
}

const isCurrent = (candidate: Stamped, version: number): boolean => candidate.stamp === version;

describe('buildAtCurrentVersion — abandon a run whose world moved under it', () => {
  it('reuses a cached value that still describes the world', async () => {
    let extractions = 0;
    const cached: Stamped = { stamp: 7, id: 'cached' };

    const built = await buildAtCurrentVersion<Stamped>({
      readVersion: () => 7,
      cached,
      isCurrent,
      extract: async (version) => { extractions += 1; return { stamp: version, id: 'fresh' }; },
    });

    assert.equal(built, cached, 'the cache must be reused verbatim');
    assert.equal(extractions, 0, 'reuse must not extract');
  });

  it('refuses a cached value built before the world moved', async () => {
    // Symptom 2: the fingerprint cache keyed only on the A/B model ids, reused
    // across a federation re-align that re-framed the very meshes it described.
    let extractions = 0;
    const built = await buildAtCurrentVersion<Stamped>({
      readVersion: () => 8,
      cached: { stamp: 7, id: 'stale' },
      isCurrent,
      extract: async (version) => { extractions += 1; return { stamp: version, id: 'fresh' }; },
      // ONE attempt: rejecting the stale cache has to happen up front, not be
      // rescued by a retry that a real run may not have left.
      maxAttempts: 1,
    });

    assert.equal(built?.id, 'fresh');
    assert.equal(built?.stamp, 8);
    assert.equal(extractions, 1, 'a stale cache must force exactly one extraction');
  });

  it('re-extracts when the world moves DURING the extraction', async () => {
    // Symptom 3: an in-flight run outliving the invalidation meant to cancel
    // it. `extract` yields; the world moves in that gap; the value it returns
    // describes a world that no longer exists and must not be returned.
    let version = 1;
    const stamps: number[] = [];
    const built = await buildAtCurrentVersion<Stamped>({
      readVersion: () => version,
      cached: null,
      isCurrent,
      extract: async (v) => {
        stamps.push(v);
        await new Promise((resolve) => setTimeout(resolve, 0));
        // A re-align lands while we are reading the meshes — but only once.
        if (v === 1) version = 2;
        return { stamp: v, id: `built-at-${v}` };
      },
    });

    assert.deepEqual(stamps, [1, 2], 'must extract again against the world that replaced it');
    assert.equal(built?.stamp, 2, 'the returned value must describe the CURRENT world');
  });

  it('does not reuse the cache again after an attempt was invalidated', async () => {
    // The cache was current when the attempt began, so a naive retry loop would
    // hand it back a second time and spin on the same stale value.
    let version = 1;
    const cached: Stamped = { stamp: 1, id: 'cached' };
    let extractions = 0;
    const built = await buildAtCurrentVersion<Stamped>({
      readVersion: () => {
        // Moves exactly once, between the reuse check and the re-check.
        const seen = version;
        if (version === 1) version = 2;
        return seen;
      },
      cached,
      isCurrent,
      extract: async (v) => { extractions += 1; return { stamp: v, id: 'fresh' }; },
    });

    assert.equal(extractions, 1, 'the invalidated cache must not be reused on the retry');
    assert.equal(built?.id, 'fresh');
  });

  it('gives up rather than returning a value it knows is stale', async () => {
    // A pathological stream of re-aligns must not spin here forever, and must
    // not resolve to something the caller would publish as current.
    let version = 0;
    let extractions = 0;
    const built = await buildAtCurrentVersion<Stamped>({
      readVersion: () => (version += 1),
      cached: null,
      isCurrent,
      extract: async (v) => { extractions += 1; return { stamp: v, id: 'never-current' }; },
      maxAttempts: 3,
    });

    assert.equal(built, null, 'exhaustion must report, not return a stale value');
    assert.equal(extractions, 3, 'must stop at maxAttempts');
  });

  it('defaults to a bounded number of attempts', async () => {
    let extractions = 0;
    const built = await buildAtCurrentVersion<Stamped>({
      readVersion: () => extractions * 100,
      cached: null,
      isCurrent,
      extract: async () => {
        extractions += 1;
        // Throw rather than let an unbounded loop hang the whole suite - a
        // hanging test reports nothing useful.
        if (extractions > 20) throw new Error(`unbounded retries: ${extractions}`);
        return { stamp: -1, id: 'never-current' };
      },
    });

    assert.equal(built, null);
    assert.ok(extractions > 0 && extractions <= 5, `unbounded retries: ${extractions}`);
  });
});
