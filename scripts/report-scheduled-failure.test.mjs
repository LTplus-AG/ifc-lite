/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reportScheduledFailure } from './report-scheduled-failure.mjs';

const env = { WORKFLOW_NAME: 'Wide arithmetic', JOBS: 'tripwire', RESULT: 'failure', RUN_URL: 'https://example.invalid/run/1', GITHUB_REPOSITORY: 'owner/repo' };

test('#4144: the real reporter creates an issue through a mocked gh boundary', () => {
  const calls = [];
  const result = reportScheduledFailure(env, (args) => { calls.push(args); return args[1] === 'list' ? '[]' : ''; });
  assert.equal(result.action, 'create');
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['issue', 'list'], ['issue', 'create']]);
  assert.ok(calls[1].includes('ci: scheduled Wide arithmetic lane is not reporting'));
});

test('#4144: the real reporter updates only an exact-title issue', () => {
  const calls = [];
  const title = 'ci: scheduled Wide arithmetic lane is not reporting';
  const result = reportScheduledFailure(env, (args) => {
    calls.push(args);
    return args[1] === 'list' ? JSON.stringify([{ number: 2, title: `${title} old` }, { number: 7, title }]) : '';
  });
  assert.deepEqual(result, { action: 'comment', number: 7, title, body: result.body });
  assert.deepEqual(calls[1].slice(0, 3), ['issue', 'comment', '7']);
});

test('#4144: dry-run never calls gh, and malformed gh JSON fails closed', () => {
  assert.equal(reportScheduledFailure({ ...env, DRY_RUN: 'true' }, () => assert.fail('gh called')).action, 'dry-run');
  assert.throws(() => reportScheduledFailure(env, () => '{}'), /non-array/);
});
