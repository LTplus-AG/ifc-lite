/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fast PR lane switch, pinned at three levels: the pure decision and the
 * aggregate's re-derivation, the CLI's outputs and exit codes, and the
 * test.yml wiring plus the `PR review signal` gate reading a fast run.
 *
 * Run: node --test scripts/ci-pr-lane.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { FAST_REDUCED_JOBS, FAST_SKIPPED_JOBS, FULL_LABEL, decideLane, laneFromOutput, verifyLane } from './ci-pr-lane.mjs';
import { matrixSkipAliases, parseWorkflowJobs } from './lib/pr-review-signal.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI = join(HERE, 'ci-pr-lane.mjs');
const GATE = join(HERE, 'check-pr-review-signal.mjs');
const CONFIG = join(HERE, 'pr-review-signal.config.json');
const TEST_YML = join(REPO_ROOT, '.github/workflows/test.yml');
const WORKFLOW = parse(readFileSync(TEST_YML, 'utf8'));

const TMP = mkdtempSync(join(tmpdir(), 'ci-pr-lane-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const labels = (...names) => JSON.stringify(names);
const PR = (mode, l = labels()) => decideLane({ event: 'pull_request', mode, labels: l });

/** `toJSON(needs)` for the aggregate's jobs, every lane at `result`. */
function needsJson(result = 'success', overrides = {}) {
  const out = {};
  for (const j of WORKFLOW.jobs.test.needs) out[j] = { result: overrides[j] ?? result, outputs: {} };
  return JSON.stringify(out);
}

// ---------------------------------------------------------------- the decision

test('unset and `full` are today\'s behaviour: a PR gets the full lanes', () => {
  for (const mode of [undefined, '', 'full', 'FULL']) {
    const d = PR(mode);
    assert.equal(d.lane, 'full', `mode ${JSON.stringify(mode)}`);
    assert.equal(d.wouldBeFast, false);
  }
});

test('`shadow` runs the full lanes and records that the fast lane would have applied', () => {
  const d = PR('shadow');
  assert.equal(d.lane, 'full');
  assert.equal(d.mode, 'shadow');
  assert.equal(d.wouldBeFast, true);
});

test('`fast` on a pull_request selects the fast lane; case-insensitive like Actions `==`', () => {
  assert.equal(PR('fast').lane, 'fast');
  assert.equal(PR('Fast').lane, 'fast');
});

test('a typo or padded value is not a mode: full lanes, with a warning', () => {
  for (const mode of ['fsat', ' fast', 'fast ', 'true', 'on']) {
    const d = PR(mode);
    assert.equal(d.lane, 'full', `mode ${JSON.stringify(mode)}`);
    assert.match(d.warning ?? '', /not one of full, shadow, fast/); // @source-text-assertion-ok subject is the decision's returned message, not a source file
  }
});

test(`the \`${FULL_LABEL}\` label forces the full lanes in fast and shadow mode`, () => {
  assert.equal(PR('fast', labels('bug', FULL_LABEL)).lane, 'full');
  assert.equal(PR('shadow', labels(FULL_LABEL)).wouldBeFast, false);
  assert.equal(PR('fast', labels('ci:fullish', 'full')).lane, 'fast', 'only the exact label counts');
});

test('merge_group and push are full in every mode, labels or not', () => {
  for (const event of ['merge_group', 'push', 'workflow_dispatch', undefined]) {
    for (const mode of [undefined, 'full', 'shadow', 'fast']) {
      const d = decideLane({ event, mode, labels: 'null' });
      assert.equal(d.lane, 'full', `${event} / ${mode}`);
      assert.equal(d.wouldBeFast, false, `${event} / ${mode}`);
    }
  }
});

test('FAIL CLOSED: unreadable labels select the full lanes, since `ci:full` might be among them', () => {
  for (const raw of ['not json', '{"a":1}', '[1,2]']) {
    const d = PR('fast', raw);
    assert.equal(d.lane, 'full', raw);
    assert.match(d.warning ?? '', /could not read PR labels/); // @source-text-assertion-ok subject is the decision's returned message, not a source file
  }
});

test('FAIL CLOSED: only the exact output `fast` skips a lane; empty, absent or garbled runs everything', () => {
  // Mirrors the `!= 'fast'` polarity test.yml uses; the WIRING test below
  // pins that polarity in the workflow itself.
  assert.equal(laneFromOutput('fast'), 'fast');
  for (const raw of [undefined, null, '', 'full', 'fast\n', 'FAST?', 'shadow']) {
    assert.equal(laneFromOutput(raw), 'full', JSON.stringify(raw));
  }
});

// ---------------------------------------------------------------- the aggregate's check

const verify = (over) => verifyLane({ event: 'pull_request', mode: 'fast', labels: labels(), lane: 'fast', needs: needsJson(), ...over });

test('VERIFY: a justified fast lane passes and names every skipped lane', () => {
  const needs = needsJson('success', Object.fromEntries(FAST_SKIPPED_JOBS.map((j) => [j, 'skipped'])));
  const v = verify({ needs });
  assert.equal(v.ok, true, v.lines.join('\n'));
  for (const j of [...FAST_SKIPPED_JOBS, ...Object.keys(FAST_REDUCED_JOBS)]) {
    assert.ok(v.lines.some((l) => l.includes(`\`${j}\``)), `must name ${j}`); // @source-text-assertion-ok subject is the decision's returned message, not a source file
  }
});

test('VERIFY: a fast lane the inputs do not justify fails, on every event and override', () => {
  const cases = [
    { event: 'merge_group' },
    { event: 'push' },
    { mode: undefined },
    { mode: 'full' },
    { mode: 'shadow' },
    { labels: labels(FULL_LABEL) },
    { labels: 'garbage' },
  ];
  for (const c of cases) {
    const v = verify(c);
    assert.equal(v.ok, false, JSON.stringify(c));
    assert.match(v.lines.join('\n'), /UNJUSTIFIED_FAST_LANE/); // @source-text-assertion-ok subject is the decision's returned text
  }
});

test('VERIFY: a decision step that failed (no lane output) ran the full lanes and is not a failure', () => {
  for (const lane of ['', undefined, 'full']) {
    const v = verify({ lane });
    assert.equal(v.ok, true);
  }
  assert.match(verify({ lane: '' }).lines.join('\n'), /decision step failed or is missing/); // @source-text-assertion-ok subject is the decision's returned text
});

test('VERIFY: shadow mode reports the lanes and flags a failure the fast lane would have deferred', () => {
  const clean = verify({ mode: 'shadow', lane: 'full' });
  assert.equal(clean.ok, true);
  assert.match(clean.lines.join('\n'), /would have reached the same verdict/); // @source-text-assertion-ok subject is the decision's returned text
  const missed = verify({ mode: 'shadow', lane: 'full', needs: needsJson('success', { 'viewer-tests': 'failure' }) });
  assert.equal(missed.ok, true, 'shadow reports; the map judges the failure');
  assert.match(missed.lines.join('\n'), /would have deferred a failure to the merge queue: viewer-tests/); // @source-text-assertion-ok subject is the decision's returned text
});

test('VERIFY: unreadable NEEDS and a stale job list both fail', () => {
  assert.equal(verify({ needs: 'nope' }).ok, false);
  const stale = JSON.parse(needsJson());
  delete stale['viewer-e2e'];
  const v = verify({ needs: JSON.stringify(stale) });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /viewer-e2e/); // @source-text-assertion-ok subject is the decision's returned text
});

// ---------------------------------------------------------------- the CLI

function cli(args, env) {
  const out = join(TMP, `out-${Math.random().toString(36).slice(2)}`);
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
  });
  const output = readFileSync(out, 'utf8');
  const outputs = Object.fromEntries(output.split('\n').filter(Boolean).map((l) => l.split('=')));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, output, outputs };
}

