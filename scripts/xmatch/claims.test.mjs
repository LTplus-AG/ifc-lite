/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression pins from the #4974 review: a split claim repeating one piece
 * is not the split the key describes; the map digest survives a cyclic
 * subgraph without recursing; and only the `#<id>` segment of a container
 * path may differ between revisions.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexModel } from './edits.mjs';
import { mergedHeadFanInWrong, unnamedNodesNormalised } from './guards.mjs';
import * as scoreClaims from './score-claims.mjs';
import { scoreSplits } from './score-claims.mjs';
import { scorePair } from './score.mjs';
import { parseStepFile } from './step-file.mjs';
import { representationMapDigest } from './successor-edits.mjs';
import { mergeDropsAPieceMutant } from './matchers.mjs';

// `scoreMerges` is a NEW export (issue #4989): checked INSIDE a `test()`, not
// at module top level — a top-level `assert` that throws crashes the whole
// file before any subtest registers, which reads identically to an import
// SyntaxError to `node --test`'s output (and so to the revert oracle) as a
// load failure rather than a real assertion red.
test('score-claims.mjs exports scoreMerges (#4989)', () => {
  assert.equal(typeof scoreClaims.scoreMerges, 'function');
});
const scoreMerges = (...args) => scoreClaims.scoreMerges(...args);

const fp = (ref) => ({ ref, key: `k${ref}`, ifcType: 'IfcWall', dataHash: 'd' });

test('a split claim that repeats one piece is wrong, not correct', () => {
  const key = { elements: [{ base: 1, kind: 'splitLength', class: 'prismatic', head: [11, 12] }] };
  const claim = (pieces) => ({ kind: 'split', confidence: 'extent', whole: fp(1), pieces: pieces.map(fp) });
  const options = { hasVolume: new Set(), kindOf: new Map(), headOrigin: new Map() };
  assert.equal(scoreSplits(key, [claim([11, 12])], options).bySplit.correct, 1);
  assert.equal(scoreSplits(key, [claim([11, 11])], options).bySplit.correct, 0);
  assert.equal(scoreSplits(key, [claim([11, 11])], options).bySplit.wrong, 1);
});

test('scoreMerges (#4989): the piece set must equal the key\'s {a, b} exactly', () => {
  // Two `key.elements` rows sharing one head — a primary (base 1) and its
  // donor (base 2), both merged into head 21 — mirrors what `mutate.mjs`
  // actually writes for a `merged` pair.
  const key = {
    elements: [
      { base: 1, kind: 'merged', class: 'prismatic', head: [21] },
      { base: 2, kind: 'merged', class: 'prismatic', head: [21] },
    ],
  };
  const options = { hasVolume: new Set(), kindOf: new Map(), headOrigin: new Map() };
  const claim = (whole, pieces, kind = 'merge') => ({
    kind,
    confidence: 'extent',
    whole: fp(whole),
    pieces: pieces.map(fp),
  });

  // Correct: exactly {1, 2}.
  const correct = scoreMerges(key, [claim(21, [1, 2])], options).byMerge;
  assert.equal(correct.correct, 1);
  assert.equal(correct.recalled, 1);
  assert.equal(correct.wrong, 0);

  // Duplicate piece: `[1, 1]` has the right length but is not `{1, 2}`.
  const duplicate = scoreMerges(key, [claim(21, [1, 1])], options).byMerge;
  assert.equal(duplicate.correct, 0);
  assert.equal(duplicate.wrong, 1);

  // Missing piece: only one of the two real bases.
  const missing = scoreMerges(key, [claim(21, [1])], options).byMerge;
  assert.equal(missing.correct, 0);
  assert.equal(missing.wrong, 1);

  // Wrong whole: a head id the key never called `merged`.
  const wrongWhole = scoreMerges(key, [claim(99, [1, 2])], options).byMerge;
  assert.equal(wrongWhole.correct, 0);
  assert.equal(wrongWhole.wrong, 1);

  // A `split` claim is counted only informationally, never against byMerge.
  const splitOnly = scoreMerges(key, [claim(1, [21], 'split')], options).byMerge;
  assert.equal(splitOnly.claimed, 0);
  assert.equal(splitOnly.splitClaims, 1);
});

