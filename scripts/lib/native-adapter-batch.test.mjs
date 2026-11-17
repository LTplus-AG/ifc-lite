/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The merge-queue batch decision (native-adapter-batch.mjs), driven through the
// real `--batch-decide` CLI and the guard's audit, so a revert of either goes red
// rather than failing to load.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { audit } from '../check-native-adapter-triggers.mjs';

const REPO = join(import.meta.dirname, '../..');
const WORKFLOW = '.github/workflows/geometry-platform.yml';

const CLI = join(REPO, 'scripts/check-native-adapter-triggers.mjs');
// A hook's GIT_DIR or GIT_INDEX_FILE would point git -C at the real repository.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/**
 * A repository whose HEAD is the PR merge commit of a branch that adds `add`, appends a line to `touch` and
 * git-mv's `move` ([old, new] pairs) over a base holding `workflow` and the repo's own `copy` files; `merge: false` makes it a squash.
 */
function batchRepo(context, { add = [], touch = [], move = [], merge = true, workflow = readFileSync(join(REPO, WORKFLOW), 'utf8'), copy = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-adapter-batch-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  const write = (rel, body) => {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  git('init', '-q', '-b', 'main');
  write(WORKFLOW, workflow);
  for (const rel of copy) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    cpSync(join(REPO, rel), join(root, rel));
  }
  write('README.md', 'base\n');
  for (const [from] of move) write(from, 'moved\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'mergify/merge-queue/batch');
  for (const f of add) write(f, 'changed\n');
  for (const rel of touch) appendFileSync(join(root, rel), '\n');
  for (const [from, to] of move) {
    mkdirSync(join(root, dirname(to)), { recursive: true });
    git('mv', from, to);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'batch');
  git('checkout', '-q', 'main');
  // main moves on, as it does under a batch, so the merge is a real two-parent commit.
  write('README.md', 'main moved\n');
  git('commit', '-q', '-am', 'main');
  if (merge) git('merge', '-q', '--no-ff', '--no-edit', 'mergify/merge-queue/batch');
  else {
    git('merge', '-q', '--squash', 'mergify/merge-queue/batch');
    git('commit', '-q', '-m', 'squash');
  }
  return root;
}

function decide(root, { output = true } = {}) {
  const out = join(root, '.gh-output');
  const env = cleanEnv();
  if (output) env.GITHUB_OUTPUT = out;
  else delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [CLI, '--batch-decide', '--root', root], { encoding: 'utf8', env });
  const written = existsSync(out) ? readFileSync(out, 'utf8') : '';
  return { status: r.status, log: r.stdout + r.stderr, written };
}

// #10595's own diff. A CLI test and tests/models/manifest.json are in the
// labelled-PR paths, and once sent this batch through the hour-long lane.
const PR_10595 = [
  '.github/workflows/test.yml',
  'docs/architecture/structural-coverage-ledger.md',
  'packages/cli/src/structural-command.test.ts',
  'packages/export/src/schema-converter-structural-carriers.test.ts',
  'packages/export/src/schema-converter-structural-varying.test.ts',
  'packages/parser/src/structural-consistency.test.ts',
  'scripts/fixtures/generate-structural-edge-curve.py',
  'scripts/generate-structural-coverage-ledger.mjs',
  'scripts/generate-structural-coverage-ledger.test.mjs',
  'tests/models/manifest.json',
  'tests/structural-coverage/README.md',
  'tests/structural-coverage/baseline/r12-notes.md',
  'tests/structural-coverage/baseline/r12.json',
  'tests/structural-coverage/lib/values.mjs',
  'tests/structural-coverage/limits.mjs',
  'tests/structural-coverage/probes/convert.mjs',
  'tests/structural-coverage/probes/render.mjs',
  'tests/structural-coverage/score.mjs',
];

test('a batch touching the native/retained engine runs the lane', (context) => {
  for (const file of ['rust/geometry/src/lib.rs', 'rust/retained-native/src/lib.rs', 'rust/wasm-bindings/src/lib.rs', 'rust/processing/src/processor/x.rs', 'rust/processing/src/retained_geometry.rs', 'packages/cli/src/retained/run.ts', 'packages/cli/src/commands/export-retained.ts', 'packages/cli/src/RetainedRunner.ts', 'rust/processing/src/retained/mod.rs', 'packages/cli/src/RetainedEngine/run.ts', 'native/smlib-adapter/x.cpp', 'Cargo.lock', WORKFLOW, 'scripts/check-native-adapter-triggers.mjs']) {
    const d = decide(batchRepo(context, { add: [file, 'docs/guide/x.md'] }));
    assert.equal(d.status, 0, d.log);
    assert.equal(d.written, 'native_adapter=true\n', `${file}: ${d.log}`);
  }
});

test('#10595, and other changes outside the engine, skip the lane', (context) => {
  for (const add of [
    PR_10595,
    ['docs/guide/x.md', 'tests/perf-ratchets/viewer.json', '.changeset/a.md', 'AGENTS.md', 'scripts/ci-pr-lane.mjs'],
    // In the labelled-PR paths, but not the engine.
    ['packages/cli/src/index.ts', 'packages/geometry/src/x.ts', 'packages/wasm/pkg/ifc-lite.d.ts', 'package.json', 'pnpm-workspace.yaml', 'rust/core/src/lib.rs', 'rust/processing/src/style/mod.rs', 'apps/viewer/src/components/viewer/Viewport.tsx'],
  ]) {
    const d = decide(batchRepo(context, { add }));
    assert.equal(d.status, 0, d.log);
    assert.equal(d.written, 'native_adapter=false\n', `${add[0]}: ${d.log}`);
  }
});

test('an exclusion the paths list does not hold is reported', () => {
  assert.ok(audit(REPO, ['not-in-the-list/**']).some((f) => f.includes("BATCH_EXCLUDE entry 'not-in-the-list/**'")));
});

test('a lane-run script added to BATCH_EXCLUDE is reported', () => {
  assert.ok(audit(REPO, ['scripts/fixtures/*.mjs']).some((f) => f.includes('BATCH_EXCLUDE drops it from merge-queue batches')));
});

test('excluding the engine core from batches is reported', () => {
  for (const glob of ['rust/retained-native/**', 'rust/geometry-runtime/**', 'native/**', 'Cargo.lock', '.github/actions/setup-wasm-build/**']) {
    assert.ok(audit(REPO, [glob]).some((f) => f.includes(`BATCH_EXCLUDE drops ${glob}`)), glob);
  }
});

// CodeRabbit on #10629: a keep entry narrower than the exclusion matched the old probe path and passed.
test('a keep entry narrower than an excluded engine directory does not count as covering it', () => {
  for (const keep of ['rust/geometry/x/x', 'rust/geometry/src/**', 'rust/geometry/**/*retained*']) {
    assert.ok(audit(REPO, ['rust/geometry/**'], [keep]).some((f) => f.includes('BATCH_EXCLUDE drops rust/geometry/**')), keep);
  }
});

test('a script the lane runs under node --test cannot be excluded from batches', () => {
  assert.ok(audit(REPO, ['scripts/cli-retained-engine/**']).some((f) => f.includes('BATCH_EXCLUDE drops it from merge-queue batches')));
});

test('a BATCH_KEEP glob outside the paths list is reported', () => {
  assert.ok(audit(REPO, [], ['apps/other/**/*retained*']).some((f) => f.includes("BATCH_KEEP entry 'apps/other/**/*retained*'")));
});

test('a batch that edits what the decision reads runs the lane, whatever the edit says', (context) => {
  // Every list here watches only zzz/**, so nothing but the guard can answer true.
  const narrow = "on:\n  pull_request:\n    paths:\n      - 'zzz/**'\n";
  const copy = ['scripts/check-native-adapter-triggers.mjs', 'scripts/lib/native-adapter-batch.mjs', 'scripts/lib/ci-path-coverage.mjs'];
  for (const file of [WORKFLOW, ...copy]) {
    const d = decide(batchRepo(context, { workflow: narrow, copy, touch: [file] }));
    assert.equal(d.written, 'native_adapter=true\n', `${file}: ${d.log}`);
  }
  const control = decide(batchRepo(context, { workflow: narrow, copy, add: ['docs/x.md'] }));
  assert.equal(control.written, 'native_adapter=false\n', control.log);
});

test('a path new to the workflow runs the lane until it is excluded', (context) => {
  const d = decide(batchRepo(context, { add: ['brand-new/x.rs'], workflow: "on:\n  pull_request:\n    paths:\n      - 'brand-new/**'\n" }));
  assert.equal(d.written, 'native_adapter=true\n', d.log);
});

test('a file moved out of a watched directory counts by its old path', (context) => {
  const d = decide(batchRepo(context, { move: [['rust/geometry/src/old.rs', 'docs/old.rs']] }));
  assert.equal(d.written, 'native_adapter=true\n', d.log);
});

test('every doubt runs the lane: no merge commit, an unreadable or missing paths list', (context) => {
  const squash = decide(batchRepo(context, { add: ['docs/guide/x.md'], merge: false }));
  assert.equal(squash.written, 'native_adapter=true\n', squash.log);
  const inline = decide(batchRepo(context, { add: ['docs/guide/x.md'], workflow: "on:\n  pull_request:\n    paths:\n      - docs/**\n" }));
  assert.equal(inline.written, 'native_adapter=true\n', inline.log);
  const none = decide(batchRepo(context, { add: ['docs/guide/x.md'], workflow: 'on:\n  schedule:\n    - cron: x\n' }));
  assert.equal(none.written, 'native_adapter=true\n', none.log);
});

test('a checkout git cannot diff runs the lane', (context) => {
  const notGit = mkdtempSync(join(tmpdir(), 'native-adapter-nogit-'));
  context.after(() => rmSync(notGit, { recursive: true, force: true }));
  mkdirSync(join(notGit, dirname(WORKFLOW)), { recursive: true });
  cpSync(join(REPO, WORKFLOW), join(notGit, WORKFLOW));
  const d = decide(notGit);
  assert.equal(d.written, 'native_adapter=true\n', d.log);
});

test('no GITHUB_OUTPUT fails the step, so test.yml reads an absent answer and runs the lane', (context) => {
  const d = decide(batchRepo(context, { add: ['docs/guide/x.md'] }), { output: false });
  assert.equal(d.status, 1, d.log);
  assert.equal(d.written, '');
});