test('CLI --decide writes lane and mode outputs', () => {
  const fast = cli(['--decide'], { GITHUB_EVENT_NAME: 'pull_request', CI_PR_LANE: 'fast', PR_LABELS: labels() });
  assert.equal(fast.code, 0, fast.stderr);
  assert.deepEqual(fast.outputs, { lane: 'fast', mode: 'fast', batch: 'false' });
  const batch = cli(['--decide'], { GITHUB_EVENT_NAME: 'pull_request', CI_PR_LANE: 'fast', PR_LABELS: labels(), HEAD_REF: 'mergify/merge-queue/abc' });
  assert.deepEqual(batch.outputs, { lane: 'full', mode: 'fast', batch: 'true' });
  const mq = cli(['--decide'], { GITHUB_EVENT_NAME: 'merge_group', CI_PR_LANE: 'fast', PR_LABELS: 'null' });
  assert.equal(mq.outputs.lane, 'full');
  const typo = cli(['--decide'], { GITHUB_EVENT_NAME: 'pull_request', CI_PR_LANE: 'fsat', PR_LABELS: labels() });
  assert.ok(typo.stdout.startsWith('::warning::'), 'a typo must surface as an annotation'); // @source-text-assertion-ok subject is the CLI's emitted annotation, not a source file
  assert.equal(typo.outputs.lane, 'full');
});

