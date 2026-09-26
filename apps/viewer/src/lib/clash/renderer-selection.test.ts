/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { preserveClashPaintInSelection } from './renderer-selection.js';

const AMBER = [1, 0.5, 0, 1] as const;
const CYAN = [0, 0.8, 1, 1] as const;

describe('clash selection render policy (#5828)', () => {
  it('keeps both logical selections while the applied pair paint prevents a final blue pass', () => {
    const selectedIds = new Set([10, 20, 30]);
    const render = preserveClashPaintInSelection(
      { selectedId: 10, selectedIds },
      new Map<number, readonly number[]>([[10, AMBER], [20, CYAN]]),
      new Map<number, readonly number[]>([[10, AMBER], [20, CYAN]]),
    );
    assert.equal(render.selectedId, null);
    assert.deepEqual([...render.selectedIds], [30], 'an unrelated selection still renders blue');
    assert.deepEqual([...selectedIds], [10, 20, 30], 'render policy never clears the logical pair');
  });

  it('returns normal selection while pair paint is pending or has been replaced', () => {
    const selection = { selectedId: 10, selectedIds: new Set([10, 20]) };
    const pair = new Map<number, readonly number[]>([[10, AMBER], [20, CYAN]]);
    assert.strictEqual(preserveClashPaintInSelection(selection, pair, null), selection);
    const render = preserveClashPaintInSelection(selection, pair,
      new Map<number, readonly number[]>([[10, AMBER], [20, [0, 1, 0, 1]]]));
    assert.equal(render.selectedId, null);
    assert.deepEqual([...render.selectedIds], [20], 'a replaced colour restores the ordinary blue selection');
  });
});
