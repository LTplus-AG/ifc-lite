/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/ci-e2e-shards.mjs: the eight `Viewer E2E smoke` shards PARTITION the
 * files the `viewer-e2e-ci` project selects (every file in exactly one shard,
 * none invented), stay balanced under the measured durations, and refuse a
 * stale table rather than silently run less.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  SHARD_COUNT,
  TIMINGS_S,
  UNMEASURED_S,
  ShardError,
  fileFilter,
  packShards,
  parseShard,
  projectTestMatch,
  selectedFiles,
  shardFilters,
} from './ci-e2e-shards.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = selectedFiles(ROOT);
const CAP_S = 13 * 60;

test('the selection is the project testMatch over testDir, and the table has no stale entry', () => {
  assert.ok(FILES.length > 50, `only ${FILES.length} files selected; the testMatch read is wrong`);
  assert.deepEqual(Object.keys(TIMINGS_S).filter((f) => !FILES.includes(f)), []);
});

test('the 8 shards partition the selected files: union equals the set, no duplicates, none empty', () => {
  const { shards } = packShards(FILES);
  assert.equal(shards.length, SHARD_COUNT);
  const all = shards.flat();
  assert.equal(new Set(all).size, all.length, 'a file landed in two shards');
  assert.deepEqual([...all].sort(), [...FILES].sort());
  for (const [i, s] of shards.entries()) assert.ok(s.length > 0, `shard ${i + 1} is empty`);
});

test('the filters the CLI prints select each shard\'s files and no others', () => {
  const seen = [];
  for (let n = 1; n <= SHARD_COUNT; n++) {
    const filters = shardFilters(`${n}/${SHARD_COUNT}`, ROOT);
    const regexes = filters.map((f) => new RegExp(f));
    const picked = FILES.filter((file) => regexes.some((re) => re.test(`${ROOT}/${file}`)));
    assert.deepEqual(picked, packShards(FILES).shards[n - 1], `shard ${n} filters pick other files than the pack`);
    seen.push(...picked);
  }
  assert.deepEqual(seen.sort(), [...FILES].sort());
});

test('predicted shard durations are balanced and far under the 13-minute cap', () => {
  const { loads } = packShards(FILES);
  const max = Math.max(...loads);
  const min = Math.min(...loads);
  assert.ok(max < 9 * 60, `heaviest shard predicts ${Math.round(max / 60)} min`);
  assert.ok(max - min < 90, `shards differ by ${Math.round(max - min)} s`);
  assert.ok(max < CAP_S);
});

test('a file with no timing is not dropped: it goes to the lightest shard at UNMEASURED_S', () => {
  const files = ['tests/e2e/a.e2e.spec.ts', 'tests/e2e/b.e2e.spec.ts', 'tests/e2e/new.e2e.spec.ts'];
  const { shards, loads } = packShards(files, 2, { 'tests/e2e/a.e2e.spec.ts': 100, 'tests/e2e/b.e2e.spec.ts': 10 });
  assert.deepEqual(shards, [['tests/e2e/a.e2e.spec.ts'], ['tests/e2e/b.e2e.spec.ts', 'tests/e2e/new.e2e.spec.ts']]);
  assert.deepEqual(loads, [100, 10 + UNMEASURED_S]);
});

test('measured files keep their shard when an unmeasured one is added', () => {
  const before = packShards(FILES).shards;
  const after = packShards([...FILES, 'tests/e2e/brand-new.e2e.spec.ts']).shards;
  // Unmeasured files fill the lightest shards in name order, so only the
  // measured files are pinned in place.
  for (const [i, s] of before.entries()) assert.deepEqual(after[i].filter((f) => f in TIMINGS_S), s.filter((f) => f in TIMINGS_S));
});

test('a timing entry for a file the project no longer selects makes the pack refuse', () => {
  assert.throws(() => packShards(['tests/e2e/a.e2e.spec.ts'], 2, { 'tests/e2e/gone.e2e.spec.ts': 5 }), ShardError);
  assert.throws(() => packShards(['tests/e2e/a.e2e.spec.ts', 'tests/e2e/a.e2e.spec.ts'], 2, {}), /duplicates/);
});

test('shard specs outside 1..8 or for another matrix size are refused', () => {
  assert.equal(parseShard('3/8'), 3);
  for (const bad of ['0/8', '9/8', '3/4', '3', undefined, 'x/8']) assert.throws(() => parseShard(bad), ShardError, String(bad));
});

test('a filter selects exactly its own file, not a longer name that contains it', () => {
  const re = new RegExp(fileFilter('tests/e2e/rhino-export.e2e.spec.ts'));
  assert.ok(re.test('/r/tests/e2e/rhino-export.e2e.spec.ts'));
  assert.ok(!re.test('/r/tests/e2e/rhino-export.e2e.spec.ts.bak'));
  assert.ok(!re.test('/r/tests/e2e/rhino-exportXe2eXspecXts'));
});

test('a config without the project is refused, not read as an empty selection', () => {
  assert.throws(() => projectTestMatch('export default {}'), ShardError);
});

test('the workflow step runs the CLI for its own matrix shard and never falls back to --shard', () => {
  const steps = parse(readFileSync(join(ROOT, '.github/workflows/test.yml'), 'utf8')).jobs['viewer-e2e'].steps;
  const step = steps.find((s) => s.id === 'e2e');
  assert.match(step.run, /ci-e2e-shards\.mjs --shard \$\{\{ matrix\.shard \}\}\/8/); // @source-text-assertion-ok the step's command line is the subject
  assert.doesNotMatch(step.run, /--shard=/); // @source-text-assertion-ok
  assert.match(step.run, /13m/); // @source-text-assertion-ok the 13-minute bound stays
  const retry = steps.find((s) => s.id === 'e2e_retry');
  assert.equal(retry.env.E2E_SHARD, '${{ matrix.shard }}/8'); // eslint-disable-line no-template-curly-in-string
});

test('the CLI prints one filter per line for a shard and exits 1 with an annotation for a bad one', () => {
  const ok = spawnSync(process.execPath, [join(ROOT, 'scripts/ci-e2e-shards.mjs'), '--shard', '1/8'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout.trim().split('\n'), shardFilters('1/8', ROOT));
  const bad = spawnSync(process.execPath, [join(ROOT, 'scripts/ci-e2e-shards.mjs'), '--shard', '1/9'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^::error::ci-e2e-shards:/);
});