test('CLI FAIL CLOSED: a crashed decision writes no lane, which test.yml reads as full', () => {
  const r = cli(['--decide'], { GITHUB_EVENT_NAME: 'pull_request', CI_PR_LANE: 'fast', PR_LABELS: labels(), GITHUB_OUTPUT: '' });
  assert.equal(r.code, 1);
  assert.equal(r.output, '');
  assert.equal(laneFromOutput(undefined), 'full');
  assert.equal(cli([], {}).code, 1, 'no mode is an error, not a silent no-op');
});

test('CLI --verify exits 1 on an unjustified fast lane and 0 on a justified one', () => {
  const env = { GITHUB_EVENT_NAME: 'pull_request', CI_PR_LANE: 'fast', PR_LABELS: labels(), LANE: 'fast', NEEDS: needsJson() };
  assert.equal(cli(['--verify'], env).code, 0);
  assert.equal(cli(['--verify'], { ...env, GITHUB_EVENT_NAME: 'merge_group' }).code, 1);
  assert.equal(cli(['--verify'], { ...env, PR_LABELS: labels(FULL_LABEL) }).code, 1);
});

// ---------------------------------------------------------------- the wiring

const jobs = WORKFLOW.jobs;
const GATED = "needs.changes.outputs.lane != 'fast'";

test('WIRING: every fast-skipped job is gated with the fail-closed polarity, and no other job is', () => {
  for (const [key, job] of Object.entries(jobs)) {
    const cond = String(job.if ?? '');
    if (FAST_SKIPPED_JOBS.includes(key)) assert.ok(cond.includes(GATED), `${key} must test \`${GATED}\``);
    else assert.ok(!cond.includes(GATED), `${key} is not in FAST_SKIPPED_JOBS but is gated on the lane`);
    assert.ok(!/outputs\.lane\s*==\s*'full'/.test(cond), `${key} must never gate on \`lane == 'full'\``);
  }
});

