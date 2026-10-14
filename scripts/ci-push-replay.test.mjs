/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
