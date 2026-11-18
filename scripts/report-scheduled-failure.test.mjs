/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reportScheduledFailure } from './report-scheduled-failure.mjs';

const env = { WORKFLOW_NAME: 'Wide arithmetic', JOBS: 'tripwire', RESULT: 'failure', RUN_URL: 'https://example.invalid/run/1', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '42' };
const title = 'ci: scheduled Wide arithmetic lane failed';
const jobsListing = JSON.stringify({
  jobs: [
    { name: 'report', conclusion: null, steps: [{ name: 'Open or update', conclusion: null }] },
    { name: 'passed', conclusion: 'success', steps: [{ name: 'fine', conclusion: 'success' }] },
    { name: 'tripwire', conclusion: 'failure', steps: [{ name: 'setup', conclusion: 'success' }, { name: 'Engine probe', conclusion: 'failure' }] },
    { name: 'cut short', conclusion: 'failure', steps: [] },
  ],
});
const expectedBody = [
  'The scheduled Wide arithmetic lane failed (jobs: tripwire; results: failure).',
  'Failed steps:\n- tripwire › Engine probe\n- cut short',
  'Run: https://example.invalid/run/1',
].join('\n\n');

/** A gh boundary answering the three calls the reporter makes. */
const isJobsLookup = (args) => args.some((arg) => arg.includes('/actions/runs/'));
const fakeGh = (calls, issues = [], jobs = jobsListing) => (args) => {
  calls.push(args);
  if (isJobsLookup(args)) return typeof jobs === 'function' ? jobs() : jobs;
  return args[1] === 'list' ? JSON.stringify(issues) : '';
};

test('#4144: the real reporter creates an issue through a mocked gh boundary', () => {
  const calls = [];
  const result = reportScheduledFailure(env, fakeGh(calls));
  assert.deepEqual(result, { action: 'create', title, body: expectedBody });
  assert.deepEqual(calls.at(-1), ['issue', 'create', '--repo', 'owner/repo', '--title', title, '--body', expectedBody]);
});

test('#4144: the real reporter updates only an exact-title issue', () => {
  const calls = [];
  const result = reportScheduledFailure(env, fakeGh(calls, [{ number: 2, title: `${title} old` }, { number: 7, title }]));
  assert.deepEqual(result, { action: 'comment', number: 7, title, body: expectedBody });
  assert.deepEqual(calls.at(-1), ['issue', 'comment', '7', '--repo', 'owner/repo', '--body', expectedBody]);
});

test('#4144: dry-run never calls gh, and malformed gh JSON fails closed', () => {
  assert.equal(reportScheduledFailure({ ...env, DRY_RUN: 'true' }, () => assert.fail('gh called')).action, 'dry-run');
  assert.throws(() => reportScheduledFailure(env, (args) => (isJobsLookup(args) ? jobsListing : '{}')), /non-array/);
});

test('#9016: the report asks for the run it is reporting and names no passing step', () => {
  const calls = [];
  const { body } = reportScheduledFailure(env, fakeGh(calls));
  assert.equal(calls[0][1], 'repos/owner/repo/actions/runs/42/jobs?filter=latest&per_page=100');
  assert.ok(!body.includes('fine') && !body.includes('setup') && !body.includes('Open or update'), body);
});

test('#9016: a lane-specific detail reaches the issue, and a blank one adds no section', () => {
  const detail = '- `issue-129.geometry` (Ir) is +289,162,639 (+1.04%) over its ceiling';
  const { body } = reportScheduledFailure({ ...env, DETAIL: `\n${detail}\n` }, fakeGh([]));
  assert.ok(body.includes(`Detail:\n${detail}`), body);
  assert.ok(!reportScheduledFailure({ ...env, DETAIL: '  ' }, fakeGh([])).body.includes('Detail:'));
});

