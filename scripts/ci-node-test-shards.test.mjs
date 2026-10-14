/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATCH_ALL,
  OWN_JOB,
  PINNED,
  ShardError,
  assertNamesResolve,
  assignment,
  shardFilters,
  workspacePackageNames,
} from './ci-node-test-shards.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/ci-node-test-shards.mjs');

test('the REAL workspace is partitioned: every package outside the own-job lanes runs on exactly one shard', () => {
  const names = workspacePackageNames(ROOT);
  // Anti-vacuity: an empty walk would partition trivially.
  assert.ok(names.length >= 40, `expected the real workspace, got ${names.length} packages`);
  for (const [name, shards] of assignment(names)) {
    if (OWN_JOB.includes(name)) {
      assert.deepEqual(shards, [], `${name} has its own job and must not run in any Node tests shard`);
    } else {
      assert.equal(shards.length, 1, `${name} runs on shards [${shards}], expected exactly one`);
    }
  }
});

test('a package nobody pinned lands on the catch-all shard', () => {
  const map = assignment(['@ifc-lite/brand-new-package']);
  assert.deepEqual(map.get('@ifc-lite/brand-new-package'), [CATCH_ALL]);
});

test('the catch-all excludes every pinned and own-job package, and nothing else', () => {
  const excluded = shardFilters(CATCH_ALL).map((f) => {
    assert.ok(f.startsWith('--filter=!'), `catch-all filter ${f} must be an exclusion`);
    return f.slice('--filter=!'.length);
  });
  assert.deepEqual(new Set(excluded), new Set([...OWN_JOB, ...Object.values(PINNED).flat()]));
});

test('a pinned name that is not a workspace package is refused, naming it', () => {
  const real = workspacePackageNames(ROOT).filter((n) => n !== PINNED[1][0]);
  assert.throws(
    () => assertNamesResolve(real),
    (e) => e instanceof ShardError && e.message.includes(PINNED[1][0]),
  );
  assert.doesNotThrow(() => assertNamesResolve(workspacePackageNames(ROOT)));
});

test('an unknown shard number is refused rather than running nothing', () => {
  for (const bad of [0, 5, NaN]) {
    assert.throws(() => shardFilters(bad), ShardError);
  }
});

test('the CLI prints one filter per line and exits non-zero on a bad shard', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, '--shard', '1'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout.trim().split('\n'), PINNED[1].map((p) => `--filter=${p}`));

  const bad = spawnSync(process.execPath, [SCRIPT, '--shard', '9'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown shard/);
  assert.equal(bad.stdout, '');
});