test('WIRING: rust-tests keeps clippy and machete in fast mode and skips only its test leg', () => {
  const steps = jobs['rust-tests'].steps;
  const byName = (n) => steps.find((s) => s.name === n);
  for (const n of ['Install cargo-nextest', 'Rust tests', 'Rust doctests']) assert.equal(byName(n)?.if, GATED, n);
  for (const n of ['Clippy (lint gate)', 'Unused dependencies (cargo machete)']) assert.equal(byName(n)?.if, undefined, n);
  assert.match(byName('C4-0 native/browser parity report').if, /steps\.rust_tests\.outcome != 'skipped'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
});

test('WIRING: `changes` decides with continue-on-error, and a fast run records no replayable tree', () => {
  const steps = jobs.changes.steps;
  const decide = steps.findIndex((s) => s.id === 'lane');
  const tree = steps.findIndex((s) => s.id === 'tree');
  assert.ok(decide >= 0 && decide < tree, 'the decision must precede the tree record');
  assert.equal(steps[decide]['continue-on-error'], true);
  assert.match(steps[decide].run, /node scripts\/ci-pr-lane\.mjs --decide/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  assert.match(steps[tree].if, /steps\.lane\.outputs\.lane != 'fast'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  assert.match(jobs.changes.outputs.lane, /steps\.lane\.outputs\.lane/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
});

test('WIRING: the aggregate verifies the lane before judging, and needs every listed job', () => {
  const steps = jobs.test.steps;
  const verifyAt = steps.findIndex((s) => typeof s.run === 'string' && s.run.includes('ci-pr-lane.mjs --verify')); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  const gateAt = steps.findIndex((s) => s.name === 'Gate on dependencies');
  assert.ok(verifyAt >= 0 && verifyAt < gateAt);
  assert.match(steps[verifyAt].if, /needs\.changes\.outputs\.lane == 'fast'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  assert.match(steps[verifyAt].env.NEEDS, /^\$\{\{ toJSON\(needs\) \}\}$/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  for (const j of [...FAST_SKIPPED_JOBS, ...Object.keys(FAST_REDUCED_JOBS)]) assert.ok(jobs.test.needs.includes(j), j); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
});

test('WIRING: viewer-e2e moves to the merge queue in fast mode, so it runs somewhere', () => {
  assert.match(jobs['viewer-e2e'].if, /github\.event_name == 'merge_group' && vars\.CI_PR_LANE == 'fast'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  const upload = jobs.build.steps.find((s) => s.name === 'Upload viewer app build');
  assert.match(upload.if, /github\.event_name == 'merge_group' && vars\.CI_PR_LANE == 'fast'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
});

// ---------------------------------------------------------------- PR review signal

/** The rollup a test.yml run publishes, with `skipped` jobs as GitHub publishes them. */
function rollup({ skip = [], drop = [] }) {
  const wf = readFileSync(TEST_YML, 'utf8');
  const exclude = new Set(JSON.parse(readFileSync(CONFIG, 'utf8')).excludeJobKeys ?? []);
  const aliases = matrixSkipAliases(wf, { exclude: [...exclude] });
  const lanes = [];
  for (const job of parseWorkflowJobs(wf)) {
    if (exclude.has(job.key) || drop.includes(job.key)) continue;
    const template = job.name ?? job.key;
    const expanded = [...aliases].filter(([, t]) => t === template).map(([n]) => n);
    if (skip.includes(job.key)) lanes.push({ name: template, state: 'skipped' });
    else for (const n of expanded.length > 0 ? expanded : [template]) lanes.push({ name: n, state: 'success' });
  }
  return lanes;
}

function gate(lanes) {
  const path = join(TMP, `state-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({ lanes, reviewChecks: [], reviews: [], headSha: '0'.repeat(40), headCommittedAt: '2026-10-31T00:00:00Z' }));
  const r = spawnSync(process.execPath, [GATE, '--state-file', path], { encoding: 'utf8' });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

test('REVIEW SIGNAL: a deliberate fast-lane run (skipped lanes published) passes', () => {
  const r = gate(rollup({ skip: FAST_SKIPPED_JOBS }));
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /All \d+ required lane\(s\) from test\.yml are present/); // @source-text-assertion-ok subject is the gate's printed verdict; the exit code is asserted above
});

test('REVIEW SIGNAL: the fast-lane jobs ABSENT rather than skipped still fail as MISSING_LANES', () => {
  const r = gate(rollup({ drop: FAST_SKIPPED_JOBS }));
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /MISSING_LANES/); // @source-text-assertion-ok subject is the gate's printed verdict; the exit code is asserted above
  assert.ok(r.output.includes('Viewer tests (shard 0)')); // @source-text-assertion-ok subject is the gate's printed verdict; the exit code is asserted above
});

test('REVIEW SIGNAL: a silent run (test.yml never fired) still fails', () => {
  const r = gate([{ name: 'Issue queue', state: 'success' }]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /NOT ONE lane from test\.yml appeared/); // @source-text-assertion-ok subject is the gate's printed verdict; the exit code is asserted above
});

test('a Mergify batch PR is the full gate: no switch or label can put it on the fast lane', () => {
  const headRef = 'mergify/merge-queue/abc123';
  for (const mode of [undefined, '', 'full', 'shadow', 'fast', 'FAST', 'garbled']) {
    for (const prLabels of ['[]', '["unqueued"]', 'not json']) {
      const d = decideLane({ event: 'pull_request', mode, labels: prLabels, headRef });
      assert.equal(d.lane, 'full', `mode=${mode} labels=${prLabels}`);
      assert.equal(d.wouldBeFast, false);
    }
  }
  assert.equal(decideLane({ event: 'pull_request', mode: 'fast', labels: '[]', headRef: 'fix/mergify/merge-queue/x' }).lane, 'fast', 'only the real prefix counts');
  assert.equal(decideLane({ event: 'pull_request', mode: 'fast', labels: '[]' }).lane, 'fast', 'an ordinary PR keeps the fast lane');
});

test('the aggregate rejects a fast lane on a batch PR', () => {
  const needs = JSON.stringify(Object.fromEntries([...FAST_SKIPPED_JOBS, ...Object.keys(FAST_REDUCED_JOBS)].map((j) => [j, { result: 'skipped' }])));
  const v = verifyLane({ event: 'pull_request', mode: 'fast', labels: '[]', headRef: 'mergify/merge-queue/abc', lane: 'fast', needs });
  assert.equal(v.ok, false);
  assert.match(v.lines.join('\n'), /UNJUSTIFIED_FAST_LANE/); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
});

test('test.yml hands the batch signal to the decision and to the queue-only lanes', () => {
  const wf = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'));
  const decide = wf.jobs.changes.steps.find((s) => s.id === 'lane');
  assert.equal(decide.env.HEAD_REF, '${{ github.head_ref }}');
  assert.match(wf.jobs.changes.outputs.batch, /steps\.lane\.outputs\.batch/); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
  for (const job of ['rust-full', 'geometry-census', 'csg-accept-gates']) {
    assert.match(wf.jobs[job].if, /needs\.changes\.outputs\.batch == 'true'/, job); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
  }
  const all = wf.jobs.changes.steps.find((s) => s.id === 'all');
  assert.match(all.if, /steps\.lane\.outputs\.batch == 'true'/, 'a batch declares every area changed'); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
  const filter = wf.jobs.changes.steps.find((s) => s.id === 'filter');
  assert.match(filter.if, /steps\.lane\.outputs\.batch != 'true'/, 'a batch does not narrow lanes by path'); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
});

test('Mergify cannot merge a batch unless full-lane jobs succeeded, and is label-scoped', () => {
  const cfg = parse(readFileSync(join(REPO_ROOT, '.mergify.yml'), 'utf8'));
  const rule = cfg.queue_rules[0];
  for (const check of ['Build + WASM + Rust + Node', 'Viewer tests (shard 0)', 'Rust tests (feature builds)']) {
    assert.ok(rule.merge_conditions.includes(`check-success=${check}`), check); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
  }
  assert.ok(rule.queue_conditions.includes('label=mergify-trial')); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
  const names = Object.values(parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8')).jobs).map((j) => j.name);
  assert.ok(names.includes('Rust tests (feature builds)'), 'the required job name exists'); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
  assert.ok(names.includes('Build + WASM + Rust + Node'), 'the required job name exists'); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
  assert.ok(names.some((n) => String(n).startsWith('Viewer tests (shard')), 'the required job name exists'); // @source-text-assertion-ok subject is the parsed config or the decision's returned text
});
