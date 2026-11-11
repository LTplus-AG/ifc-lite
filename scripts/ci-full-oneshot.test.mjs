/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-shot `ci:full`: the decision, the CLI against a recording fake `gh`,
 * and the workflow wiring.
 *
 * Run: node --test scripts/ci-full-oneshot.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { FAST_SKIPPED_JOBS, FULL_LABEL } from './ci-pr-lane.mjs';
import { FAST_SKIPPED_JOB_NAMES, decideOneshot, ranFullLane, run } from './ci-full-oneshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const TEST_YML = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'));
const ONESHOT_YML = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci-full-oneshot.yml'), 'utf8'));

const TMP = mkdtempSync(join(tmpdir(), 'ci-full-oneshot-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const SHA = 'a'.repeat(40);
const FULL_JOBS = [{ name: 'Detect changes', conclusion: 'success' }, { name: 'Viewer tests (shard 0)', conclusion: 'success' }];
const FAST_JOBS = [{ name: 'Detect changes', conclusion: 'success' }, { name: 'Viewer tests (shard 0)', conclusion: 'skipped' }, { name: 'Rust tests (retained)', conclusion: 'skipped' }];
const openPr = (over = {}) => ({ number: 7, state: 'open', headSha: SHA, labels: [FULL_LABEL, 'bug'], ...over });

const BASE = {
  mode: 'on',
  prLane: 'fast',
  run: { event: 'pull_request', conclusion: 'success', headSha: SHA },
  pr: () => openPr(),
  jobs: () => FULL_JOBS,
};
const decide = (over = {}) => decideOneshot({ ...BASE, ...over });

// ---------------------------------------------------------------- the decision

test('`on` removes the label after a full-lane run that passed or failed', () => {
  assert.equal(decide().action, 'remove');
  assert.equal(decide({ run: { ...BASE.run, conclusion: 'failure' } }).action, 'remove');
  assert.equal(decide().number, 7);
});

test('`shadow` only records; unset, `off` and typos leave labels alone', () => {
  assert.equal(decide({ mode: 'shadow' }).action, 'would-remove');
  for (const mode of [undefined, '', 'off', 'OFF']) assert.equal(decide({ mode }).action, 'keep', String(mode));
  for (const mode of ['true', ' on', 'remove']) {
    const d = decide({ mode });
    assert.equal(d.action, 'keep', mode);
    assert.match(d.warning ?? '', /not one of off, shadow, on/); // @source-text-assertion-ok subject is the decision's returned message
  }
});

test('KEEP: every condition short of a proven full-lane run on the current head', () => {
  const cases = {
    'CI_PR_LANE full': { prLane: 'full' },
    'CI_PR_LANE shadow': { prLane: 'shadow' },
    'CI_PR_LANE unset': { prLane: undefined },
    'push run': { run: { ...BASE.run, event: 'push' } },
    'merge_group run': { run: { ...BASE.run, event: 'merge_group' } },
    cancelled: { run: { ...BASE.run, conclusion: 'cancelled' } },
    skipped: { run: { ...BASE.run, conclusion: 'skipped' } },
    'no PR': { pr: () => null },
    'closed PR': { pr: () => openPr({ state: 'closed' }) },
    'newer head': { pr: () => openPr({ headSha: 'b'.repeat(40) }) },
    'run has no head sha': { run: { ...BASE.run, headSha: undefined } },
    'no label': { pr: () => openPr({ labels: ['bug'] }) },
    'similar label': { pr: () => openPr({ labels: ['ci:fullish', 'full'] }) },
    'fast-lane run (label added mid-run)': { jobs: () => FAST_JOBS },
    'no jobs': { jobs: () => [] },
    'PR unreadable': { pr: () => { throw new Error('HTTP 502'); } },
    'jobs unreadable': { jobs: () => { throw new Error('HTTP 502'); } },
  };
  for (const [name, over] of Object.entries(cases)) {
    for (const mode of ['on', 'shadow']) assert.equal(decide({ ...over, mode }).action, 'keep', `${name} / ${mode}`);
  }
});

test('the API is read only once the cheap checks pass', () => {
  const boom = () => { throw new Error('must not be read'); };
  for (const over of [{ mode: 'off' }, { prLane: 'full' }, { run: { ...BASE.run, conclusion: 'cancelled' } }]) {
    assert.equal(decide({ ...over, pr: boom, jobs: boom }).warning, undefined, JSON.stringify(over));
  }
  assert.equal(decide({ pr: () => openPr({ labels: [] }), jobs: boom }).action, 'keep', 'no jobs call without the label');
});

test('ranFullLane counts a fast-skipped lane that ran, whatever its verdict, and nothing else', () => {
  assert.equal(ranFullLane([{ name: 'Node tests (shard 2/4)', conclusion: 'failure' }]), true);
  assert.equal(ranFullLane([{ name: 'Viewer E2E smoke (3/8)', conclusion: 'cancelled' }]), true);
  assert.equal(ranFullLane([{ name: 'Rust tests', conclusion: 'success' }, { name: 'Lint', conclusion: 'success' }]), false, 'lanes the fast lane also runs prove nothing');
  assert.equal(ranFullLane([{ name: 'Provenance tests', conclusion: null }]), false, 'still queued');
  assert.equal(ranFullLane(null), false);
});

test('the job names match test.yml for every job the fast lane skips', () => {
  assert.deepEqual(Object.keys(FAST_SKIPPED_JOB_NAMES).sort(), [...FAST_SKIPPED_JOBS].sort());
  for (const key of FAST_SKIPPED_JOBS) {
    // The published name up to its first matrix expression.
    assert.equal(FAST_SKIPPED_JOB_NAMES[key], TEST_YML.jobs[key].name.split('$' + '{{')[0], key);
  }
});

// ---------------------------------------------------------------- the CLI

function fakeGh(routes) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    for (const [match, reply] of routes) if (args.join(' ').includes(match)) return typeof reply === 'function' ? reply(args) : reply;
    return { status: 1, stdout: '', stderr: 'unexpected call' };
  };
  return { gh, calls };
}
const ok = (v) => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
const prJson = (over = {}) => ({ number: 7, state: 'open', head: { sha: SHA }, labels: [{ name: FULL_LABEL }], ...over });

