/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `releaseOwnedIdsFocusVisibility`'s own contract, over the surface it is
 * actually typed for — a plain object with every member optional, not the
 * combined store.
 *
 * The store now invalidates ownership records at its `set`
 * (`store/visibility-invalidation.ts`), so when this function DOES release a
 * channel through the live store, the record would be dropped for it anyway.
 * That is what makes `state.setIdsFocusVisibilityOwned?.(null)` invisible to
 * every store-driven test, and an untested line is a line that gets deleted.
 * It is not redundant here: the "still ours?" answer can be NO — in which case
 * nothing is written, nothing invalidates, and the drop is the only thing
 * standing between a mismatched record and the next owner of that content
 * (#2654 fourth review).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  releaseOwnedIdsFocusVisibility,
  type IDSFocusVisibilityChannels,
  type IDSFocusVisibilityOwnership,
} from './visibility-ownership.js';

function channels(over: Partial<IDSFocusVisibilityChannels> = {}): {
  state: IDSFocusVisibilityChannels;
  recorded: IDSFocusVisibilityOwnership[];
  cleared: string[];
} {
  const recorded: IDSFocusVisibilityOwnership[] = [];
  const cleared: string[] = [];
  const state: IDSFocusVisibilityChannels = {
    isolatedEntities: null,
    ghostExceptEntities: null,
    clearIsolation: () => { cleared.push('isolate'); },
    clearGhost: () => { cleared.push('ghost'); },
    setIdsFocusVisibilityOwned: (owned) => { recorded.push(owned); },
    ...over,
  };
  return { state, recorded, cleared };
}

describe('releaseOwnedIdsFocusVisibility', () => {
  it('releases the channel it still owns, and drops the record', () => {
    const { state, recorded, cleared } = channels({
      isolatedEntities: new Set([5]),
      idsFocusVisibilityOwned: { channel: 'isolate', ids: new Set([5]) },
    });

    assert.equal(releaseOwnedIdsFocusVisibility(state), true);
    assert.deepEqual(cleared, ['isolate']);
    assert.deepEqual(recorded, [null], 'the row focus makes no further claim once released');
  });

  it('drops the record even when the channel is NOT ours — that is the whole point', () => {
    // Another owner holds the isolate channel. Nothing is released; if the
    // record were left behind it would start matching again the moment anyone
    // installed {5} there, and the next release would destroy THAT owner's
    // presentation.
    const { state, recorded, cleared } = channels({
      isolatedEntities: new Set([9]),
      idsFocusVisibilityOwned: { channel: 'isolate', ids: new Set([5]) },
    });

    assert.equal(releaseOwnedIdsFocusVisibility(state), false, "we are not the owner");
    assert.deepEqual(cleared, [], "and another owner's isolation must not be touched");
    assert.deepEqual(recorded, [null], 'the stale record must go — no write invalidates it for us here');
  });

  it('writes nothing at all when there is no record', () => {
    const { state, recorded, cleared } = channels({ ghostExceptEntities: new Set([1]) });

    assert.equal(releaseOwnedIdsFocusVisibility(state), false);
    assert.deepEqual(cleared, []);
    assert.deepEqual(
      recorded,
      [],
      'an unconditional null would commit a fresh store state on every ownership-free release path',
    );
  });
});
