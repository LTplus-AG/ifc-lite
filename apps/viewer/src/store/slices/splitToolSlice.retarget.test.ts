/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createSplitToolSlice, type SplitToolSlice } from './splitToolSlice.js';

describe('SplitToolSlice — setSplitTarget while a slab anchor is latched (#2802)', () => {
  let state: SplitToolSlice;
  let setState: (partial: Partial<SplitToolSlice> | ((s: SplitToolSlice) => Partial<SplitToolSlice>)) => void;

  beforeEach(() => {
    setState = (partial) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createSplitToolSlice(setState, () => state, {} as never);
  });

  it('re-entering the SAME slab preserves the latched anchor', () => {
    state.setSplitTarget('modelA', 100);
    state.setSlabCutAnchor([1, 2], [[0, 0], [5, 0], [5, 5], [0, 5]], 0);
    // Re-targeting the identical element (e.g. re-triggering Split from the
    // Command Palette on the slab still selected) should not drop the
    // in-progress two-click flow.
    state.setSplitTarget('modelA', 100);
    assert.strictEqual(state.splitMode, 'first-anchor');
    assert.deepStrictEqual(state.slabCutAnchor, [1, 2]);
  });

  it('retargeting to a DIFFERENT element clears the previous slab anchor and drops first-anchor mode', () => {
    // First click on slab A latches a two-click anchor against A's footprint.
    state.setSplitTarget('modelA', 100);
    state.setSlabCutAnchor([1, 2], [[0, 0], [5, 0], [5, 5], [0, 5]], 0);
    assert.strictEqual(state.splitMode, 'first-anchor');

    // Before the second click commits, the user retargets Split to a
    // different element — e.g. clicking a different row in the Hierarchy
    // panel (which freely calls setSelectedEntityId regardless of
    // activeTool) and then re-invoking "Split selected entity" from the
    // Command Palette, which calls setSplitTarget unconditionally.
    state.setSplitTarget('modelB', 200);

    assert.strictEqual(
      state.splitTargetModelId, 'modelB',
      'target model must follow the retarget',
    );
    assert.strictEqual(
      state.splitTargetExpressId, 200,
      'target express id must follow the retarget',
    );
    // The slab anchor belonged to modelA/100's footprint. Once the target
    // has moved to an unrelated element, a stale anchor from the OLD
    // target must not survive — otherwise the second click commits
    // splitSlabByLine(modelB, 200, <modelA's anchor coordinates>), cutting
    // the new target along a line anchored in the wrong slab's coordinate
    // space.
    assert.strictEqual(
      state.slabCutAnchor, null,
      'stale anchor from the previous target must be cleared on retarget',
    );
    assert.strictEqual(state.slabCutFootprint, null);
    assert.strictEqual(state.slabCutStoreyElevation, null);
    assert.strictEqual(
      state.splitMode, 'idle',
      'first-anchor state must not survive a retarget to a different element',
    );
  });
});
