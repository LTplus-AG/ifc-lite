/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The accepted / rejected identity reducers behind the Compare panel's
 * Suggestions section (issue #4955). Invariants under test: the accepted list
 * is 1:1 in both directions (an alias that collides is one the engine would
 * ignore, so recording it would be a claim that never takes effect), a
 * no-op returns the same reference (the store and `useCompare`'s
 * reconciliation effect compare by reference), and the alias map replays
 * head → base, which is the direction `DiffOptions.keyAliases` reads.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedSignatures,
  addAcceptedIdentity,
  claimSignature,
  keyAliasesFromAccepted,
  rejectClaim,
  removeAcceptedIdentity,
} from './acceptedIdentity.js';

const wall = { base: 'W1', here: 'W1b', reason: 'successor:footprint' };
const door = { base: 'D1', here: 'D1b', reason: 'accepted:ambiguous' };

describe('addAcceptedIdentity (#4955)', () => {
  it('adds distinct pairs and keeps their reasons', () => {
    const { entries, refused } = addAcceptedIdentity([], [wall, door]);
    assert.deepEqual(entries, [wall, door]);
    assert.deepEqual(refused, []);
  });

  it('does not add a pair twice, and returns the same array when nothing changed', () => {
    const first = addAcceptedIdentity([], [wall]).entries;
    const again = addAcceptedIdentity(first, [wall]);
    assert.equal(again.entries, first);
    assert.deepEqual(again.refused, []);
  });

  it('refuses a second base for a here already claimed (identity is 1:1)', () => {
    const { entries, refused } = addAcceptedIdentity([wall], [{ base: 'W9', here: 'W1b', reason: 'successor:position' }]);
    assert.deepEqual(entries, [wall]);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].base, 'W9');
  });

  it('refuses a second here for a base already claimed', () => {
    const { entries, refused } = addAcceptedIdentity([wall], [{ base: 'W1', here: 'W7b', reason: 'successor:position' }]);
    assert.deepEqual(entries, [wall]);
    assert.equal(refused.length, 1);
  });

  it('drops a self-claim silently: the engine would filter it anyway', () => {
    const { entries, refused } = addAcceptedIdentity([], [{ base: 'X', here: 'X', reason: 'successor:footprint' }]);
    assert.deepEqual(entries, []);
    assert.deepEqual(refused, []);
  });
});

describe('removeAcceptedIdentity / rejectClaim', () => {
  it('removes exactly the named pair', () => {
    const next = removeAcceptedIdentity([wall, door], 'W1', 'W1b');
    assert.deepEqual(next, [door]);
  });

  it('returns the same array / set when the pair was not there', () => {
    const list = [wall];
    assert.equal(removeAcceptedIdentity(list, 'nope', 'nope'), list);
    const rejected = rejectClaim(new Set(), 'A', 'B');
    assert.equal(rejectClaim(rejected, 'A', 'B'), rejected);
  });

  it('a rejection is keyed by the NUL-separated signature, so A→B and AB→"" cannot alias', () => {
    const rejected = rejectClaim(new Set(), 'A', 'B');
    assert.ok(rejected.has(claimSignature('A', 'B')));
    assert.ok(!rejected.has(claimSignature('AB', '')));
  });
});

describe('keyAliasesFromAccepted / acceptedSignatures', () => {
  it('replays head → base, the direction DiffOptions.keyAliases reads', () => {
    const aliases = keyAliasesFromAccepted([wall, door]);
    assert.equal(aliases.get('W1b'), 'W1');
    assert.equal(aliases.get('D1b'), 'D1');
    assert.equal(aliases.size, 2);
  });

  it('signatures cover every accepted pair', () => {
    const signatures = acceptedSignatures([wall, door]);
    assert.ok(signatures.has(claimSignature('W1', 'W1b')));
    assert.ok(signatures.has(claimSignature('D1', 'D1b')));
  });
});
