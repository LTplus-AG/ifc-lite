/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './e2-dataset.mjs';
import { E4_DIR_REL, loadE4Cases } from './e4-e5-datasets.mjs';
import { createE4Scorer, summariseE4 } from './e4-scorer.mjs';

const cases = loadE4Cases();
const byId = new Map(cases.map(record => [record.id, record]));
const read = rel => readFileSync(join(REPO_ROOT, E4_DIR_REL, rel), 'utf8');
const scorer = await createE4Scorer();

test('self-check: the expected IDS as candidate is correct on every E4 task', async () => {
  const scores = [];
  for (const record of cases) scores.push(await scorer.scoreCase(read(record.expected), record));
  const summary = summariseE4(scores);
  assert.deepEqual(summary.misses, []);
  assert.equal(summary.cases, 24);
  assert.equal(summary.accuracy, 1);
  assert.equal(summary.unchanged, 0);
  assert.equal(summary.auditErrors, 0);
});

test('the unedited input as candidate is wrong on every task and flagged unchanged', async () => {
  const scores = [];
  for (const record of cases) scores.push(await scorer.scoreCase(read(record.input), record));
  const summary = summariseE4(scores);
  assert.equal(summary.correct, 0);
  assert.equal(summary.unchanged, 24);
});

test('formatting and XML comments do not matter, a changed value does', async () => {
  const record = byId.get('walls-fire-rating-values');
  const expected = read(record.expected);
  const reformatted = expected.replace(/\n\s*/g, '').replace('<specifications>', '<!-- edited by the agent --><specifications>');
  assert.notEqual(reformatted, expected);
  assert.equal((await scorer.scoreCase(reformatted, record)).correct, true);
  const wrongValue = expected.replace('value="REI90"', 'value="REI120"');
  assert.notEqual(wrongValue, expected, 'fixture assumption: the expected IDS enumerates REI90');
  const score = await scorer.scoreCase(wrongValue, record);
  assert.equal(score.correct, false);
  assert.equal(score.unchanged, false);
});

test('an unparseable candidate is never correct and is counted', async () => {
  const record = cases[0];
  const score = await scorer.scoreCase('<ids><not-closed>', record);
  assert.equal(score.correct, false);
  assert.match(score.error, /does not parse/);
  assert.equal(score.audit.status, 'error');
  assert.equal(summariseE4([score]).unparseable, 1);
});

test('summariseE4 reports null accuracy for an empty run rather than a perfect one', () => {
  assert.equal(summariseE4([]).accuracy, null);
});