test('a merged head shared with any non-merged row fails the answer-key guard (#4989 review)', () => {
  assert.equal(mergedHeadFanInWrong({ elements: [
    { base: 1, kind: 'merged', head: [21] },
    { base: 2, kind: 'merged', head: [21] },
  ] }), 0);
  assert.equal(mergedHeadFanInWrong({ elements: [
    { base: 1, kind: 'merged', head: [21] },
    { base: 2, kind: 'merged', head: [21] },
    { base: 3, kind: 'renamed', head: [21] },
  ] }), 1);
});

test('a 1:1 content match onto a `merged` base is wrongPartner, never correct (#4989 review)', () => {
  // The PRIMARY's own row: base id 1, head [1] — the head keeps the SAME id
  // (just renamed), so `expected.get(1)` is trivially `Set([1])` and a
  // self-pairing 1:1 content match would satisfy plain set equality. That
  // is exactly the whole-vs-half identity claim the content matcher must
  // never make; `merged` bases exist only for the split/merge claim stage.
  const key = {
    elements: [
      { base: 1, kind: 'merged', class: 'prismatic', head: [1] },
      { base: 2, kind: 'merged', class: 'prismatic', head: [1] },
    ],
    insertedHeadIds: [],
  };
  const selfPair = { kind: 'renamed', tier: 'geometry-hash', base: [fp(1)], head: [fp(1)] };
  const score = scorePair(key, [selfPair]);
  assert.equal(score.overall.correctPairs, 0, 'a whole-vs-half self-pair must not be credited');
  assert.equal(score.falsePairs.wrongPartner, 1);
  assert.equal(score.overall.claimedPairs, 1);
});

test('a merged base cannot receive fallback successor credit for one piece', () => {
  const key = { elements: [{ base: 1, kind: 'merged', head: [21] }] };
  const result = scoreClaims.scoreSuccessors(key, [{ base: fp(1), head: fp(21), confidence: 'position' }], {
    expected: new Map([[1, new Set([21])]]),
    kindOf: new Map([[1, 'merged']]),
    insertedNearby: new Set(),
  });
  assert.equal(result.recoveredContentKinds, 0);
  assert.equal(result.falseSuccessors.neighbourSuccessor, 1);
});

test('merge-drops-a-piece applies only when it can actually drop a piece', () => {
  const key = { elements: [{ base: 1, kind: 'merged', head: [21] }] };
  const real = {
    matches: [], successors: [],
    splitMerges: [{ kind: 'merge', whole: fp(21), pieces: [fp(1)] }],
  };
  assert.equal(mergeDropsAPieceMutant(real, key).applicable, false);
  real.splitMerges[0].pieces.push(fp(2));
  assert.equal(mergeDropsAPieceMutant(real, key).applicable, true);
});

test('the map digest walks a cyclic, deep subgraph without recursion', () => {
  const lines = ['#1=IFCREPRESENTATIONMAP(#2,#3);', '#2=IFCAXIS2PLACEMENT3D(#3,$,$);'];
  // A chain of 20000 nodes, closing back on #2: recursion would overflow.
  const n = 20000;
  for (let i = 3; i < n; i++) lines.push(`#${i}=IFCSHAPEREPRESENTATION($,'Body','X',(#${i + 1}));`);
  lines.push(`#${n}=IFCSHAPEREPRESENTATION($,'Body','X',(#2));`);
  const file = parseStepFile(
    `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`,
  );
  const digest = representationMapDigest(indexModel(file), 1);
  assert.equal(digest.split('\n').length, n);
  assert.match(digest, /^IFCREPRESENTATIONMAP\(#/m);
});

test('only the unnamed-node segment of a container path may differ', () => {
  const same = (a, b) => unnamedNodesNormalised(a) === unnamedNodesNormalised(b);
  assert.equal(same('P/S/#36/Level 1', 'P/S/#19404/Level 1'), true);
  assert.equal(same('P/S/#36/Level 1', 'P/S/#19404/Level 2'), false, 'a renamed storey is a leak');
  assert.equal(same('P/S/#36/Level 1', 'P/S/#19404/Level 1/#5'), false, 'a deeper path is not the same node');
});
