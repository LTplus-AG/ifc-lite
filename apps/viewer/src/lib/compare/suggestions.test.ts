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
const none = new Set<string>();

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
        accepted: none,
        rejected: none,
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
    const sig = claimSignature('W1', 'W1b');
    for (const decided of [{ accepted: new Set([sig]), rejected: none }, { accepted: none, rejected: new Set([sig]) }]) {
      const rows = suggestionRows({ successors: [successor()], ...decided }, names);
      assert.equal(rows.length, 0);
    }
  });

  it('hides an unresolved group once every pair in it is decided, and keeps it while one is open', () => {
    const match: ContentMatch<CompareRef> = { kind: 'ambiguous', dataHash: '', base: [fp('a')], head: [fp('c'), fp('d')] };
    const partly = suggestionRows(
      { contentMatches: [match], accepted: new Set([claimSignature('a', 'c')]), rejected: none },
      names,
    );
    assert.equal(partly.length, 1);
    assert.ok(pairIsOpen(partly[0], 'a', 'd', new Set([claimSignature('a', 'c')]), none));
    assert.ok(!pairIsOpen(partly[0], 'a', 'c', new Set([claimSignature('a', 'c')]), none));
    const fully = suggestionRows(
      { contentMatches: [match], accepted: new Set([claimSignature('a', 'c')]), rejected: new Set([claimSignature('a', 'd')]) },
      names,
    );
    assert.equal(fully.length, 0);
  });

  it('flags a class change on successor and split rows', () => {
    const rows = suggestionRows(
      { successors: [successor({ crossClass: true })], splitMerges: [split({ crossClass: true })], accepted: none, rejected: none },
      names,
    );
    assert.deepEqual(rows.map((r) => r.crossClass), [true, true]);
  });
});
