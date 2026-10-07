/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNCLASSIFIED, adjustedRandIndex, buildSheet, claimUnits, cohenKappa, proposalLabeling, scoreSheets, sheetErrors } from './labels.mjs';
import { REPO_ROOT, loadRecordingDir, decodeRecording } from './recording.mjs';

const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'ai-eval', 'label-sheet.schema.json'), 'utf8'));
const recordings = new Map(loadRecordingDir(join(REPO_ROOT, 'tests', 'ai-eval', 'recordings')).map(({ recording }) => [recording.id, recording]));
const sheetFor = (id, kind, reviewerId) => { const recording = recordings.get(id); return buildSheet({ recording, kind, answer: decodeRecording(recording).text, reviewerId }); };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);

test('cohenKappa matches hand-computed values and is undefined when chance agreement is total', () => {
  // 10 items: both say supported 4 times, both unsupported 3 times, disagree 3 times. po=.7, pe=.5*.5+.5*.5=.5 -> .4
  const pairs = [...Array(4).fill(['supported', 'supported']), ...Array(3).fill(['unsupported', 'unsupported']), ...Array(2).fill(['supported', 'unsupported']), ['unsupported', 'supported']];
  near(cohenKappa(pairs), 0.4);
  assert.equal(cohenKappa([]), null);
  assert.equal(cohenKappa([['supported', 'supported'], ['supported', 'supported']]), null);
  near(cohenKappa([['a', 'b'], ['b', 'a']]), -1);
});

test('adjustedRandIndex: identical partitions 1, a relabelling 1, an unrelated split near or below 0', () => {
  const a = { 1: 'x', 2: 'x', 3: 'y', 4: 'y', 5: 'z', 6: 'z' };
  near(adjustedRandIndex(a, a), 1);
  near(adjustedRandIndex(a, { 1: 'p', 2: 'p', 3: 'q', 4: 'q', 5: 'r', 6: 'r' }), 1);
  assert.ok(adjustedRandIndex(a, { 1: 'p', 2: 'q', 3: 'r', 4: 'p', 5: 'q', 6: 'r' }) < 0);
  assert.equal(adjustedRandIndex({ 1: 'x' }, { 1: 'x' }), null, 'fewer than two items has no index');
  assert.equal(adjustedRandIndex({ 1: 'a', 2: 'b' }, { 1: 'c', 2: 'd' }), null, 'two all-singleton partitions are degenerate');
});

test('claimUnits splits sentences and keeps each one\'s citations', () => {
  const units = claimUnits('One finding is major: [E1], a hard clash. The other 8 are info [E2][E3]!\nA bullet line.');
  assert.deepEqual(units.map(unit => unit.citations), [['E1'], ['E2', 'E3'], []]);
  assert.equal(units.length, 3);
  assert.ok(units.every(unit => unit.verdict === null));
});

test('a blank sheet is valid; a sheet claiming to be complete must be complete', () => {
  const claims = sheetFor('clash-summary-release', 'claims', 'r1');
  assert.deepEqual(sheetErrors(claims, schema), []);
  claims.reviewer.status = 'complete';
  assert.ok(sheetErrors(claims, schema).some(error => /a complete sheet has a verdict for every claim/.test(error)));
  for (const claim of claims.claims) claim.verdict = 'supported';
  assert.deepEqual(sheetErrors(claims, schema), []);
  claims.claims[0].verdict = 'probably';
  assert.ok(sheetErrors(claims, schema).some(error => /unknown verdict probably/.test(error)));

  const grouping = sheetFor('clash-grouping-release', 'grouping', 'r1');
  grouping.reviewer.status = 'complete';
  const errors = sheetErrors(grouping, schema);
  assert.ok(errors.some(error => /assigns every finding a group/.test(error)) && errors.some(error => /rates every proposed group/.test(error)) && errors.some(error => /counts the corrections/.test(error)));
});

test('a grouping sheet needs a clash.groups answer', () => {
  assert.throws(() => sheetFor('clash-summary-release', 'grouping', 'r1'), /not a clash\.groups proposal/);
});

test('the model proposal partitions the captured findings; unmentioned findings are singletons', () => {
  const labeling = proposalLabeling(sheetFor('clash-grouping-partial-release', 'grouping', 'r1'));
  assert.equal(Object.keys(labeling).length, 9);
  assert.equal(Object.values(labeling).filter(label => label.startsWith('group:')).length, 7);
  assert.equal(Object.values(labeling).filter(label => label.startsWith('single:')).length, 2);
});

function filledGrouping(reviewerId, assign, corrections) {
  const sheet = sheetFor('clash-grouping-release', 'grouping', reviewerId);
  sheet.findings.forEach(finding => { finding.group = assign(finding.citation); });
  sheet.proposal.groups.forEach(group => { group.verdict = 'useful'; });
  sheet.proposal.corrections = corrections;
  sheet.reviewer.status = 'complete';
  assert.deepEqual(sheetErrors(sheet, schema), []);
  return sheet;
}

test('grouping agreement: a reviewer who reproduces the proposal scores ARI 1 against it, and reviewers are compared with each other', () => {
  const proposal = proposalLabeling(sheetFor('clash-grouping-release', 'grouping', 'x'));
  const same = filledGrouping('r1', citation => proposal[citation], 0);
  const lumped = filledGrouping('r2', () => 'all', 4);
  const score = scoreSheets([same, lumped]);
  assert.equal(score.completeReviewers, 2);
  assert.equal(score.perReviewer[0].ariVsProposal, 1);
  assert.equal(score.perReviewer[1].corrections, 4);
  assert.equal(score.agreement.length, 1);
  assert.ok(score.agreement[0].ari < 1);
  const leftOut = filledGrouping('r3', () => UNCLASSIFIED, 9);
  assert.equal(scoreSheets([leftOut]).agreement.length, 0, 'one reviewer gives no agreement figure');
});

test('claim scoring reports unsupported rate over judged claims only and kappa between two reviewers', () => {
  const fill = (reviewerId, verdicts) => {
    const sheet = sheetFor('clash-summary-release', 'claims', reviewerId);
    sheet.claims.forEach((claim, index) => { claim.verdict = verdicts[index % verdicts.length]; });
    sheet.reviewer.status = 'complete';
    return sheet;
  };
  const first = fill('r1', ['supported', 'unsupported', 'not-factual']);
  const second = fill('r2', ['supported', 'supported', 'cannot-judge']);
  const score = scoreSheets([first, second, sheetFor('clash-summary-release', 'claims', 'r3')]);
  assert.equal(score.sheets, 3);
  assert.equal(score.completeReviewers, 2, 'a blank sheet is counted and ignored');
  assert.equal(score.perReviewer[0].unsupportedRate, 0.5);
  assert.equal(score.agreement[0].items, 2, 'not-factual and cannot-judge items are excluded from kappa');
  assert.equal(scoreSheets([sheetFor('clash-summary-release', 'claims', 'r1')]).completeReviewers, 0);
});
