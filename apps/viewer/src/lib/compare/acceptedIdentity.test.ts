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
  acceptedForPair,
  acceptedSignatures,
  addAcceptedIdentity,
  claimSignature,
  keyAliasesFromAccepted,
  rejectClaim,
  rejectedForPair,
  removeAcceptedIdentity,
} from './acceptedIdentity.js';

const AB = { baseModelId: 'A', headModelId: 'B' };
const AC = { baseModelId: 'A', headModelId: 'C' };
const wall = { base: 'W1', here: 'W1b', reason: 'successor:footprint' };
const door = { base: 'D1', here: 'D1b', reason: 'accepted:ambiguous' };
const wallAB = { ...AB, ...wall };
const doorAB = { ...AB, ...door };

describe('addAcceptedIdentity (#4955)', () => {
  it('adds distinct pairs and keeps their reasons', () => {
    const { entries, refused } = addAcceptedIdentity([], AB, [wall, door]);
    assert.deepEqual(entries, [wallAB, doorAB]);
    assert.deepEqual(refused, []);
  });

  it('does not add a pair twice, and returns the same array when nothing changed', () => {
    const first = addAcceptedIdentity([], AB, [wall]).entries;
    const again = addAcceptedIdentity(first, AB, [wall]);
    assert.equal(again.entries, first);
    assert.deepEqual(again.refused, []);
  });

  it('refuses a second base for a here already claimed (identity is 1:1)', () => {
    const { entries, refused } = addAcceptedIdentity([wallAB], AB, [{ base: 'W9', here: 'W1b', reason: 'successor:position' }]);
    assert.deepEqual(entries, [wallAB]);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].base, 'W9');
  });

  it('refuses a second here for a base already claimed', () => {
    const { entries, refused } = addAcceptedIdentity([wallAB], AB, [{ base: 'W1', here: 'W7b', reason: 'successor:position' }]);
    assert.deepEqual(entries, [wallAB]);
    assert.equal(refused.length, 1);
  });

  it('a pair accepted for A vs B does not bind the same keys for A vs C (review find 5)', () => {
    // The same GlobalId in another file is another entity: the 1:1 rule is
    // per model pair, and the replay reads only its own pair's entries.
    const { entries, refused } = addAcceptedIdentity([wallAB], AC, [{ base: 'W1', here: 'W7c', reason: 'successor:position' }]);
    assert.deepEqual(refused, []);
    assert.equal(entries.length, 2);
    assert.deepEqual(acceptedForPair(entries, AB), [wall]);
    assert.deepEqual(acceptedForPair(entries, AC), [{ base: 'W1', here: 'W7c', reason: 'successor:position' }]);
    assert.deepEqual(acceptedForPair(entries, { baseModelId: 'B', headModelId: 'A' }), [], 'A/B is not B/A');
  });

  it('drops a self-claim silently: the engine would filter it anyway', () => {
    const { entries, refused } = addAcceptedIdentity([], AB, [{ base: 'X', here: 'X', reason: 'successor:footprint' }]);
    assert.deepEqual(entries, []);
    assert.deepEqual(refused, []);
  });
});

describe('removeAcceptedIdentity / rejectClaim', () => {
  it('removes exactly the named pair', () => {
    const next = removeAcceptedIdentity([wallAB, doorAB], AB, 'W1', 'W1b');
    assert.deepEqual(next, [doorAB]);
  });

  it('returns the same array when the pair was not there', () => {
    const list = [wallAB];
    assert.equal(removeAcceptedIdentity(list, AB, 'nope', 'nope'), list);
    assert.equal(removeAcceptedIdentity(list, AC, 'W1', 'W1b'), list, 'another model pair is another decision');
    const rejected = rejectClaim([], AB, 'A', 'B');
    assert.equal(rejectClaim(rejected, AB, 'A', 'B'), rejected);
  });

  it('a rejection is scoped to its model pair and keyed by the NUL-separated signature', () => {
    const rejected = rejectClaim([], AB, 'A', 'B');
    assert.ok(rejectedForPair(rejected, AB).has(claimSignature('A', 'B')));
    assert.ok(!rejectedForPair(rejected, AB).has(claimSignature('AB', '')));
    assert.equal(rejectedForPair(rejected, AC).size, 0);
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
