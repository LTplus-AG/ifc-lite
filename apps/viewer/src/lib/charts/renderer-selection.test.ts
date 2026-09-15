/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chartAwareRendererSelection } from './renderer-selection.js';

describe('chart-aware renderer selection (#4832)', () => {
  it('keeps logical chart ids out of the blue renderer highlight while chart colour is active', () => {
    const result = chartAwareRendererSelection(12, new Set([11, 12]), true, new Set([11, 12]));
    assert.equal(result.selectedId, null);
    assert.deepEqual([...result.selectedIds], []);
  });

  it('preserves unrelated highlights and restores normal rendering when chart colour is off', () => {
    const active = chartAwareRendererSelection(99, new Set([11, 12, 99]), true, new Set([11, 12]));
    assert.equal(active.selectedId, 99);
    assert.deepEqual([...active.selectedIds], [99]);

    const inactive = chartAwareRendererSelection(12, new Set([11, 12]), false, new Set([11, 12]));
    assert.equal(inactive.selectedId, 12);
    assert.deepEqual([...inactive.selectedIds], [11, 12]);
  });
});
