/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMPTY_MANIFEST,
  MANIFEST_PATH,
  assignShards,
  packManifest,
  parseManifest,
  pathHash,
  selectShard,
} from './viewer-test-shards.mjs';
import { attributeFiles, declaredTitles, parseTapLog } from './lib/viewer-test-durations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWER = join(ROOT, 'apps/viewer');
const SCRIPT = join(ROOT, 'scripts/viewer-test-shards.mjs');
const SHARDS = 16;

/** The viewer's test files exactly as its `test` script's `find` sees them. */
function realTestFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.test\.tsx?$/.test(e.name)) out.push(relative(VIEWER, p).split('\\').join('/'));
    }
  };
  walk(join(VIEWER, 'src'));
  return out.sort();
}

const manifest = parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));
const files = realTestFiles();

test('the REAL test files are partitioned: each runs in exactly one of the 16 shards, none is empty', () => {
  // Anti-vacuity: an empty walk or an empty manifest would partition trivially.
  assert.ok(files.length >= 2000, `expected the real viewer suite, got ${files.length} files`);
  assert.ok(Object.keys(manifest.seconds).length >= 2000, 'expected the committed manifest to be populated');
  assert.equal(manifest.shards, SHARDS, 'the manifest must be packed for the CI matrix size');
  const seen = new Map();
  for (let s = 0; s < SHARDS; s++) {
    const mine = selectShard(files, manifest, s, SHARDS);
    assert.ok(mine.length > 0, `shard ${s} is empty`);
    for (const f of mine) {
      assert.ok(!seen.has(f), `${f} runs in shard ${seen.get(f)} AND shard ${s}`);
      seen.set(f, s);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), files, 'some test file runs in no shard');
});

test('the packing balances the measured load to within one file of the mean (LPT bound)', () => {
  const packed = packManifest(manifest.seconds, SHARDS);
  const load = new Array(SHARDS).fill(0);
  for (const [f, s] of packed) load[s] += manifest.seconds[f];
  const total = load.reduce((a, b) => a + b, 0);
  const largest = Math.max(...Object.values(manifest.seconds));
  assert.ok(Math.max(...load) <= total / SHARDS + largest + 1e-9, `max shard ${Math.max(...load)}s, mean ${total / SHARDS}s`);
  // And it actually beats the hash it replaces on the same measurements.
  const hashLoad = new Array(SHARDS).fill(0);
  for (const f of Object.keys(manifest.seconds)) hashLoad[pathHash(f) % SHARDS] += manifest.seconds[f];
  assert.ok(Math.max(...load) < Math.max(...hashLoad), 'packing must lower the slowest shard');
});

test('the hash fallback is bit-for-bit the awk selector it replaces, over every real path', () => {
  const awk = spawnSync('awk', [
    '-v', `n=${SHARDS}`,
    '{h=0; for(i=1;i<=length($0);i++) h=(h*31+index(" !\\"#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|}~", substr($0,i,1)))%1000003; print h%n}',
  ], { input: files.join('\n') + '\n', encoding: 'utf8' });
  assert.equal(awk.status, 0, awk.stderr);
  const viaAwk = awk.stdout.trim().split('\n').map(Number);
  assert.deepEqual(files.map((f) => pathHash(f) % SHARDS), viaAwk);
});

test('a file the manifest does not know runs in its hash shard, and moves no other file', () => {
  const added = 'src/a-brand-new-feature.test.ts';
  assert.ok(!(added in manifest.seconds));
  const before = assignShards(files, manifest, SHARDS);
  const after = assignShards([...files, added], manifest, SHARDS);
  assert.equal(after.get(added), pathHash(added) % SHARDS);
  for (const f of files) assert.equal(after.get(f), before.get(f), `${f} moved when an unrelated file was added`);
});

test('a stale manifest entry (file deleted) is never selected and moves no other file', () => {
  const gone = Object.keys(manifest.seconds).find((f) => manifest.seconds[f] > 10);
  const remaining = files.filter((f) => f !== gone);
  const before = assignShards(files, manifest, SHARDS);
  const after = assignShards(remaining, manifest, SHARDS);
  for (let s = 0; s < SHARDS; s++) assert.ok(!selectShard(remaining, manifest, s, SHARDS).includes(gone));
  for (const f of remaining) assert.equal(after.get(f), before.get(f), `${f} moved when ${gone} was deleted`);
});