function cli(env, routes, payload = {}) {
  const event = join(TMP, `event-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(event, JSON.stringify({ workflow_run: { id: 99, event: 'pull_request', conclusion: 'success', head_sha: SHA, head_branch: 'feat', head_repository: { owner: { login: 'o' } }, pull_requests: [{ number: 7 }], ...payload } }));
  const summary = join(TMP, `summary-${Math.random().toString(36).slice(2)}`);
  writeFileSync(summary, '');
  const { gh, calls } = fakeGh(routes);
  const d = run(['--run'], { REPO: 'o/r', GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary, CI_FULL_ONESHOT: 'on', CI_PR_LANE: 'fast', ...env }, gh);
  return { d, calls, summary: readFileSync(summary, 'utf8') };
}
const ROUTES = [
  ['repos/o/r/pulls/7', ok(prJson())],
  ['actions/runs/99/jobs', ok([{ jobs: FULL_JOBS }])],
  ['-X DELETE', ok({})],
];

test('CLI `on`: removes the label with one DELETE and says so in the summary', () => {
  const r = cli({}, ROUTES);
  assert.equal(r.d.action, 'remove');
  assert.deepEqual(r.calls.filter((c) => c.includes('DELETE')), [`api -X DELETE repos/o/r/issues/7/labels/${encodeURIComponent(FULL_LABEL)}`]);
  assert.match(r.summary, /Removed `ci:full` from #7/); // @source-text-assertion-ok subject is the summary the run wrote
});

test('CLI `shadow`: records in the summary and never writes to the PR', () => {
  const r = cli({ CI_FULL_ONESHOT: 'shadow' }, ROUTES);
  assert.equal(r.d.action, 'would-remove');
  assert.ok(!r.calls.some((c) => c.includes('DELETE')));
  assert.match(r.summary, /would remove `ci:full` from #7/); // @source-text-assertion-ok subject is the summary the run wrote
});

test('CLI `off`: no API call at all', () => {
  const r = cli({ CI_FULL_ONESHOT: '' }, ROUTES);
  assert.equal(r.d.action, 'keep');
  assert.deepEqual(r.calls, []);
});

test('CLI: a fork PR (no linked number) is found by head branch and sha', () => {
  const r = cli({}, [['repos/o/r/pulls -f state=open -f head=o:feat', ok([prJson({ head: { sha: 'c'.repeat(40) } }), prJson()])], ...ROUTES.slice(1)], { pull_requests: [] });
  assert.equal(r.d.action, 'remove');
});

test('CLI: an already-removed label is fine; any other DELETE failure is an error', () => {
  const gone = cli({}, [...ROUTES.slice(0, 2), ['-X DELETE', { status: 1, stdout: '', stderr: 'gh: Label does not exist (HTTP 404)' }]]);
  assert.equal(gone.d.action, 'remove');
  assert.throws(() => cli({}, [...ROUTES.slice(0, 2), ['-X DELETE', { status: 1, stdout: '', stderr: 'HTTP 403' }]]), /could not remove/);
});

// ---------------------------------------------------------------- the workflow

test('WORKFLOW: workflow_run on Test, never runs PR code, least privilege, per-PR concurrency', () => {
  assert.deepEqual(ONESHOT_YML.on, { workflow_run: { workflows: ['Test'], types: ['completed'] } });
  assert.deepEqual(ONESHOT_YML.permissions, { contents: 'read', 'pull-requests': 'write', actions: 'read' });
  const job = ONESHOT_YML.jobs.oneshot;
  assert.match(job.if, /github\.event\.workflow_run\.event == 'pull_request'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  assert.match(job.if, /vars\.CI_FULL_ONESHOT == 'shadow' \|\| vars\.CI_FULL_ONESHOT == 'on'/, 'off starts no job'); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  assert.match(job.concurrency.group, /workflow_run\.pull_requests\[0\]\.number/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  assert.equal(job.concurrency['cancel-in-progress'], false);
  const checkout = job.steps.find((s) => String(s.uses).startsWith('actions/checkout@'));
  // The literal workflow expression this test pins, not a template string.
  // eslint-disable-next-line no-template-curly-in-string
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(checkout.with['persist-credentials'], false);
  for (const s of job.steps) {
    assert.ok(!/workflow_run\.head_(sha|branch)/.test(JSON.stringify(s.with ?? {})), 'no step checks out the PR head'); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  }
  assert.ok(job.steps.some((s) => s.run === 'node scripts/ci-full-oneshot.mjs --run'));
});

test('WORKFLOW: Test does not re-run on a label change, so removing the label starts nothing', () => {
  const types = TEST_YML.on.pull_request.types;
  assert.ok(!types.includes('labeled') && !types.includes('unlabeled'), types.join(','));
});
