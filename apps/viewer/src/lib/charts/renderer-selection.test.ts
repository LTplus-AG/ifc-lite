/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chartAwareRendererSelection } from './renderer-selection.js';

describe('chart-aware renderer selection (#4832)', () => {
  it('keeps logical chart ids out of the blue renderer highlight while chart colour is active', () => {
    const result = chartAwareRendererSelection(12, new Set([11, 12]), new Set([11, 12]), new Map([[11, true], [12, true]]));
    assert.equal(result.selectedId, null);
    assert.deepEqual([...result.selectedIds], []);
  });

  it('suppresses only chart ids that still have live paint', () => {
    const active = chartAwareRendererSelection(99, new Set([11, 12, 99]), new Set([11, 12]), new Map([[11, true]]));
    assert.equal(active.selectedId, 99);
    assert.deepEqual([...active.selectedIds], [12, 99]);
  });

  it('returns the original set after chart paint teardown and caches active filtering by identity', () => {
    const selected = new Set([11, 12]);
    const slice = new Set([11, 12]);
    const paint = new Map([[11, true], [12, true]]);
    const first = chartAwareRendererSelection(12, selected, slice, paint);
    const repeated = chartAwareRendererSelection(12, selected, slice, paint);
    assert.equal(repeated, first);

    const inactive = chartAwareRendererSelection(12, selected, slice, null);
    assert.equal(inactive.selectedId, 12);
    assert.equal(inactive.selectedIds, selected);
  });
});
