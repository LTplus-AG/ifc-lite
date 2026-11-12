/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  for (const f of ['Cargo.lock', 'Cargo.toml', 'rust/core/Cargo.toml', 'rust-toolchain.toml', '.github/workflows/test.yml', '.github/actions/setup-wasm-build/action.yml', 'scripts/ci-cache-keying-files.txt']) {
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
const REPO = 'fixture/replay';
const batchRun = (over = {}) => ({
  id: 9, event: 'pull_request', status: 'completed', conclusion: 'success',
  path: '.github/workflows/test.yml', head_branch: 'mergify/merge-queue/abc123',
  head_repository: { full_name: REPO }, created_at: '2026-11-01T03:45:00Z', ...over,
});
// A fast PR run: green, but it recorded no tree, so only the queue can prove the push.
const queued = (queueEvidence, over = {}) => base({ artifactNamesByRun: { 1: ['build-output'] }, repo: REPO, queueEvidence, ...over });

// A scripts/ci-cache-keying-files.txt: test.yml plus one action directory.
const LIST = ['.github/workflows/test.yml', '.github/actions/setup-wasm-build/'];

test('with the keying list read, listed files, the list and Cargo still get a full run', () => {
  for (const f of ['Cargo.lock', 'rust/python/Cargo.lock', 'rust-toolchain', 'rust/foo/rust-toolchain.toml', '.cargo/config.toml', 'rust/python/.cargo/config', 'scripts/ci-cache-keying-files.txt', '.github/workflows/test.yml', '.github/actions/setup-wasm-build/action.yml', '.github/actions/setup-wasm-build/helper.mjs']) {
    const d = decidePushReplay(base({ changedFiles: ['README.md', f], keyingList: LIST }));
    assert.equal(d.replay, false, f);
    assert.ok(d.reason.includes(f), d.reason);
  }
});

test('a workflow or action file not on the list does not block a replay', () => {
  for (const f of ['.github/workflows/cla.yml', '.github/workflows/python-wheels.yaml', '.github/actions/setup-oci-registries/action.yml', '.github/actions/setup-wasm-buildx/action.yml']) {
    assert.deepEqual(decidePushReplay(base({ changedFiles: [f], keyingList: LIST })), { replay: true, runId: 1, pr: 7 }, f);
  }
  const evidence = [{ tree: TREE, runs: [] }, { tree: h('e'), runs: [batchRun()] }];
  assert.deepEqual(
    decidePushReplay(queued(evidence, { changedFiles: ['.github/workflows/python-wheels.yml'], keyingList: LIST })),
    { replay: true, runId: 9, pr: 7, queue: true },
    'an earlier batch commit',
  );
});

test('a missing, empty or unreadable list blocks every workflow and action file', () => {
  assert.equal(decidePushReplay(base({ changedFiles: ['.github/workflows/test.yml'], keyingList: ['x'] })).replay, false, 'test.yml blocks whatever the list says');
  for (const keyingList of [undefined, null, [], ['.github/actions/setup-wasm-build/']]) {
    for (const f of ['.github/workflows/cla.yml', '.github/actions/setup-oci-registries/action.yml']) {
      assert.equal(decidePushReplay(base({ changedFiles: [f], keyingList })).replay, false, `${f} with ${JSON.stringify(keyingList)}`);
    }
  }
});

test('a non-YAML file under workflows/ blocks even with the list read', () => {
  for (const f of ['.github/workflows/scripts/key.mjs', '.github/workflows/README.md', '.github/workflows/sub/x.yml', '.github/workflows/test.yml.bak']) {
    const d = decidePushReplay(base({ changedFiles: [f], keyingList: LIST }));
    assert.equal(d.replay, false, f);
    assert.ok(d.reason.includes(f), d.reason);
  }
});

test('evidence is still required when no file blocks', () => {
  const d = decidePushReplay(base({ changedFiles: ['.github/workflows/cla.yml'], keyingList: LIST, artifactNamesByRun: {} }));
  assert.equal(d.replay, false);
  assert.match(d.reason, /tested tree/);
});

test('the last commit of a batch replays on the batch run that tested its tree', () => {
  assert.deepEqual(decidePushReplay(queued([{ tree: TREE, runs: [batchRun()] }])), { replay: true, runId: 9, pr: 7, queue: true });
});

test('an earlier commit of a batch replays on the run that tested a later main tree', () => {
  const d = decidePushReplay(queued([{ tree: TREE, runs: [] }, { tree: h('e'), runs: [] }, { tree: h('0'), runs: [batchRun()] }]));
  assert.deepEqual(d, { replay: true, runId: 9, pr: 7, queue: true });
});

test('with no later tree proven the push runs in full', () => {
  assert.equal(decidePushReplay(queued([{ tree: TREE, runs: [] }])).replay, false);
  assert.equal(decidePushReplay(queued([])).replay, false);
  assert.equal(decidePushReplay(base({ artifactNamesByRun: {} })).replay, false);
});

test('only a green batch run of this repository proves a push', () => {
  for (const over of [
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { conclusion: null, status: 'in_progress' },
    { event: 'push' },
    { path: '.github/workflows/benchmark.yml' },
    { head_branch: 'feature/merge-queue' },
    { head_repository: { full_name: 'attacker/ifc-lite' } },
    { head_repository: undefined },
  ]) {
    const d = decidePushReplay(queued([{ tree: TREE, runs: [batchRun(over)] }]));
    assert.equal(d.replay, false, JSON.stringify(over));
  }
  assert.equal(decidePushReplay(queued([{ tree: TREE, runs: [batchRun()] }], { repo: undefined })).replay, false);
});

test('the queue route keeps every guard the PR route has', () => {
  const evidence = [{ tree: TREE, runs: [batchRun()] }];
  assert.equal(decidePushReplay(queued(evidence, { before: h('9') })).replay, false, 'not a single commit on the tip');
  assert.equal(decidePushReplay(queued(evidence, { changedFiles: ['Cargo.lock'] })).replay, false, 'main-only cache key');
  assert.equal(decidePushReplay(queued(evidence, { changedFiles: ['.github/workflows/test.yml'] })).replay, false, 'workflow edit');
  assert.equal(decidePushReplay(queued(evidence, { pulls: [] })).replay, false, 'no merged PR');
});

test('a cache-keying commit replays only when a later main commit re-keys the caches', () => {
  const evidence = [{ tree: TREE, runs: [] }, { tree: h('e'), runs: [batchRun()] }];
  const workflow = { changedFiles: ['.github/workflows/test.yml'] };
  assert.deepEqual(
    decidePushReplay(queued(evidence, { ...workflow, laterChangedFiles: ['.github/workflows/test.yml', 'x.ts'] })),
    { replay: true, runId: 9, pr: 7, queue: true },
  );
  // A workflow-only full run does not run the Rust lanes, so it cannot re-key for Cargo.lock.
  const cargo = { changedFiles: ['Cargo.lock'], laterChangedFiles: ['.github/workflows/cancel-closed-pr-runs.yml'] };
  assert.match(decidePushReplay(queued(evidence, cargo)).reason, /re-keyed/, 'a different cache-keying file');
  const both = { changedFiles: ['Cargo.lock', '.github/workflows/test.yml'], laterChangedFiles: ['Cargo.lock'] };
  assert.match(decidePushReplay(queued(evidence, both)).reason, /re-keyed/, 'every such file must change again');
  assert.match(decidePushReplay(queued(evidence, { ...workflow, laterChangedFiles: ['x.ts'] })).reason, /re-keyed/, 'nothing later re-keys');
  assert.match(decidePushReplay(queued(evidence, workflow)).reason, /re-keyed/, 'it is the newest');
  assert.match(
    decidePushReplay(queued([{ tree: TREE, runs: [] }], { ...workflow, laterChangedFiles: workflow.changedFiles })).reason,
    /re-keyed/,
    'a later re-key without a proven tree is still a full run',
  );
  // A PR run never ran the push-only lanes, so it cannot stand in for a queue run here.
  assert.equal(decidePushReplay(base({ ...workflow, laterChangedFiles: workflow.changedFiles })).replay, false);
});

test('a full page of later files may be truncated, so it does not count as a re-key', () => {
  const evidence = [{ tree: TREE, runs: [batchRun()] }];
  const changedFiles = ['Cargo.lock'];
  const page = (n) => ['Cargo.lock', ...Array.from({ length: n - 1 }, (_, i) => `f${i}`)];
  assert.equal(decidePushReplay(queued(evidence, { changedFiles, laterChangedFiles: page(99) })).replay, true);
  assert.equal(decidePushReplay(queued(evidence, { changedFiles, laterChangedFiles: page(100) })).replay, false);
});

test('--verify does not re-judge the re-key, however many files the push changed', () => {
  const evidence = [{ tree: TREE, runs: [batchRun()] }];
  const changedFiles = ['Cargo.lock', ...Array.from({ length: 99 }, (_, i) => `f${i}`)];
  assert.equal(decidePushReplay(queued(evidence, { changedFiles, rekeyAlreadyJudged: true })).replay, true);
  assert.equal(decidePushReplay(queued(evidence, { changedFiles })).replay, false);
  assert.equal(decidePushReplay(queued([{ tree: TREE, runs: [batchRun({ conclusion: 'failure' })] }], { changedFiles, rekeyAlreadyJudged: true })).replay, false, 'a run gone red still refuses');
});

test('a PR run that tested the tree wins, so it skips only the lanes it ran', () => {
  const d = decidePushReplay(base({ repo: REPO, queueEvidence: [{ tree: TREE, runs: [batchRun()] }] }));
  assert.deepEqual(d, { replay: true, runId: 1, pr: 7 });
});

test('the newest green batch run of the nearest tree is replayed, so --verify re-reads the same one', () => {
  const older = batchRun({ id: 8, created_at: '2026-11-01T01:00:00Z' });
  assert.equal(decidePushReplay(queued([{ tree: TREE, runs: [older, batchRun()] }, { tree: h('e'), runs: [batchRun({ id: 7 })] }])).runId, 9);
});

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
    // The queue route's reads fail closed too: no compare shape, no tree.
    ['GH_BAD_SHAPE', apiResponse([merged])],
    ['GH_BAD_SHAPE', `
      const path = process.argv[3];
      process.stdout.write(JSON.stringify(path.includes('/compare/')
        ? { status: 'ahead', commits: [{ commit: {} }] }
        : path.includes('/commits/') ? ${JSON.stringify([merged])} : { workflow_runs: [] }));
    `],
  ]) {
    writeFileSync(gh, `#!/usr/bin/env node\n${response}\n`);
    chmodSync(gh, 0o755);
    writeFileSync(output, '');
    const probe = spawnSync(process.execPath, [script, '--probe'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stderr, new RegExp(failure));
    assert.equal(readFileSync(output, 'utf8'), 'replay=false\nreplay_run=\nreplay_queue=false\n');
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

test('the probe reads the Test workflow files at the push commit', {
  skip: process.platform === 'win32' ? 'POSIX gh executable fixture requires a Unix shell environment' : false,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'push-replay-wf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Replay fixture', '-c', 'user.email=replay@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git('init', '-q');
  write('.github/workflows/test.yml', 'jobs:\n  a:\n    steps:\n      - uses: ./.github/actions/setup\n');
  write('.github/actions/setup/action.yml', 'runs: {}\n');
  write('.github/workflows/named.yml', 'on: push\n');
  write('.github/workflows/cla.yml', 'on: push\n');
  write('scripts/ci-cache-keying-files.txt', '# test\n.github/workflows/test.yml\n.github/workflows/named.yml\n.github/actions/setup/\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const script = fileURLToPath(new URL('./ci-push-replay.mjs', import.meta.url));
  const output = join(root, 'output');
  const gh = join(bin, 'gh');

  const replayFor = (changed, cwd = root) => {
    const before = git('rev-parse', 'HEAD');
    if (typeof changed === 'function') changed();
    else write(changed, `changed ${Math.random()}\n`);
    git('add', '-A');
    git('commit', '-qm', 'change');
    const head = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');
    const merged = { ...base().pulls[0], merge_commit_sha: head };
    writeFileSync(gh, `#!/usr/bin/env node
      const path = process.argv[3];
      const response = path.includes('/commits/') ? ${JSON.stringify([merged])}
        : path.includes('/compare/') ? { status: 'identical', commits: [], files: [] }
        : path.includes('/runs/1/artifacts') ? { artifacts: [{ name: '${TREE_ARTIFACT_PREFIX}${tree}', expired: false }] }
        : path.includes('/artifacts?') ? { artifacts: [] }
        : { workflow_runs: ${JSON.stringify(base().runs)} };
      process.stdout.write(JSON.stringify(response));
    `);
    chmodSync(gh, 0o755);
    writeFileSync(output, '');
    const env = {
      ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: 'fixture/replay', GITHUB_SHA: head, PUSH_BEFORE: before, GITHUB_OUTPUT: output,
    };
    const run = spawnSync(process.execPath, [script, '--probe'], { cwd, env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(output, 'utf8');
  };
  const full = 'replay=false\nreplay_run=\nreplay_queue=false\n';
  const replayed = 'replay=true\nreplay_run=1\nreplay_queue=false\n';
  assert.equal(replayFor('.github/workflows/cla.yml'), replayed, 'a workflow not on the list');
  assert.equal(replayFor('.github/actions/other/action.yml'), replayed, 'an action not on the list');
  // From a subdirectory: the list is read from the push commit, not the cwd.
  mkdirSync(join(root, 'sub'), { recursive: true });
  assert.equal(replayFor('.github/workflows/named.yml', join(root, 'sub')), full, 'a listed workflow, probed from a subdirectory');
  // Rename detection would list only the new, unlisted path.
  assert.equal(replayFor(() => git('mv', '.github/workflows/named.yml', '.github/workflows/renamed.yml')), full, 'a renamed listed workflow');
  assert.equal(replayFor('.github/actions/setup/action.yml'), full, 'a file in a listed action');
  // git quotes a non-ASCII path in plain --name-only output, and no listed entry matches a quote.
  assert.equal(replayFor('.github/actions/setup/\u00e9.sh'), full, 'a non-ASCII path in a listed action');
  assert.equal(replayFor('scripts/ci-cache-keying-files.txt'), full, 'the list itself');
  // The list edit above wrote junk over it: malformed, so every workflow and action file blocks.
  assert.equal(replayFor('.github/workflows/test.yml'), full, 'test.yml with a junk list');
  assert.equal(replayFor('.github/workflows/cla.yml'), full, 'an unlisted workflow with a junk list');
  // A list naming test.yml but also a file the tree lacks is malformed too.
  assert.equal(replayFor(() => write('scripts/ci-cache-keying-files.txt', '.github/workflows/test.yml\n.github/actions/setup/\n.github/actions/gone/\n')), full, 'a list with a stale entry');
  assert.equal(replayFor('.github/workflows/cla.yml'), full, 'an unlisted workflow with a stale entry');
  // Well formed again: an unlisted workflow replays.
  assert.equal(replayFor(() => write('scripts/ci-cache-keying-files.txt', '.github/workflows/test.yml\n.github/actions/setup/\n')), full, 'fixing the list');
  assert.equal(replayFor('.github/workflows/cla.yml'), replayed, 'an unlisted workflow with a well-formed list');
  // A symlinked list: `cat-file` would read the link's target path as a one-entry list.
  assert.equal(replayFor(() => {
    write('scripts/real-list.txt', '.github/workflows/test.yml\n.github/actions/setup/\n');
    rmSync(join(root, 'scripts/ci-cache-keying-files.txt'));
    symlinkSync('real-list.txt', join(root, 'scripts/ci-cache-keying-files.txt'));
  }), full, 'replacing the list with a symlink');
  assert.equal(replayFor('.github/actions/setup/action.yml'), full, 'a listed action with the list symlinked');
  assert.equal(replayFor('.github/actions/other/action.yml'), full, 'any action with the list symlinked');
  assert.equal(replayFor(() => rmSync(join(root, 'scripts/ci-cache-keying-files.txt'))), full, 'deleting the list');
  assert.equal(replayFor('.github/workflows/cla.yml'), full, 'with the list missing');
  assert.equal(replayFor('.github/workflows/test.yml'), full, 'test.yml itself');
});