test('the assignment is deterministic: independent of input order and of manifest key order', () => {
  const tied = { shards: 3, seconds: { 'src/c.test.ts': 5, 'src/a.test.ts': 5, 'src/b.test.ts': 5, 'src/d.test.ts': 1 } };
  const reordered = { shards: 3, seconds: Object.fromEntries(Object.entries(tied.seconds).reverse()) };
  const paths = Object.keys(tied.seconds);
  const a = assignShards(paths, tied, 3);
  const b = assignShards([...paths].reverse(), reordered, 3);
  assert.deepEqual([...a].sort(), [...b].sort());
  // Ties broken by path, then lowest shard: a, b, c fill 0, 1, 2; d joins 0.
  assert.deepEqual(Object.fromEntries(a), { 'src/a.test.ts': 0, 'src/b.test.ts': 1, 'src/c.test.ts': 2, 'src/d.test.ts': 0 });
  const real = [...assignShards(files, manifest, SHARDS)];
  assert.deepEqual([...assignShards([...files].reverse(), manifest, SHARDS)].sort(), real.sort());
});

test('any other shard count ignores the manifest and uses the hash (keeps the one-file idiom)', () => {
  const one = files[0];
  const h = pathHash(one);
  assert.deepEqual(selectShard(files, manifest, h, 1000003), files.filter((f) => pathHash(f) === h));
  for (const f of files.slice(0, 50)) assert.equal(assignShards([f], manifest, 8).get(f), pathHash(f) % 8);
});

function cli(input, env) {
  const clean = { ...process.env };
  delete clean.TEST_SHARDS;
  delete clean.TEST_SHARD;
  return spawnSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', env: { ...clean, ...env } });
}

test('CLI: without TEST_SHARDS every file is printed (a local `pnpm test` runs everything)', () => {
  const r = cli(files.join('\n') + '\n', {});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), files);
});

test('CLI: the 16 shards together print every real file exactly once', () => {
  const all = [];
  for (let s = 0; s < SHARDS; s++) {
    const r = cli(files.join('\n') + '\n', { TEST_SHARDS: String(SHARDS), TEST_SHARD: String(s) });
    assert.equal(r.status, 0, r.stderr);
    all.push(...r.stdout.trim().split('\n'));
  }
  assert.deepEqual(all.sort(), files);
});

test('CLI: refuses an out-of-range shard and an empty selection instead of printing nothing', () => {
  for (const env of [{ TEST_SHARDS: '16', TEST_SHARD: '16' }, { TEST_SHARDS: '0' }, { TEST_SHARDS: '16', TEST_SHARD: 'x' }]) {
    const r = cli(files.join('\n') + '\n', env);
    assert.equal(r.status, 1, `expected refusal for ${JSON.stringify(env)}`);
    assert.equal(r.stdout, '');
  }
  const empty = cli('', {});
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /selected no test files/);
});

test('a malformed manifest is refused, naming the problem', () => {
  assert.throws(() => parseManifest('{"src/a.test.ts": 3}'), /shards/);
  assert.throws(() => parseManifest('{"shards": 16, "seconds": {"src/a.test.ts": -1}}'), /src\/a\.test\.ts/);
  assert.deepEqual(parseManifest('{"shards": 2, "seconds": {}}'), { shards: 2, seconds: {} });
  assert.deepEqual(assignShards(['src/x.test.ts'], EMPTY_MANIFEST, 4).get('src/x.test.ts'), pathHash('src/x.test.ts') % 4);
});

test('attribution: titles map to files in order, a lingering process is charged to itself, and the sum is the wall', () => {
  const sources = [
    // A template-literal title: its interpolation hole matches any text.
    "test('alpha one', () => {}); test(`alpha $" + "{n} two`, () => {});",
    "describe('beta suite', () => {});",
    "test('gamma', () => {});",
  ];
  const at = (s) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.0000000Z`;
  // a: tests end at 2 s, then its process lingers; b's only test runs
  // 42-43 s; c's runs 45-46 s; the summary lands at 47 s.
  const log = [
    `${at(0)} TAP version 13`,
    `${at(1)} ok 1 - alpha one`, `${at(1)}   duration_ms: 500`,
    `${at(2)} ok 2 - alpha 7 two`, `${at(2)}   duration_ms: 500`,
    `${at(43)} ok 3 - beta suite`, `${at(43)}   duration_ms: 1000`,
    `${at(46)} ok 4 - gamma`, `${at(46)}   duration_ms: 1000`,
    `${at(47)} # duration_ms 47000`,
  ].join('\n');
  const names = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];
  const res = attributeFiles(names, sources, parseTapLog(log));
  assert.deepEqual(res.unmatched, []);
  assert.deepEqual(res.silentFiles, []);
  const s = Object.fromEntries(res.seconds);
  // Gaps before a, b, c are 0.5, 40 and 2 s. The median (2 s) caps b's
  // startup, so 38 s of the 40 s gap is a's lingering, not b's import.
  assert.deepEqual(s, { 'src/a.test.ts': 40, 'src/b.test.ts': 3, 'src/c.test.ts': 4 });
  assert.equal(Object.values(s).reduce((x, y) => x + y, 0), res.wall);
  assert.equal(res.wall, 47);
  assert.ok(declaredTitles(sources[0]).some((d) => d instanceof RegExp && d.test('alpha 7 two')));
});
