/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one ownership predicate over the shared visibility channels — the thing
 * clash (#2654 / #2662) and the IDS row focus (#2867) both ask before they
 * clear anything.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownsCurrentVisibility,
  releaseOwnedVisibility,
  sameMembers,
  staleOwnershipReset,
  type VisibilityChannels,
} from './ownership.js';

describe('sameMembers', () => {
  it('is true for equal members in different Set objects', () => {
    assert.equal(sameMembers(new Set([1, 2]), new Set([2, 1])), true,
      'value identity is the whole point — a snapshot/restore round-trip rebuilds the Set');
  });

  it('is false in BOTH directions of containment, not just one', () => {
    // The size check is what makes the second of these false. Without it, the
    // member loop alone answers "still ours" for every SUBSET of the record —
    // and releasing then destroys a presentation somebody else installed.
    assert.equal(sameMembers(new Set([1, 2]), new Set([1])), false, 'superset is not equal');
    assert.equal(sameMembers(new Set([1]), new Set([1, 2])), false, 'subset is not equal either');
  });

  it('is true for two empty sets and false against a non-empty one', () => {
    assert.equal(sameMembers(new Set(), new Set()), true);
    assert.equal(sameMembers(new Set(), new Set([1])), false,
      'an EMPTY channel does not match a non-empty record — the case a size-free member loop gets wrong');
  });
});

function channels(over: Partial<VisibilityChannels> = {}): VisibilityChannels & {
  cleared: string[];
} {
  const cleared: string[] = [];
  return {
    isolatedEntities: null,
    ghostExceptEntities: null,
    clearIsolation: () => { cleared.push('isolate'); },
    clearGhost: () => { cleared.push('ghost'); },
    cleared,
    ...over,
  };
}

describe('releaseOwnedVisibility', () => {
  it('clears the channel it owns, and only that channel', () => {
    const s = channels({ isolatedEntities: new Set([1]), ghostExceptEntities: null });
    assert.equal(releaseOwnedVisibility(s, { channel: 'isolate', ids: new Set([1]) }), true);
    assert.deepEqual(s.cleared, ['isolate'], 'the ghost channel is somebody else\'s business');
  });

  it('leaves a channel whose content no longer matches', () => {
    const s = channels({ ghostExceptEntities: new Set([1, 9]) });
    assert.equal(releaseOwnedVisibility(s, { channel: 'ghost', ids: new Set([1]) }), false);
    assert.deepEqual(s.cleared, [], 'a later owner took the channel over — releasing would destroy their view');
  });

  it('answers false, and clears nothing, for a record of null', () => {
    const s = channels({ isolatedEntities: new Set([1]) });
    assert.equal(releaseOwnedVisibility(s, null), false);
    assert.deepEqual(s.cleared, [], 'owning nothing means clearing nothing — a full-context highlight owns nothing');
  });

  it('answers false for a record naming a channel that is now empty', () => {
    const s = channels({ isolatedEntities: null });
    assert.equal(ownsCurrentVisibility(s, { channel: 'isolate', ids: new Set([1]) }), false);
    assert.equal(releaseOwnedVisibility(s, { channel: 'isolate', ids: new Set([1]) }), false);
    assert.deepEqual(s.cleared, []);
  });
});

/**
 * The invalidation side of the same predicate (review of #2867): a channel
 * write drops every record it just made stale, symmetrically, so no
 * subsystem's claim can outlive its presentation because a DIFFERENT owner
 * replaced the channel.
 */
describe('staleOwnershipReset', () => {
  it('drops a record whose channel the write is about to replace', () => {
    assert.deepEqual(
      staleOwnershipReset(
        { idsFocusVisibilityOwned: { channel: 'isolate', ids: new Set([1]) } },
        { isolatedEntities: new Set([2]), ghostExceptEntities: null },
      ),
      { idsFocusVisibilityOwned: null },
    );
  });

  it('drops a record whose channel the write NULLS as a side effect', () => {
    // The two channels are mutually exclusive: writing the ghost one nulls the
    // isolate one. That is D1 — clash ghosting over an IDS row isolation.
    assert.deepEqual(
      staleOwnershipReset(
        { idsFocusVisibilityOwned: { channel: 'isolate', ids: new Set([1]) } },
        { isolatedEntities: null, ghostExceptEntities: new Set([5, 6]) },
      ),
      { idsFocusVisibilityOwned: null },
    );
  });

  it('keeps a record the write leaves content-matching', () => {
    // Space Sketch's restore and `syncSourceModel`'s rebuild both replay an
    // unchanged channel through a cloning setter (#2662 P2). Equal members
    // mean the same presentation is still on screen.
    assert.deepEqual(
      staleOwnershipReset(
        { clashVisibilityOwned: { channel: 'ghost', ids: new Set([1, 2]) } },
        { isolatedEntities: null, ghostExceptEntities: new Set([2, 1]) },
      ),
      {},
      'a content-preserving rewrite must not launder a feature-owned focus into "user" state',
    );
  });

  it('answers for BOTH subsystems, not whichever one was reported', () => {
    assert.deepEqual(
      staleOwnershipReset(
        {
          idsFocusVisibilityOwned: { channel: 'isolate', ids: new Set([1]) },
          clashVisibilityOwned: { channel: 'ghost', ids: new Set([5, 6]) },
        },
        { isolatedEntities: new Set([9]), ghostExceptEntities: null },
      ),
      { idsFocusVisibilityOwned: null, clashVisibilityOwned: null },
      'one direction of a two-way rule is not a rule',
    );
  });

  it('adds no keys when there is nothing to invalidate', () => {
    // The common case, and the reason this returns a patch rather than a pair
    // of nulls: slice-level harnesses stub `get()` without these fields, and a
    // blanket write would introduce them.
    assert.deepEqual(
      staleOwnershipReset({}, { isolatedEntities: new Set([1]), ghostExceptEntities: null }),
      {},
    );
    assert.deepEqual(
      staleOwnershipReset(
        { idsFocusVisibilityOwned: null, clashVisibilityOwned: null },
        { isolatedEntities: null, ghostExceptEntities: null },
      ),
      {},
      'a record of `null` is already no claim — nulling it again is a store commit for nothing',
    );
  });
});