test('#9016: a failed step lookup still files the report and says why', () => {
  const stderr = console.error;
  console.error = () => {};
  try {
    const refuse = () => { throw new Error('HTTP 403'); };
    for (const [name, jobs] of [['refused', refuse], ['malformed', '{}'], ['not JSON', 'nope']]) {
      const calls = [];
      const result = reportScheduledFailure(env, fakeGh(calls, [], jobs));
      assert.equal(result.action, 'create', name);
      assert.match(result.body, /Failed steps unavailable: /, name);
    }
    const { GITHUB_RUN_ID: _unset, ...noRun } = env;
    const calls = [];
    assert.match(reportScheduledFailure(noRun, fakeGh(calls)).body, /GITHUB_RUN_ID is not set/);
    assert.ok(!calls.some(isJobsLookup));
  } finally {
    console.error = stderr;
  }
});

test('#9016: a run with no failed job says so instead of an empty list', () => {
  const jobs = JSON.stringify({ jobs: [{ name: 'passed', conclusion: 'success', steps: [] }] });
  assert.match(reportScheduledFailure(env, fakeGh([], [], jobs)).body, /No failed job in the run/);
});

test('#9235 review: a job that times out is named, with how it ended', () => {
  const jobs = JSON.stringify({
    jobs: [{ name: 'measure', conclusion: 'timed_out', steps: [{ name: 'setup', conclusion: 'success' }, { name: 'Measure large set', conclusion: 'cancelled' }, { name: 'after', conclusion: 'skipped' }] }],
  });
  const { body } = reportScheduledFailure(env, fakeGh([], [], jobs));
  assert.ok(body.includes('Failed steps:\n- measure › Measure large set (timed out)'), body);
  assert.ok(!body.includes('No failed job') && !body.includes('after'), body);
});

test('nightly-red: a labelled report creates a missing label, then labels a new issue', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (isJobsLookup(args)) return jobsListing;
    if (args[0] === 'label' && args[1] === 'list') return JSON.stringify([{ name: 'bug' }]);
    return args[1] === 'list' ? '[]' : '';
  };
  reportScheduledFailure({ ...env, LABELS: ' nightly-red , bug ' }, gh);
  assert.deepEqual(calls.filter((c) => c[0] === 'label' && c[1] === 'create').map((c) => c[2]), ['nightly-red']);
  assert.deepEqual(calls.at(-1), ['issue', 'create', '--repo', 'owner/repo', '--title', title, '--body', expectedBody, '--label', 'nightly-red', '--label', 'bug']);
});

test('nightly-red: an existing issue gets the comment and its label back', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (isJobsLookup(args)) return jobsListing;
    if (args[0] === 'label') return JSON.stringify([{ name: 'nightly-red' }]);
    return args[1] === 'list' ? JSON.stringify([{ number: 7, title }]) : '';
  };
  const result = reportScheduledFailure({ ...env, LABELS: 'nightly-red' }, gh);
  assert.equal(result.number, 7);
  assert.ok(!calls.some((c) => c[0] === 'label' && c[1] === 'create'));
  assert.deepEqual(calls.slice(-2), [['issue', 'comment', '7', '--repo', 'owner/repo', '--body', expectedBody], ['issue', 'edit', '7', '--repo', 'owner/repo', '--add-label', 'nightly-red']]);
});

test('nightly-red: a label API failure files the report without the label instead of losing it', () => {
  const calls = [];
  const stderr = console.error;
  console.error = () => {};
  try {
    const gh = (args) => {
      calls.push(args);
      if (isJobsLookup(args)) return jobsListing;
      if (args[0] === 'label') throw new Error('HTTP 502');
      return args[1] === 'list' ? '[]' : '';
    };
    assert.equal(reportScheduledFailure({ ...env, LABELS: 'nightly-red' }, gh).action, 'create');
  } finally {
    console.error = stderr;
  }
  assert.deepEqual(calls.at(-1), ['issue', 'create', '--repo', 'owner/repo', '--title', title, '--body', expectedBody]);
});

test('nightly-red: a label that exists in another case is reused, not re-created', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (isJobsLookup(args)) return jobsListing;
    if (args[0] === 'label') return JSON.stringify([{ name: 'Nightly-Red' }]);
    return args[1] === 'list' ? '[]' : '';
  };
  reportScheduledFailure({ ...env, LABELS: 'nightly-red' }, gh);
  assert.ok(!calls.some((c) => c[0] === 'label' && c[1] === 'create'));
  assert.deepEqual(calls.at(-1).slice(-2), ['--label', 'Nightly-Red']);
});
