/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Auto Spaces' preview (`addElementAutoSpacePreview`) is a dry-run wall-graph
 * detection keyed to the storey it ran against — nothing re-runs detection
 * when the target storey or model changes. Switching either must drop the
 * stale preview so AddElementOverlay stops drawing outlines for a storey the
 * user navigated away from, and the panel stops reporting region/wall counts
 * that no longer describe the current selection.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAddElementSlice, type AddElementSlice } from './addElementSlice.js';

function samplePreview(storeyExpressId: number): AddElementSlice['addElementAutoSpacePreview'] {
  return {
    storeyExpressId,
    outlines: [[[0, 0], [1, 0], [1, 1], [0, 1]]],
    regions: [{ area: 1 }],
    wallsConsidered: 4,
    wallsContributing: 4,
  };
}

describe('addElementSlice: Auto Spaces preview invalidation', () => {
  let state: AddElementSlice;
  let setState: (partial: Partial<AddElementSlice> | ((state: AddElementSlice) => Partial<AddElementSlice>)) => void;

  beforeEach(() => {
    setState = (partial) => {
      const updates = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...updates };
    };
    state = createAddElementSlice(setState, () => state, {} as never);
  });

  it('setAddElementStoreyId clears a preview computed for the previous storey', () => {
    state.setAddElementAutoSpacePreview(samplePreview(101));
    assert.notEqual(state.addElementAutoSpacePreview, null);

    state.setAddElementStoreyId(202);
    assert.equal(state.addElementAutoSpacePreview, null);
  });

  it('setAddElementModelId clears a preview computed against the previous model', () => {
    state.setAddElementAutoSpacePreview(samplePreview(101));
    assert.notEqual(state.addElementAutoSpacePreview, null);

    state.setAddElementModelId('model-b');
    assert.equal(state.addElementAutoSpacePreview, null);
  });

  it('re-setting the SAME storey id also clears — the preview may be stale even without a value change (e.g. re-selecting after an external reset)', () => {
    state.setAddElementStoreyId(101);
    state.setAddElementAutoSpacePreview(samplePreview(101));
    state.setAddElementStoreyId(101);
    assert.equal(state.addElementAutoSpacePreview, null);
  });

  it('calibration: setAddElementAutoSpaceParams (unrelated form field) does NOT clear the preview', () => {
    state.setAddElementAutoSpacePreview(samplePreview(101));
    state.setAddElementAutoSpaceParams({ MinArea: 2 });
    assert.notEqual(state.addElementAutoSpacePreview, null);
  });
});
