/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLabelDir, sheetFileErrors } from './label.mjs';
import { REPO_ROOT, RECORDINGS_DIR, loadRecordingDir } from './lib/recording.mjs';
import { run } from './check-ai-eval-manifest.mjs';
import { cloneRoot, writeJson } from './lib/test-root.mjs';

const cli = (...args) => spawnSync('node', [join(REPO_ROOT, 'scripts', 'ai-eval', 'label.mjs'), ...args], { encoding: 'utf8' });
const recordings = loadRecordingDir(RECORDINGS_DIR);
const sheetOf = (id, kind) => JSON.parse(cli('sheet', '--recording', id, '--kind', kind, '--reviewer', 'r1').stdout);

test('sheet builds a valid blank sheet that check accepts and score ignores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-eval-label-'));
  const path = join(dir, 'sheet.json');
  assert.equal(cli('sheet', '--recording', 'clash-summary-release', '--kind', 'claims', '--reviewer', 'r1', '--out', path).status, 0);
  assert.match(cli('check', path).stdout, /1 sheet\(s\) OK/);
  const score = JSON.parse(cli('score', path).stdout);
  assert.equal(score[0].completeReviewers, 0);
  assert.match(score[0].note, /nothing to report/);
});

test('sheet refuses a missing recording, a missing reviewer and a grouping sheet for prose', () => {
  assert.notEqual(cli('sheet', '--recording', 'no-such', '--kind', 'claims', '--reviewer', 'r1').status, 0);
  assert.notEqual(cli('sheet', '--recording', 'clash-summary-release', '--kind', 'claims').status, 0);
  assert.match(cli('sheet', '--recording', 'clash-summary-release', '--kind', 'grouping', '--reviewer', 'r1').stderr, /not a clash\.groups/);
});

test('a sheet whose answer or claim text no longer matches the recording is rejected', () => {
  const sheet = sheetOf('clash-summary-release', 'claims');
  sheet.answerSha256 = '0'.repeat(64);
  sheet.claims[0].text = 'edited';
  const errors = sheetFileErrors([{ name: 's', sheet }], recordings).join('\n');
  assert.match(errors, /recorded answer changed/);
  assert.match(errors, /claim text no longer matches/);
});

test('a reviewer id that looks like a name or e-mail address is rejected by the schema', () => {
  const sheet = sheetOf('clash-summary-release', 'claims');
  sheet.reviewer.id = 'Jane.Doe@example.com';
  assert.match(sheetFileErrors([{ name: 's', sheet }], recordings).join(), /reviewer\.id/);
});

test('free-text notes are privacy-scanned like study sessions', () => {
  const sheet = sheetOf('clash-summary-release', 'claims');
  sheet.claims[0].note = 'checked with jane.doe@example.com on site';
  assert.match(sheetFileErrors([{ name: 's', sheet }], recordings).join(), /privacy scan: e-mail address/);
});

test('negative recordings and unknown tasks are not label material', () => {
  const sheet = sheetOf('clash-summary-release', 'claims');
  const negative = recordings.find(({ recording }) => recording.corpus === 'negative').recording;
  assert.match(sheetFileErrors([{ name: 's', sheet: { ...sheet, recording: negative.id, task: negative.task } }], recordings).join(), /negative recordings are detector tests/);
  assert.match(sheetFileErrors([{ name: 's', sheet: { ...sheet, recording: 'missing-one' } }], recordings).join(), /unknown recording/);
});

test('committed label sheets are validated by the manifest gate', () => {
  const { root, cleanup } = cloneRoot();
  try {
    const sheet = sheetOf('clash-summary-release', 'claims');
    const dir = join(root, 'tests', 'ai-eval', 'labels');
    mkdirSync(dir);
    writeJson(join(dir, 'good.json'), sheet);
    assert.deepEqual(run(root).errors, []);
    assert.equal(loadLabelDir(root).length, 1);
    writeJson(join(dir, 'stale.json'), { ...sheet, answerSha256: '1'.repeat(64) });
    assert.ok(run(root).errors.some(error => /label stale\.json: the recorded answer changed/.test(error)));
  } finally { cleanup(); }
});
