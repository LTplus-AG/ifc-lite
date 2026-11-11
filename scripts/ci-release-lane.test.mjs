/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The release PR lean lane: the decision, the diff rule, the Mergify route
 * check, the aggregate's re-derivation, the CLI against a real git repo, and
 * the test.yml wiring.
 *
 * Run: node --test scripts/ci-release-lane.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  LEAN_KEPT_JOBS,
  QUEUE_FULL_CHECKS,
  RELEASE_HEAD_REF,
  decideReleaseLane,
  diffProblems,
  parseQueueRules,
  releaseQueueRoute,
  verifyReleaseLane,
} from './ci-release-lane.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI = join(HERE, 'ci-release-lane.mjs');
const MERGIFY = readFileSync(join(REPO_ROOT, '.mergify.yml'), 'utf8');
const WORKFLOW = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8'));
const jobs = WORKFLOW.jobs;

const TMP = mkdtempSync(join(tmpdir(), 'ci-release-lane-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const BASE = {
  event: 'pull_request',
  mode: 'on',
  headRef: RELEASE_HEAD_REF,
  headRepo: 'o/r',
  repo: 'o/r',
  baseRef: 'main',
  mergify: () => MERGIFY,
  diff: () => [],
};
const decide = (over = {}) => decideReleaseLane({ ...BASE, ...over });

function needsJson(result = 'success', overrides = {}) {
  const out = {};
  for (const j of jobs.test.needs) out[j] = { result: overrides[j] ?? result, outputs: {} };
  return JSON.stringify(out);
}

// ---------------------------------------------------------------- the decision

test('unset and `off` are today\'s behaviour, and so is any unknown value', () => {
  for (const mode of [undefined, '', 'off', 'OFF']) assert.equal(decide({ mode }).lane, 'full', String(mode));
  for (const mode of ['true', 'lean', ' on', 'on ', 'fast']) {
    const d = decide({ mode });
    assert.equal(d.lane, 'full', JSON.stringify(mode));
    assert.equal(d.wouldBeLean, false);
    assert.match(d.warning ?? '', /not one of off, shadow, on/); // @source-text-assertion-ok subject is the decision's returned message
  }
});

test('`on` gives the release PR the lean lane; `shadow` runs full and records it', () => {
  assert.equal(decide().lane, 'lean');
  assert.equal(decide({ mode: 'On' }).lane, 'lean', 'case-insensitive like Actions `==`');
  const s = decide({ mode: 'shadow' });
  assert.equal(s.lane, 'full');
  assert.equal(s.wouldBeLean, true);
});

test('REFUSE: only a same-repo pull_request from changeset-release/main into main', () => {
  const cases = [
    { headRef: 'changeset-release/main-2' },
    { headRef: 'feature/changeset-release/main' },
    { headRef: undefined },
    { headRepo: 'fork/r' },
    { headRepo: undefined },
    { repo: undefined, headRepo: undefined },
    { baseRef: 'release/1.x' },
    { event: 'merge_group' },
    { event: 'push' },
    { event: 'pull_request_target' },
    { event: undefined },
  ];
  for (const c of cases) {
    for (const mode of ['on', 'shadow']) {
      const d = decide({ ...c, mode });
      assert.equal(d.lane, 'full', JSON.stringify(c));
      assert.equal(d.wouldBeLean, false, JSON.stringify(c));
    }
  }
});

test('REFUSE: no full-gate Mergify route for the release PR means this run is the gate', () => {
  const noRoute = MERGIFY.replace(/- head=changeset-release\/main\n/g, '- head=other\n');
  assert.equal(decide({ mergify: () => noRoute }).lane, 'full');
  for (const check of QUEUE_FULL_CHECKS) {
    const weak = MERGIFY.replace(new RegExp(`\\n\\s+- ${check.replace(/[+()]/g, '\\$&')}`, 'g'), '');
    const d = decide({ mergify: () => weak });
    assert.equal(d.lane, 'full', check);
    assert.ok(d.warning, 'a refused route is announced');
  }
  assert.equal(decide({ mergify: () => { throw new Error('ENOENT'); } }).lane, 'full');
  assert.equal(decide({ mergify: () => '' }).lane, 'full');
});

test('REFUSE: a diff that moves more than versions, or cannot be read, runs full', () => {
  assert.equal(decide({ diff: () => ['src/x.ts: not a release file'] }).lane, 'full');
  assert.equal(decide({ diff: () => { throw new Error('bad revision HEAD~1'); } }).lane, 'full');
  assert.equal(decide({ mode: 'shadow', diff: () => ['x'] }).wouldBeLean, false);
});

test('the inputs are read only when the cheap checks pass (no git on an ordinary PR)', () => {
  const boom = () => { throw new Error('must not be read'); };
  for (const over of [{ mode: 'off' }, { headRef: 'feature' }, { event: 'push' }]) {
    assert.equal(decide({ ...over, mergify: boom, diff: boom }).lane, 'full');
  }
});

// ---------------------------------------------------------------- Mergify

test('the narrow queue-rule reader agrees with a YAML parse of the real .mergify.yml', () => {
  const real = parse(MERGIFY).queue_rules.map((r) => ({ name: r.name, queue: r.queue_conditions ?? [], merge: r.merge_conditions ?? [] }));
  assert.deepEqual(parseQueueRules(MERGIFY), real);
  const route = releaseQueueRoute(MERGIFY);
  assert.equal(route.ok, true, route.reason);
});

test('the release queue really tests a batch: its required `Rust tests (feature builds)` runs on a PR only for a batch', () => {
  // A lean run of the release PR itself can never satisfy the queue, because
  // that lane does not run on an ordinary pull_request. That is what makes
  // the queue's batch, not this run, the gate (#8727 tested #8665).
  assert.match(jobs['rust-full'].if, /github\.event_name != 'pull_request' \|\| needs\.changes\.outputs\.batch == 'true'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  assert.ok(QUEUE_FULL_CHECKS.includes('check-success=Rust tests (feature builds)'));
});

// ---------------------------------------------------------------- the diff rule

function fakeGit(files) {
  return {
    show: (rev, path) => {
      const f = files[path];
      const v = rev === 'HEAD' ? f.after : f.before;
      if (v === undefined) throw new Error(`no ${rev}:${path}`);
      return v;
    },
    diff: (path) => files[path].diff,
  };
}
const pkg = (version, extra = {}) => JSON.stringify({ name: '@ifc-lite/x', version, dependencies: { '@ifc-lite/core': 'workspace:*', lodash: '^4.0.0' }, ...extra });

test('DIFF: a real release shape passes', () => {
  const files = {
    'packages/x/package.json': { before: pkg('1.0.0'), after: pkg('1.1.0') },
    'packages/new/package.json': { after: pkg('0.1.0') },
    'rust/core/Cargo.toml': { diff: '@@ -3 +3 @@\n-version = "2.0.0"\n+version = "2.1.0"\n' },
    'Cargo.lock': { diff: '@@ -10 +10 @@\n-version = "2.0.0"\n+version = "2.1.0"\n@@ -40 +40 @@\n- ifc-lite-core = { version = "=2.0.0", path = "x" }\n+ ifc-lite-core = { version = "=2.1.0", path = "x" }\n' },
  };
  const entries = [
    { status: 'D', path: '.changeset/brave-owls-sing.md' },
    { status: 'M', path: 'packages/x/CHANGELOG.md' },
    { status: 'A', path: 'packages/new/CHANGELOG.md' },
    { status: 'M', path: 'packages/x/package.json' },
    { status: 'M', path: 'rust/core/Cargo.toml' },
    { status: 'M', path: 'Cargo.lock' },
  ];
  assert.deepEqual(diffProblems(entries, fakeGit(files)), []);
});

test('DIFF: everything that is not a version bump is named', () => {
  const files = {
    'a/package.json': { before: pkg('1.0.0'), after: pkg('1.0.0', { exports: { '.': './dist/index.js' } }) },
    'b/package.json': { before: pkg('1.0.0'), after: JSON.stringify({ ...JSON.parse(pkg('1.0.0')), dependencies: { '@ifc-lite/core': 'workspace:*', lodash: '^4.1.0' } }) },
    'c/package.json': { before: pkg('1.0.0'), after: JSON.stringify({ ...JSON.parse(pkg('1.0.0')), dependencies: { '@ifc-lite/core': 'file:../x', lodash: '^4.0.0' } }) },
    'd/package.json': { before: '{', after: '{}' },
    'Cargo.toml': { diff: '@@ -9 +9 @@\n-serde = "1.0.1"\n+serde = "1.0.2"\n' },
    'Cargo.lock': { diff: '@@ -9,2 +9,2 @@\n-version = "1.0.1"\n-checksum = "aa"\n+version = "1.0.2"\n+checksum = "bb"\n' },
    'rust/x/Cargo.toml': { diff: '@@ -9,0 +10 @@\n+features = ["x"]\n' },
    'rust/y/Cargo.toml': { diff: '@@ -4 +4 @@\n-rust-version = "1.75"\n+rust-version = "1.85"\n' },
    'rust/z/Cargo.toml': { diff: '@@ -9 +9 @@\n-serde = { version = "1.0.1", features = ["derive"] }\n+serde = { version = "2.0.0", features = ["derive"] }\n' },
  };
  const entries = [
    { status: 'A', path: '.changeset/new.md' },
    { status: 'M', path: '.changeset/config.json' },
    { status: 'M', path: 'scripts/rust-major-offset.mjs' },
    { status: 'D', path: 'packages/x/CHANGELOG.md' },
    { status: 'A', path: 'packages/y/package.json' },
    ...['a', 'b', 'c', 'd'].map((p) => ({ status: 'M', path: `${p}/package.json` })),
    { status: 'M', path: 'Cargo.toml' },
    { status: 'M', path: 'Cargo.lock' },
    { status: 'M', path: 'rust/x/Cargo.toml' },
    { status: 'M', path: 'rust/y/Cargo.toml' },
    { status: 'M', path: 'rust/z/Cargo.toml' },
    { status: 'A', path: 'docs/CHANGELOG.md' },
  ];
  const problems = diffProblems(entries, fakeGit(files));
  assert.equal(problems.length, entries.length, problems.join('\n'));
  assert.deepEqual(diffProblems([], fakeGit({})), ['the diff is empty or unreadable']);
});

// ---------------------------------------------------------------- the aggregate's check

const verify = (over = {}) => verifyReleaseLane({ ...BASE, lane: 'lean', needs: needsJson('skipped', Object.fromEntries(LEAN_KEPT_JOBS.map((j) => [j, 'success']))), ...over });

test('VERIFY: a justified lean run passes and names what it skipped', () => {
  const v = verify();
  assert.equal(v.ok, true, v.lines.join('\n'));
  assert.ok(v.lines.some((l) => l.includes('`viewer-tests`'))); // @source-text-assertion-ok subject is the returned summary
});

test('VERIFY: a lean run the inputs do not justify fails', () => {
  for (const c of [{ mode: 'off' }, { mode: 'shadow' }, { headRepo: 'fork/r' }, { event: 'merge_group' }, { headRef: 'feature' }, { diff: () => ['x: not a release file'] }, { mergify: () => '' }]) {
    const v = verify(c);
    assert.equal(v.ok, false, JSON.stringify(c));
    assert.match(v.lines.join('\n'), /UNJUSTIFIED_RELEASE_LANE/); // @source-text-assertion-ok subject is the returned verdict
  }
});

test('VERIFY: a lean run whose kept jobs did not all succeed fails, since skipped passes the map', () => {
  for (const [job, r] of [['release-pr', 'skipped'], ['release-pr', 'failure'], ['release-pr', 'cancelled'], ['rust-semver', 'skipped'], ['silent-revert', 'skipped']]) {
    const v = verify({ needs: needsJson('skipped', { ...Object.fromEntries(LEAN_KEPT_JOBS.map((j) => [j, 'success'])), [job]: r }) });
    assert.equal(v.ok, false, `${job}=${r}`);
    assert.match(v.lines.join('\n'), /RELEASE_CHECKS_DID_NOT_PASS/); // @source-text-assertion-ok subject is the returned verdict
  }
});

test('VERIFY: shadow reports, and flags a failure the lean lane would have deferred', () => {
  const clean = verify({ mode: 'shadow', lane: 'full', needs: needsJson() });
  assert.equal(clean.ok, true);
  assert.match(clean.lines.join('\n'), /would have reached the same verdict/); // @source-text-assertion-ok subject is the returned summary
  const missed = verify({ mode: 'shadow', lane: 'full', needs: needsJson('success', { 'viewer-tests': 'failure', 'rust-semver': 'failure' }) });
  assert.equal(missed.ok, true, 'shadow reports; the map judges the failure');
  assert.match(missed.lines.join('\n'), /deferred a failure to the merge queue: viewer-tests\.$/); // @source-text-assertion-ok kept lanes are not listed as deferred
});

test('VERIFY: a full run passes; a missing decision is reported; bad NEEDS and stale job lists fail', () => {
  assert.equal(verify({ lane: 'full', needs: needsJson() }).ok, true);
  assert.match(verify({ lane: '', needs: needsJson() }).lines.join('\n'), /decision step failed or is missing/); // @source-text-assertion-ok subject is the returned summary
  assert.equal(verify({ needs: 'nope' }).ok, false);
  const stale = JSON.parse(needsJson());
  delete stale['release-pr'];
  assert.equal(verify({ needs: JSON.stringify(stale) }).ok, false);
});

// ---------------------------------------------------------------- the CLI on a real repo

function repo(change) {
  const dir = mkdtempSync(join(TMP, 'repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, '.mergify.yml'), MERGIFY);
  mkdirSync(join(dir, 'packages/x'), { recursive: true });
  mkdirSync(join(dir, '.changeset'));
  writeFileSync(join(dir, 'packages/x/package.json'), `${pkg('1.0.0')}\n`);
  writeFileSync(join(dir, 'packages/x/CHANGELOG.md'), '# x\n');
  writeFileSync(join(dir, '.changeset/brave-owls.md'), '---\n"@ifc-lite/x": minor\n---\n\nx\n');
  writeFileSync(join(dir, 'src.ts'), 'export {};\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
  change(dir);
  g('add', '-A');
  g('commit', '-qm', 'head');
  return dir;
}

const versionBump = (dir) => {
  writeFileSync(join(dir, 'packages/x/package.json'), `${pkg('1.1.0')}\n`);
  writeFileSync(join(dir, 'packages/x/CHANGELOG.md'), '# x\n\n## 1.1.0\n');
  unlinkSync(join(dir, '.changeset/brave-owls.md'));
};

function cli(args, env, cwd) {
  const out = join(TMP, `out-${Math.random().toString(36).slice(2)}`);
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_EVENT_NAME: 'pull_request', CI_RELEASE_LANE: 'on', HEAD_REF: RELEASE_HEAD_REF, HEAD_REPO: 'o/r', REPO: 'o/r', BASE_REF: 'main', ...env },
  });
  const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
}

test('CLI --decide on a real version-bump commit is lean; one more source file makes it full', () => {
  const lean = cli(['--decide'], {}, repo(versionBump));
  assert.equal(lean.code, 0, lean.stderr);
  assert.deepEqual(lean.outputs, { lane: 'lean', checks: 'true' });
  const mixed = cli(['--decide'], {}, repo((d) => { versionBump(d); writeFileSync(join(d, 'src.ts'), 'export const x = 1;\n'); }));
  assert.deepEqual(mixed.outputs, { lane: 'full', checks: 'false' });
  assert.match(mixed.stdout, /src\.ts: not a release file/); // @source-text-assertion-ok subject is the CLI's printed reason
  const off = cli(['--decide'], { CI_RELEASE_LANE: '' }, repo(versionBump));
  assert.deepEqual(off.outputs, { lane: 'full', checks: 'false' });
});

test('CLI FAIL CLOSED: no GITHUB_OUTPUT writes nothing and exits 1; --verify exits 1 on an unjustified lean', () => {
  const dir = repo(versionBump);
  assert.equal(cli(['--decide'], { GITHUB_OUTPUT: '' }, dir).code, 1);
  assert.equal(cli([], {}, dir).code, 1);
  const needs = needsJson('skipped', Object.fromEntries(LEAN_KEPT_JOBS.map((j) => [j, 'success'])));
  assert.equal(cli(['--verify'], { LANE: 'lean', NEEDS: needs }, dir).code, 0);
  assert.equal(cli(['--verify'], { LANE: 'lean', NEEDS: needs, HEAD_REPO: 'fork/r' }, dir).code, 1);
});

// ---------------------------------------------------------------- the wiring

test('WIRING: `changes` decides with continue-on-error and withholds only on the exact `lean`', () => {
  const steps = jobs.changes.steps;
  const at = steps.findIndex((s) => s.id === 'release');
  const step = steps[at];
  assert.equal(step['continue-on-error'], true);
  assert.equal(step.run, 'node scripts/ci-release-lane.mjs --decide');
  for (const id of ['filter', 'tree']) {
    const s = steps.findIndex((x) => x.id === id);
    assert.ok(at < s, `the decision precedes ${id}`);
    assert.match(steps[s].if, /steps\.release\.outputs\.lane != 'lean'/, id); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  }
  assert.match(jobs.changes.outputs.release_lane, /steps\.release\.outputs\.lane \|\| 'full'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  for (const [key, job] of Object.entries(jobs)) {
    assert.ok(!/release_lane\s*==\s*'full'/.test(String(job.if ?? '')), `${key} must never gate on release_lane == 'full'`); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  }
});

test('WIRING: every job a lean run keeps is outside the path filter; every other lane is behind it', () => {
  // `changes` withholds its filter outputs, so a lane runs in a lean run only
  // if its `if` does not need one. Pin that the kept set is exactly that set.
  const filterKeys = Object.keys(jobs.changes.outputs).filter((k) => !['noop', 'replay', 'replay_run', 'replay_queue', 'lane', 'batch', 'release_lane', 'release_checks', 'wasm_prebuilt'].includes(k)); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  const pathGated = (job) => filterKeys.some((k) => new RegExp(`needs\\.changes\\.outputs\\.${k} == 'true'`).test(String(job.if ?? ''))); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  for (const j of jobs.test.needs) {
    const job = jobs[j];
    const viaDeps = (job.needs ?? []).some?.((n) => n !== 'changes' && jobs[n] && pathGated(jobs[n]));
    const leanSkips = pathGated(job) || viaDeps || /github\.event_name != 'pull_request'/.test(String(job.if ?? '')) || j === 'release-pr'; // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
    if (LEAN_KEPT_JOBS.includes(j)) assert.ok(j === 'release-pr' || !pathGated(job), `${j} is kept but path-gated`);
    else assert.ok(leanSkips, `${j} would still run in a lean run; add it to LEAN_KEPT_JOBS or gate it`);
  }
});

test('WIRING: release-pr runs the release checks and is judged by the aggregate', () => {
  const job = jobs['release-pr'];
  assert.match(job.if, /needs\.changes\.outputs\.release_checks == 'true'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  const runs = job.steps.map((s) => s.run).filter(Boolean);
  for (const s of ['check-changesets.mjs', 'check-changeset-bump.mjs', 'check-rust-major-offset.mjs', 'check-package-readmes.mjs']) {
    assert.ok(runs.some((r) => r.includes(s)), s); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  }
  assert.ok(jobs.test.needs.includes('release-pr')); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  const verifyStep = jobs.test.steps.find((s) => s.run === 'node scripts/ci-release-lane.mjs --verify');
  const gateAt = jobs.test.steps.findIndex((s) => s.name === 'Gate on dependencies');
  assert.ok(jobs.test.steps.indexOf(verifyStep) < gateAt); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  assert.match(verifyStep.if, /needs\.changes\.outputs\.release_lane == 'lean'/); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML
  const checkout = jobs.test.steps[jobs.test.steps.indexOf(verifyStep) - 1];
  assert.equal(checkout.with['fetch-depth'], 2, 'verify re-reads HEAD~1');
  assert.equal(checkout.if, verifyStep.if);
});
