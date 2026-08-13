/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `isEntityVisible` is the hide/isolate rule that flat batches, GPU-instanced
 * occurrences and the Cesium world view all answer with (#2578). The cases that
 * matter are the ones where a plausible re-implementation would drift: the
 * empty isolated set, and hide-beats-isolate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEntityVisible } from './entity-visibility.js';

describe('isEntityVisible', () => {
  it('shows everything when neither filter is active', () => {
    assert.equal(isEntityVisible(1, null, null), true);
    assert.equal(isEntityVisible(1, undefined, undefined), true);
  });

  it('hides an id in the hidden set', () => {
    assert.equal(isEntityVisible(1, new Set([1]), null), false);
    assert.equal(isEntityVisible(2, new Set([1]), null), true);
  });

  it('treats an empty hidden set as no filter', () => {
    assert.equal(isEntityVisible(1, new Set(), null), true);
  });

  it('shows only the isolated ids when isolation is active', () => {
    assert.equal(isEntityVisible(1, null, new Set([1])), true);
    assert.equal(isEntityVisible(2, null, new Set([1])), false);
  });

  it('treats an EMPTY isolated set as isolating nothing, not as no filter', () => {
    // The distinction the whole rule turns on: null means "no isolation", an
    // empty set means "isolate nothing", i.e. hide everything. Collapsing them
    // is the drift this shared helper exists to prevent.
    assert.equal(isEntityVisible(1, null, new Set()), false);
    assert.equal(isEntityVisible(1, null, null), true);
  });

  it('lets hiding win over isolation', () => {
    assert.equal(isEntityVisible(1, new Set([1]), new Set([1])), false);
  });
});
