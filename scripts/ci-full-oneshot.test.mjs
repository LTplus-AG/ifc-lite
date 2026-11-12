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
  run: { event: 'pull_request', conclusion: 'success', headSha: SHA, createdAt: '2026-11-10T10:00:00Z' },
  pr: () => openPr(),
  jobs: () => FULL_JOBS,
  labeledAt: () => '2026-11-10T09:59:00Z',
};
const decide = (over = {}) => decideOneshot({ ...BASE, ...over });

// ---------------------------------------------------------------- the decision

test('`on` removes the label after a full-lane run that passed', () => {
  assert.equal(decide().action, 'remove');
  assert.equal(decide().number, 7);
});

test('KEEP after a red run, even when a fast-skipped lane ran (#9787 review)', () => {
  // `build` failed: the viewer, node and provenance lanes skipped on their
  // dependency while rust-retained (needs only `changes`) ran. Not a full pass.
  const buildFailed = [
    { name: 'Build packages + WASM', conclusion: 'failure' },
    { name: 'Viewer tests (shard 0)', conclusion: 'skipped' },
    { name: 'Node tests (shard 1/4)', conclusion: 'skipped' },
    { name: 'Rust tests (retained)', conclusion: 'success' },
  ];
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral', 'action_required', undefined]) {
    assert.equal(decide({ run: { ...BASE.run, conclusion }, jobs: () => buildFailed }).action, 'keep', String(conclusion));
    assert.equal(decide({ mode: 'shadow', run: { ...BASE.run, conclusion } }).action, 'keep', `shadow ${conclusion}`);
  }
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
    'label applied after the run was created': { labeledAt: () => '2026-11-10T10:00:01Z' },
    'label history empty': { labeledAt: () => null },
    'label history unreadable': { labeledAt: () => { throw new Error('HTTP 502'); } },
    'run has no creation time': { run: { ...BASE.run, createdAt: undefined } },
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

test('ranFullLane counts only a fast-skipped lane that ran to success', () => {
  assert.equal(ranFullLane([{ name: 'Node tests (shard 2/4)', conclusion: 'success' }]), true);
  for (const conclusion of ['cancelled', 'failure', 'skipped']) {
    assert.equal(ranFullLane([{ name: 'Viewer E2E smoke (3/8)', conclusion }]), false, conclusion);
  }
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

/** Stands in for scripts/lib/gh.mjs: returns parsed JSON or throws. */
function fakeGh(routes) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    for (const [match, reply] of routes) {
      if (!args.join(' ').includes(match)) continue;
      if (reply instanceof Error) throw reply;
      return reply;
    }
    throw new Error('unexpected call');
  };
  return { gh, calls };
}
const ok = (v) => v;
const prJson = (over = {}) => ({ number: 7, state: 'open', head: { sha: SHA, repo: { id: 1, full_name: 'o/r' } }, labels: [{ name: FULL_LABEL }], ...over });

function cli(env, routes, payload = {}) {
  const event = join(TMP, `event-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(event, JSON.stringify({ workflow_run: { id: 99, event: 'pull_request', conclusion: 'success', head_sha: SHA, head_branch: 'feat', created_at: '2026-11-10T10:00:00Z', head_repository: { id: 1, full_name: 'o/r', owner: { login: 'o' } }, pull_requests: [{ number: 7, head: { sha: SHA, repo: { id: 1 } }, base: { repo: { url: 'https://api.github.com/repos/o/r' } } }], ...payload } }));
  const summary = join(TMP, `summary-${Math.random().toString(36).slice(2)}`);
  writeFileSync(summary, '');
  const { gh, calls } = fakeGh(routes);
  const d = run(['--run'], { REPO: 'o/r', GITHUB_EVENT_PATH: event, GITHUB_STEP_SUMMARY: summary, CI_FULL_ONESHOT: 'on', CI_PR_LANE: 'fast', ...env }, gh);
  return { d, calls, summary: readFileSync(summary, 'utf8') };
}
const ROUTES = [
  ['repos/o/r/pulls/7', ok(prJson())],
  ['actions/runs/99/jobs', ok([{ jobs: FULL_JOBS }])],
  ['issues/7/events', ok([[{ event: 'labeled', label: { name: FULL_LABEL }, created_at: '2026-11-10T09:00:00Z' }, { event: 'labeled', label: { name: 'bug' }, created_at: '2026-11-10T11:00:00Z' }]])],
  ['-X DELETE', ok([])],
];

test('CLI `on`: removes the label with one DELETE and says so in the summary', () => {
  const r = cli({}, ROUTES);
  assert.equal(r.d.action, 'remove');
  assert.deepEqual(r.calls.filter((c) => c.includes('DELETE')), [`api -X DELETE repos/o/r/issues/7/labels/${encodeURIComponent(FULL_LABEL)}`]); // @source-text-assertion-ok subject is the API calls the CLI made
  assert.match(r.summary, /Removed `ci:full` from #7/); // @source-text-assertion-ok subject is the run summary the CLI wrote
});

test('CLI `shadow`: records in the summary and never writes to the PR', () => {
  const r = cli({ CI_FULL_ONESHOT: 'shadow' }, ROUTES);
  assert.equal(r.d.action, 'would-remove');
  assert.ok(!r.calls.some((c) => c.includes('DELETE'))); // @source-text-assertion-ok subject is the API calls the CLI made
  assert.match(r.summary, /would remove `ci:full` from #7/); // @source-text-assertion-ok subject is the run summary the CLI wrote
});

test('CLI `off`: no API call at all', () => {
  const r = cli({ CI_FULL_ONESHOT: '' }, ROUTES);
  assert.equal(r.d.action, 'keep');
  assert.deepEqual(r.calls, []);
});

test('CLI: a fork PR (no linked number) is found by head branch and sha', () => {
  const fork = { id: 2, full_name: 'f/r', owner: { login: 'f' } };
  const forkPr = (sha) => prJson({ head: { sha, repo: { id: 2, full_name: 'f/r' } } });
  const r = cli({}, [['repos/o/r/pulls -f state=open -f head=f:feat', ok([forkPr('c'.repeat(40)), forkPr(SHA)])], ...ROUTES.slice(1)], { pull_requests: [], head_repository: fork });
  assert.equal(r.d.action, 'remove');
});

test('CLI: a PR whose head repository is not the run\'s is ignored, on both lookup paths (#9787 review)', () => {
  // Same head SHA pushed from another repository (id 9), alone: nothing matches.
  const evil = { head: { sha: SHA, repo: { id: 9, full_name: 'evil/r' } } };
  // No linked entry matches, so the lookup falls through to the branch listing, which holds only the foreign PR.
  const linked = cli({}, [['repos/o/r/pulls -f state=open -f head=o:feat', ok([prJson({ number: 8, ...evil })])], ...ROUTES], { pull_requests: [{ number: 8, ...evil, base: { repo: { url: 'https://api.github.com/repos/o/r' } } }] });
  const listed = cli({}, [['repos/o/r/pulls -f state=open -f head=o:feat', ok([prJson({ number: 8, ...evil })])], ...ROUTES.slice(1)], { pull_requests: [] });
  for (const r of [linked, listed]) {
    assert.equal(r.d.action, 'keep');
    assert.match(r.d.reason, /from this run's head repository/); // @source-text-assertion-ok subject is the decision's returned reason
    assert.ok(!r.calls.some((c) => c.includes('DELETE'))); // @source-text-assertion-ok subject is the API calls the CLI made
  }
  assert.ok(!linked.calls.includes('api repos/o/r/pulls/8'), 'the foreign linked PR is never read'); // @source-text-assertion-ok subject is the API calls the CLI made
});

test('CLI: a foreign PR listed FIRST does not hide the real one, on both lookup paths', () => {
  const evil = { number: 8, head: { sha: SHA, repo: { id: 9, full_name: 'evil/r' } } };
  const real = { number: 7, head: { sha: SHA, repo: { id: 1 } }, base: { repo: { url: 'https://api.github.com/repos/o/r' } } };
  const linked = cli({}, ROUTES, { pull_requests: [{ ...evil, base: real.base }, real] });
  const listed = cli({}, [['repos/o/r/pulls -f state=open -f head=o:feat', ok([prJson(evil), prJson()])], ...ROUTES.slice(1)], { pull_requests: [] });
  for (const r of [linked, listed]) {
    assert.equal(r.d.action, 'remove');
    assert.equal(r.d.number, 7);
  }
});

test('CLI: a renamed head repository still matches by id, on both lookup paths', () => {
  const renamed = prJson({ head: { sha: SHA, repo: { id: 1, full_name: 'o/renamed' } } });
  assert.equal(cli({}, [['repos/o/r/pulls/7', ok(renamed)], ...ROUTES.slice(1)]).d.action, 'remove');
  assert.equal(cli({}, [['repos/o/r/pulls -f state=open -f head=o:feat', ok([renamed])], ...ROUTES.slice(1)], { pull_requests: [] }).d.action, 'remove');
});

test('CLI: the live linked PR must come from the run\'s head repository too, not only the webhook entry', () => {
  const r = cli({}, [['repos/o/r/pulls/7', ok(prJson({ head: { sha: SHA, repo: { id: 9, full_name: 'evil/r' } } }))], ['repos/o/r/pulls -f state=open', ok([])], ...ROUTES.slice(1)]);
  assert.equal(r.d.action, 'keep');
  assert.ok(!r.calls.some((c) => c.includes('DELETE'))); // @source-text-assertion-ok subject is the API calls the CLI made
});

test('CLI: a PR of another repository listed for the same head is not this run\'s PR', () => {
  const other = { number: 3, head: { sha: SHA, repo: { id: 1 } }, base: { repo: { url: 'https://api.github.com/repos/fork/r' } } };
  const r = cli({}, [['repos/o/r/pulls -f state=open -f head=o:feat', ok([prJson()])], ...ROUTES.slice(1)], { pull_requests: [other] });
  assert.ok(!r.calls.includes('api repos/o/r/pulls/3'), 'never reads #3 of this repo'); // @source-text-assertion-ok subject is the API calls the CLI made
  assert.equal(r.d.action, 'remove');
});

test('CLI: a label re-applied after the run started is kept', () => {
  const late = [['issues/7/events', ok([[{ event: 'labeled', label: { name: FULL_LABEL }, created_at: '2026-11-10T10:05:00Z' }]])]];
  const r = cli({}, [...late, ...ROUTES]);
  assert.equal(r.d.action, 'keep');
  assert.ok(!r.calls.some((c) => c.includes('DELETE'))); // @source-text-assertion-ok subject is the API calls the CLI made
});

test('CLI: an already-removed label is fine; any other DELETE failure is an error', () => {
  const routes = (err) => [...ROUTES.slice(0, 3), ['-X DELETE', err]];
  assert.equal(cli({}, routes(new Error('gh: Label does not exist (HTTP 404)'))).d.action, 'remove');
  assert.throws(() => cli({}, routes(new Error('HTTP 403'))), /could not remove/);
});

// ---------------------------------------------------------------- the workflow

const checkoutFiles = (job) => job.steps.find((s) => String(s.uses).startsWith('actions/checkout@')).with['sparse-checkout'].trim().split('\n').map((l) => l.trim()); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML

test('WORKFLOW: workflow_run on Test, never runs PR code, least privilege, per-PR concurrency', () => {
  assert.deepEqual(ONESHOT_YML.on, { workflow_run: { workflows: ['Test'], types: ['completed'] } });
  assert.deepEqual(ONESHOT_YML.permissions, { contents: 'read', 'pull-requests': 'write', actions: 'read' });
  const job = ONESHOT_YML.jobs.oneshot;
  // Exact, so no added clause can start the job with the switch off.
  assert.equal(job.if, "github.event.workflow_run.event == 'pull_request' && (vars.CI_FULL_ONESHOT == 'shadow' || vars.CI_FULL_ONESHOT == 'on')");
  // The literal workflow expression this test pins, not a template string.
  // eslint-disable-next-line no-template-curly-in-string
  assert.equal(job.concurrency.group, 'ci-full-oneshot-${{ github.event.workflow_run.head_repository.id }}-${{ github.event.workflow_run.head_branch }}');
  // The sparse checkout must hold the script's whole import closure, or the
  // job dies on a missing module only once the switch is on.
  const closure = new Set();
  const walk = (rel) => {
    if (closure.has(rel)) return;
    closure.add(rel);
    for (const [, spec] of readFileSync(join(REPO_ROOT, rel), 'utf8').matchAll(/^import .* from '(\.[^']+)';$/gm)) walk(join(dirname(rel), spec));
  };
  walk('scripts/ci-full-oneshot.mjs');
  assert.deepEqual(checkoutFiles(job).sort(), [...closure].sort());
  assert.equal(job.concurrency['cancel-in-progress'], false);
  const checkout = job.steps.find((s) => String(s.uses).startsWith('actions/checkout@')); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  // The literal workflow expression this test pins, not a template string.
  // eslint-disable-next-line no-template-curly-in-string
  assert.equal(checkout.with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(checkout.with['persist-credentials'], false);
  for (const s of job.steps) {
    assert.ok(!/workflow_run\.head_|pull_request\.head|refs\/pull\//.test(JSON.stringify(s)), `no step may reach the PR's code: ${JSON.stringify(s)}`); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  }
  assert.ok(job.steps.some((s) => s.run === 'node scripts/ci-full-oneshot.mjs --run'));
});

test('WORKFLOW: Test does not re-run on a label change, so removing the label starts nothing', () => {
  const types = TEST_YML.on.pull_request.types;
  assert.ok(!types.includes('labeled') && !types.includes('unlabeled'), types.join(',')); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
});
