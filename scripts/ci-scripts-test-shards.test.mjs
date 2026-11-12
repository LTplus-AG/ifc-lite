/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PINNED, SHARD_COUNT, ShardError, filesForShard, parseArgs } from './ci-scripts-test-shards.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ci-scripts-test-shards.mjs');
const PINS = [...PINNED];
const OTHERS = ['scripts/a.test.mjs', 'scripts/lib/b.test.mjs', 'scripts/zz/new-unmeasured.test.mjs'];
const LIST = [...OTHERS, ...PINS].sort();

test('every file runs on exactly one shard', () => {
  const shards = Array.from({ length: SHARD_COUNT }, (_, i) => filesForShard(LIST, i + 1, SHARD_COUNT).files);
  assert.deepEqual(shards.flat().sort(), LIST);
});

test('pinned files run on their shard, and a new unmeasured file lands on the catch-all', () => {
  assert.deepEqual(filesForShard(LIST, 1, SHARD_COUNT).files.sort(), [...PINS].sort());
  assert.ok(filesForShard(LIST, 2, SHARD_COUNT).files.includes('scripts/zz/new-unmeasured.test.mjs'));
});

test('a pin naming no listed file costs balance only: reported, and every listed file still runs once', () => {
  // A PR that renames a pinned test must not be blocked on editing PINNED.
  const renamed = [...LIST.filter((f) => f !== PINS[0]), 'scripts/renamed.test.mjs'].sort();
  const shards = [1, 2].map((n) => filesForShard(renamed, n, SHARD_COUNT));
  assert.deepEqual(shards[0].stale, [PINS[0]]);
  assert.deepEqual(shards.flatMap((x) => x.files).sort(), renamed);
  assert.ok(shards[1].files.includes('scripts/renamed.test.mjs'));
});

test('refuses a matrix that no longer matches SHARD_COUNT', () => {
  // A matrix trimmed to one shard would otherwise run only the pinned files.
  assert.throws(() => filesForShard(LIST, 1, 1), /change both together/);
  assert.throws(() => filesForShard(LIST, 3, 3), ShardError);
});

test('refuses an out-of-range shard, duplicates, and a shard with nothing to run', () => {
  assert.throws(() => filesForShard(LIST, 0, SHARD_COUNT), ShardError);
  assert.throws(() => filesForShard(LIST, Number.NaN, SHARD_COUNT), ShardError);
  assert.throws(() => filesForShard([...LIST, LIST[0]], 1, SHARD_COUNT), /duplicates/);
  assert.throws(() => filesForShard([...PINS], 2, SHARD_COUNT), /no test file/);
});

test('parses shard flags, passes reporter flags through, and refuses anything else', () => {
  assert.deepEqual(parseArgs(['--shard=2', '--of=2', '--test-reporter=tap', 'scripts/a.test.mjs']), {
    shard: 2,
    total: 2,
    flags: ['--test-reporter=tap'],
    files: ['scripts/a.test.mjs'],
  });
  assert.throws(() => parseArgs(['--of=2', 'scripts/a.test.mjs']), /required/);
  assert.throws(() => parseArgs(['--shard=1', '--of=2', '--watch']), /unknown option/);
  // Anything that would let node run less than the shard's files is refused.
  for (const narrowing of ['--test-shard=1/2', '--test-name-pattern=x', '--test-skip-pattern=x', '--test-only']) {
    assert.throws(() => parseArgs(['--shard=1', '--of=2', narrowing, 'scripts/a.test.mjs']), /unknown option/, narrowing);
  }
  assert.deepEqual(parseArgs(['--shard=1', '--of=2', '--test-reporter-destination=stdout']).flags, ['--test-reporter-destination=stdout']);
});

test('the CLI runs exactly its shard, and fails closed on a bad plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scripts-test-shards-'));
  try {
    for (const f of LIST) {
      mkdirSync(join(dir, dirname(f)), { recursive: true });
      writeFileSync(join(dir, f), `import { test } from 'node:test';\ntest(${JSON.stringify(`RAN ${f}`)}, () => {});\n`);
    }
    const ran = (shard, total = SHARD_COUNT, files = LIST) => {
      // Without this the inner `node --test` sees the outer runner and reports to it, not to stdout.
      const { NODE_TEST_CONTEXT, ...env } = process.env;
      const res = spawnSync(process.execPath, [SCRIPT, `--shard=${shard}`, `--of=${total}`, '--test-reporter=tap', ...files], { cwd: dir, encoding: 'utf8', env });
      return { status: res.status, stderr: res.stderr, files: [...res.stdout.matchAll(/^ok \d+ - RAN (\S+)$/gm)].map((m) => m[1]).sort() };
    };
    const one = ran(1);
    const two = ran(2);
    assert.equal(one.status, 0);
    assert.equal(two.status, 0);
    assert.deepEqual([...one.files, ...two.files].sort(), LIST);
    assert.equal(ran(1, 1).status, 2);
    // A stale pin warns and still runs: exit 0, and the other pins stay on shard 1.
    const stale = ran(1, SHARD_COUNT, LIST.filter((f) => f !== PINS[1]));
    assert.equal(stale.status, 0);
    assert.match(stale.stderr, /::warning title=scripts-tests pins::/);
    assert.equal(stale.files.length, PINS.length - 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
