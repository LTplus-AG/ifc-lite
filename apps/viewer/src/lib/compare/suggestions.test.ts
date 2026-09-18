/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Evidence lines and row derivation for the Compare panel's Suggestions
 * section (issue #4955). The evidence line is what a reviewer reads before
 * clicking Accept, so its content is the contract: the confidence profile and
 * the numbers it rests on, never a bare label.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentMatch, EntityFingerprint, SplitMergeClaim, SuccessorClaim } from '@ifc-lite/diff';
import type { CompareRef } from './buildFingerprints.js';
import { claimSignature } from './acceptedIdentity.js';
import {
  pairIsOpen,
  pairIsUndecided,
  splitMergeEvidence,
  successorEvidence,
  suggestionRows,
  unresolvedEvidence,
} from './suggestions.js';

function fp(key: string, ifcType = 'IfcWall', localId = 1): EntityFingerprint<CompareRef> {
  return { key, ifcType, dataHash: 'd', ref: { modelId: 'B', localId, globalId: 1000 + localId } };
}

function successor(over: Partial<SuccessorClaim<CompareRef>> = {}): SuccessorClaim<CompareRef> {
  return {
    confidence: 'footprint',
    base: fp('W1', 'IfcWall', 1),
    head: fp('W1b', 'IfcWall', 2),
    overlap: 0.8123,
    distance: 0.0201,
    agreeingComponents: ['pset:Pset_WallCommon'],
    ...over,
  };
}

function split(over: Partial<SplitMergeClaim<CompareRef>> = {}): SplitMergeClaim<CompareRef> {
  return {
    kind: 'split',
    confidence: 'verified',
    whole: fp('W2', 'IfcWall', 3),
    pieces: [fp('P1', 'IfcWall', 4), fp('P2', 'IfcWall', 5), fp('P3', 'IfcWall', 6)],
    wholeVolume: 10,
    piecesVolume: 9.88,
    volumeResidual: -0.012,
    ...over,
  };
}

const names = (ref: CompareRef) => `name${ref.localId}`;
const none = { accepted: [], rejected: new Set<string>() };
const acceptedPair = (base: string, here: string) => ({ accepted: [{ base, here, reason: 'accepted:ambiguous' }], rejected: new Set<string>() });
const rejectedPair = (base: string, here: string) => ({ accepted: [], rejected: new Set([claimSignature(base, here)]) });

describe('successorEvidence', () => {
  it('names the profile, the overlap, the distance and the agreeing components', () => {
    assert.equal(successorEvidence(successor()), 'Replaced · footprint 0.81 · 0.02 m · agrees on Pset_WallCommon');
  });

  it('omits the agreement clause when the claim carries none (no components on a side)', () => {
    assert.equal(
      successorEvidence(successor({ confidence: 'position', overlap: 0, distance: 0.35, agreeingComponents: undefined })),
      'Replaced · position 0.00 · 0.35 m',
    );
  });

  it('lists at most three components and counts the rest', () => {
    const line = successorEvidence(successor({ agreeingComponents: ['attr:core', 'pset:A', 'qset:B', 'material', 'type-assignment'] }));
    assert.ok(line.endsWith('agrees on attr:core, A, B +2'), line);
  });
});

describe('splitMergeEvidence / unresolvedEvidence', () => {
  it('a verified split reports the piece count, the profile and the signed volume residual', () => {
    assert.equal(splitMergeEvidence(split()), 'Split into 3 · verified · Δvol −1.2%');
  });

  it('an extent merge has no residual to report', () => {
    const merge = split({ kind: 'merge', confidence: 'extent', pieces: [fp('a'), fp('b')], volumeResidual: undefined });
    assert.equal(splitMergeEvidence(merge), 'Merged from 2 · extent');
  });

  it('an unresolved group reports its kind and shape', () => {
    const match: ContentMatch<CompareRef> = { kind: 'ambiguous', dataHash: '', base: [fp('a'), fp('b')], head: [fp('c'), fp('d'), fp('e')] };
    assert.equal(unresolvedEvidence(match), 'Ambiguous · 2:3');
  });
});

