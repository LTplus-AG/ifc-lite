/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TREE_ARTIFACT_PREFIX, decidePushReplay } from './ci-push-replay.mjs';

const h = (c) => c.repeat(40);
const PUSH = h('a');
const TREE = h('b');
const BEFORE = h('c');
const HEAD = h('d');

function base(over = {}) {
  return {
    pushSha: PUSH,
    pushTree: TREE,
    parentSha: BEFORE,
    before: BEFORE,
    changedFiles: ['apps/viewer/src/x.ts'],
    pulls: [{ number: 7, merged_at: '2026-10-14T10:00:00Z', merge_commit_sha: PUSH, base: { ref: 'main' }, head: { sha: HEAD } }],
    runs: [
      { id: 1, head_sha: HEAD, event: 'pull_request', status: 'completed', conclusion: 'success', path: '.github/workflows/test.yml', created_at: '2026-10-14T09:00:00Z' },
    ],
    artifactNamesByRun: { 1: [`${TREE_ARTIFACT_PREFIX}${TREE}`, 'build-output'] },
    ...over,
  };
}

test('replays when a green run of the merged head tested exactly this tree', () => {
  assert.deepEqual(decidePushReplay(base()), { replay: true, runId: 1, pr: 7 });
});

test('main moved: the green run tested a different tree, so the push runs in full', () => {
  const d = decidePushReplay(base({ artifactNamesByRun: { 1: [`${TREE_ARTIFACT_PREFIX}${h('e')}`] } }));
  assert.equal(d.replay, false);
  assert.match(d.reason, /tested tree/);
});

test('a run that recorded no tree (or a no-op replay run) is never evidence', () => {
  assert.equal(decidePushReplay(base({ artifactNamesByRun: { 1: ['build-output'] } })).replay, false);
  assert.equal(decidePushReplay(base({ artifactNamesByRun: {} })).replay, false);
});

test('an admin merge over a red, cancelled or pending head runs in full', () => {
  for (const conclusion of ['failure', 'cancelled', null]) {
    const runs = [{ ...base().runs[0], conclusion, status: conclusion ? 'completed' : 'in_progress' }];
    assert.equal(decidePushReplay(base({ runs })).replay, false, String(conclusion));
  }
});

test('a green run of an EARLIER head of the PR does not count', () => {
  const runs = [{ ...base().runs[0], head_sha: h('f') }];
  assert.equal(decidePushReplay(base({ runs })).replay, false);
});

test('only pull_request runs of the Test workflow count', () => {
  assert.equal(decidePushReplay(base({ runs: [{ ...base().runs[0], event: 'push' }] })).replay, false);
  assert.equal(decidePushReplay(base({ runs: [{ ...base().runs[0], path: '.github/workflows/benchmark.yml' }] })).replay, false);
});

test('a multi-commit push, or one not on the previous tip, runs in full', () => {
  assert.equal(decidePushReplay(base({ parentSha: h('9') })).replay, false);
  assert.equal(decidePushReplay(base({ before: '0'.repeat(39) })).replay, false);
});

test('the commit must come from exactly one PR merged into main', () => {
  assert.equal(decidePushReplay(base({ pulls: [] })).replay, false);
  assert.equal(decidePushReplay(base({ pulls: [{ ...base().pulls[0], merged_at: null }] })).replay, false);
  assert.equal(decidePushReplay(base({ pulls: [{ ...base().pulls[0], base: { ref: 'release' } }] })).replay, false);
  assert.equal(decidePushReplay(base({ pulls: [{ ...base().pulls[0], merge_commit_sha: h('1') }] })).replay, false);
  const two = [base().pulls[0], { ...base().pulls[0], number: 8 }];
  assert.equal(decidePushReplay(base({ pulls: two })).replay, false);
});

test('changes that key main-only caches always get a full run', () => {
  for (const f of ['Cargo.lock', 'Cargo.toml', 'rust/core/Cargo.toml', 'rust-toolchain.toml', '.github/workflows/test.yml', '.github/actions/setup-wasm-build/action.yml']) {
    const d = decidePushReplay(base({ changedFiles: ['README.md', f] }));
    assert.equal(d.replay, false, f);
    assert.ok(d.reason.includes(f), d.reason);
  }
});

