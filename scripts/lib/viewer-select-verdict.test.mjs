/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selected viewer tests' commit status: which state each outcome posts,
 * and the request that posts it. The retry is driven end to end through the
 * CLI in scripts/ci-viewer-select.test.mjs.
 *
 * Run: node --test scripts/lib/viewer-select-verdict.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STATUS_CONTEXT, postStatus, selectionStatus } from './viewer-select-verdict.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'viewer-select-verdict-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

test('status: pending at the start; success only on nothing to run or a pass', () => {
  assert.equal(selectionStatus({ phase: 'start' }).state, 'pending');
  assert.deepEqual(selectionStatus({ run: 'false', selectOutcome: 'success' }), { state: 'success', description: 'No viewer test file selected to run' });
  const pass = { files: 3, exitCode: 0, failedFiles: [], retry: null, passed: true };
  assert.deepEqual(selectionStatus({ run: 'true', selectOutcome: 'success', result: pass }), { state: 'success', description: '3 selected viewer test file(s) passed' });
  const flaky = { files: 3, exitCode: 1, failedFiles: ['src/a.test.ts'], retry: { passed: true }, passed: true };
  assert.equal(selectionStatus({ run: 'true', selectOutcome: 'success', result: flaky }).description, '3 selected viewer test file(s) passed, 1 after a retry');
});

test('status: FAIL CLOSED on a failed file, a missing result, or a select step that did not succeed', () => {
  const failed = { files: 3, exitCode: 1, failedFiles: ['src/a.test.ts', 'src/b.test.ts'], retry: { passed: false }, passed: false };
  assert.deepEqual(selectionStatus({ run: 'true', selectOutcome: 'success', result: failed }), {
    state: 'failure', description: '2 of 3 selected viewer test file(s) failed: src/a.test.ts, src/b.test.ts',
  });
  assert.equal(selectionStatus({ run: 'true', selectOutcome: 'success', result: { files: 3, exitCode: 1, failedFiles: [], passed: false } }).description, 'Selected viewer tests failed (exit 1)');
  assert.equal(selectionStatus({ run: 'true', selectOutcome: 'success', result: null }).state, 'failure', 'cancelled, timed out or crashed');
  assert.equal(selectionStatus({ run: '', selectOutcome: 'failure' }).state, 'failure');
  const many = { files: 9, exitCode: 1, failedFiles: Array.from({ length: 9 }, (_, i) => `src/some/long/path/file-${i}.test.ts`), passed: false };
  assert.ok(selectionStatus({ run: 'true', selectOutcome: 'success', result: many }).description.length <= 140, 'GitHub caps descriptions at 140');
});

test('status: posts on the head SHA under its context, with a link to the job', async () => {
  const dir = mkdtempSync(join(TMP, 'status-'));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ files: 1, exitCode: 1, failedFiles: ['src/a.test.ts'], retry: null, passed: false }));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 201, text: async () => '' };
  };
  const env = {
    RUN: 'true', SELECT_OUTCOME: 'success', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', HEAD_SHA: 'abc',
    RUN_URL: 'https://github.com/o/r/actions/runs/1', CHECK_RUN_ID: '7',
  };
  assert.equal(await postStatus(['--status', dir], env, fetchImpl), 0);
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/statuses/abc');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    state: 'failure', context: STATUS_CONTEXT, description: '1 of 1 selected viewer test file(s) failed: src/a.test.ts',
    target_url: 'https://github.com/o/r/actions/runs/1/job/7',
  });
  await postStatus(['--status', dir], { ...env, CHECK_RUN_ID: '' }, fetchImpl);
  assert.equal(JSON.parse(calls[1].init.body).target_url, 'https://github.com/o/r/actions/runs/1', 'no job id: the run');
  await assert.rejects(postStatus(['--status', dir], env, async () => ({ ok: false, status: 403, text: async () => 'nope' })), /HTTP 403/);
});
