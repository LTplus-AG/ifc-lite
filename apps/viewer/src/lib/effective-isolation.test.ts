/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `effectiveIsolatedIds` is what both the viewport and the Cesium world view
 * resolve `isolatedIds` with (#2578). The case that matters is the empty
 * computed set: it is a real isolation state ("nothing matched the filter"),
 * not an absent one, so it must NOT fall through to the store's set.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { effectiveIsolatedIds } from './effective-isolation.js';

describe('effectiveIsolatedIds', () => {
  it('is null when no isolation channel is active', () => {
    assert.equal(effectiveIsolatedIds(null, null), null);
    assert.equal(effectiveIsolatedIds(undefined, undefined), null);
  });

  it('prefers the computed set, which already folds storey and class filters in', () => {
    const computed = new Set([1]);
    const store = new Set([2]);

    assert.equal(effectiveIsolatedIds(computed, store), computed);
  });

  it('falls back to the store set when nothing is computed', () => {
    const store = new Set([2]);

    assert.equal(effectiveIsolatedIds(null, store), store);
  });

  it('keeps an EMPTY computed set rather than falling through to the store', () => {
    // "The filter matched nothing" is an isolation state that hides everything.
    // Falling through to the store's set here would show elements the viewport
    // has isolated away.
    const empty = new Set<number>();

    assert.equal(effectiveIsolatedIds(empty, new Set([2])), empty);
  });
});