test('the newest matching green run is the one replayed', () => {
  const runs = [
    { ...base().runs[0], id: 1, created_at: '2026-10-14T08:00:00Z' },
    { ...base().runs[0], id: 2, created_at: '2026-10-14T09:00:00Z' },
  ];
  const names = [`${TREE_ARTIFACT_PREFIX}${TREE}`];
  assert.equal(decidePushReplay(base({ runs, artifactNamesByRun: { 1: names, 2: names } })).runId, 2);
});

test('malformed hashes refuse rather than guess', () => {
  assert.equal(decidePushReplay(base({ pushTree: 'abc' })).replay, false);
  assert.equal(decidePushReplay(base({ pushSha: '' })).replay, false);
});

// #7944: exercise the real CLI, Git input, gh subprocess and Actions outputs.
// A failed optimization must schedule tests, while verification still refuses.
test('unreadable replay evidence selects full validation only in probe mode', {
  skip: process.platform === 'win32' ? 'POSIX gh executable fixture requires a Unix shell environment' : false,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'push-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Replay fixture', '-c', 'user.email=replay@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(root, 'model.txt'), 'before');
  git('add', 'model.txt');
  git('commit', '-qm', 'before');
  const before = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'model.txt'), 'after');
  git('commit', '-qam', 'after');
  const head = git('rev-parse', 'HEAD');
  const script = fileURLToPath(new URL('./ci-push-replay.mjs', import.meta.url));
  const output = join(root, 'output');
  const gh = join(bin, 'gh');
  const env = {
    ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
    GITHUB_REPOSITORY: 'fixture/replay', GITHUB_SHA: head,
    PUSH_BEFORE: before, GITHUB_OUTPUT: output,
  };
  const apiResponse = (pulls, workflow_runs = [], artifacts = []) => `
    const path = process.argv[3];
    const response = path.includes('/commits/') ? ${JSON.stringify(pulls)}
      : path.includes('/artifacts?') ? ${JSON.stringify({ artifacts })}
      : ${JSON.stringify({ workflow_runs })};
    process.stdout.write(JSON.stringify(response));
  `;
  const merged = { ...base().pulls[0], merge_commit_sha: head };
  for (const [failure, response] of [
    ['GH_ERROR', 'console.error("unexpected end of JSON input"); process.exitCode = 1;'],
    ['GH_BAD_JSON', 'process.stdout.write("{");'],
    ['GH_BAD_SHAPE', 'process.stdout.write("{}");'],
    // #7944 review: nested records must not escape as unclassified TypeErrors.
    ...[undefined, {}, { sha: 42 }, { sha: 'short' }].map((head) => [
      'GH_BAD_SHAPE', apiResponse([{ ...merged, head }]),
    ]),
    ...[null, {}, { id: 'not-a-run-id' }].map((run) => [
      'GH_BAD_SHAPE', apiResponse([merged], [run]),
    ]),
    ...[null, {}, { name: 42, expired: false }].map((artifact) => [
      'GH_BAD_SHAPE', apiResponse([merged], [{ id: 1 }], [artifact]),
    ]),
  ]) {
    writeFileSync(gh, `#!/usr/bin/env node\n${response}\n`);
    chmodSync(gh, 0o755);
    writeFileSync(output, '');
    const probe = spawnSync(process.execPath, [script, '--probe'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stderr, new RegExp(failure));
    assert.equal(readFileSync(output, 'utf8'), 'replay=false\nreplay_run=\n');
    assert.match(probe.stdout, /full validation is required/);

    writeFileSync(output, '');
    const verify = spawnSync(process.execPath, [script, '--verify', '--run', '1'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(verify.status, 1, failure);
    assert.match(verify.stderr, new RegExp(failure));
    assert.equal(readFileSync(output, 'utf8'), '', 'verification must not publish replay success');
  }
  const invalidSource = spawnSync(process.execPath, [script, '--probe'], {
    cwd: root, env: { ...env, GITHUB_SHA: 'missing-source-7944' }, encoding: 'utf8',
  });
  assert.equal(invalidSource.status, 1, 'invalid Git input must still fail');
  assert.equal(readFileSync(output, 'utf8'), '');
});