describe('suggestionRows', () => {
  it('lists successors, then split/merge claims, then unresolved groups; retiring matches are not suggestions', () => {
    const rows = suggestionRows(
      {
        successors: [successor()],
        splitMerges: [split()],
        contentMatches: [
          { kind: 'renamed', dataHash: 'd', base: [fp('R1')], head: [fp('R1b')] },
          { kind: 'ambiguous', dataHash: '', base: [fp('a'), fp('b')], head: [fp('c'), fp('d')] },
        ],
        ...none,
      },
      names,
    );
    assert.deepEqual(rows.map((r) => r.kind), ['successor', 'split', 'ambiguous']);
    // A successor row can be accepted; a split row cannot (no candidates).
    assert.equal(rows[0].bases.length, 1);
    assert.equal(rows[0].heads.length, 1);
    assert.equal(rows[0].confidence, 'footprint');
    assert.equal(rows[1].bases.length, 0);
    // A split row selects the whole AND every piece.
    assert.equal(rows[1].refs.length, 4);
    assert.equal(rows[2].bases.length, 2);
    assert.equal(rows[2].heads.length, 2);
  });

  it('hides a successor the user accepted or refused', () => {
    for (const decided of [acceptedPair('W1', 'W1b'), rejectedPair('W1', 'W1b')]) {
      const rows = suggestionRows({ successors: [successor()], ...decided }, names);
      assert.equal(rows.length, 0);
    }
  });

  it('hides an unresolved group once every pair in it is decided, and keeps it while one is open', () => {
    const match: ContentMatch<CompareRef> = { kind: 'ambiguous', dataHash: '', base: [fp('a'), fp('b')], head: [fp('c'), fp('d')] };
    const partly = suggestionRows({ contentMatches: [match], ...rejectedPair('a', 'c') }, names);
    assert.equal(partly.length, 1);
    assert.ok(pairIsOpen(partly[0], 'a', 'd', rejectedPair('a', 'c')));
    assert.ok(!pairIsOpen(partly[0], 'a', 'c', rejectedPair('a', 'c')));
    const fully = suggestionRows(
      { contentMatches: [match], accepted: [{ base: 'a', here: 'c', reason: 'accepted:ambiguous' }, { base: 'b', here: 'd', reason: 'accepted:ambiguous' }], rejected: new Set() },
      names,
    );
    assert.equal(fully.length, 0);
  });

  it('accepting (a, c) closes (a, d) and (b, c) too: an accepted key is spoken for (review find 4)', () => {
    // `acceptCompareIdentity` would refuse (a, d) - `a` already has an
    // identity - so offering it as open would be offering a dead click.
    const decided = acceptedPair('a', 'c');
    assert.ok(!pairIsUndecided('a', 'd', decided));
    assert.ok(!pairIsUndecided('b', 'c', decided));
    assert.ok(pairIsUndecided('b', 'd', decided));
    const match: ContentMatch<CompareRef> = { kind: 'ambiguous', dataHash: '', base: [fp('a')], head: [fp('c'), fp('d')] };
    assert.equal(suggestionRows({ contentMatches: [match], ...decided }, names).length, 0, 'nothing left to decide for a');
  });

  it('keys a row by its candidates, never by its position (review find 1)', () => {
    // A re-diff after an acceptance drops the first row; a position key would
    // hand the second row the first one's React state.
    const before = suggestionRows({ successors: [successor(), successor({ base: fp('X1'), head: fp('X1b') })], ...none }, names);
    const after = suggestionRows({ successors: [successor({ base: fp('X1'), head: fp('X1b') })], ...acceptedPair('W1', 'W1b') }, names);
    assert.equal(after[0].key, before[1].key);
    assert.notEqual(after[0].key, before[0].key);
    const groups = suggestionRows(
      { contentMatches: [{ kind: 'ambiguous', dataHash: '', base: [fp('a'), fp('b')], head: [fp('c')] }], splitMerges: [split()], ...none },
      names,
    );
    assert.deepEqual(groups.map((r) => r.key), ['suggest:split:W2>P1+P2+P3', 'suggest:ambiguous:a+b>c']);
  });

  it('flags a class change on successor and split rows', () => {
    const rows = suggestionRows(
      { successors: [successor({ crossClass: true })], splitMerges: [split({ crossClass: true })], ...none },
      names,
    );
    assert.deepEqual(rows.map((r) => r.crossClass), [true, true]);
  });
});
