/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, mergeProducts, shardFiles } from './corpus-shards.mjs';

const files = Array.from({ length: 23 }, (_, i) => ({ path: `m${String(i).padStart(2, '0')}.ifc`, sha256: 'x', size: (i * 7919) % 1000 + 1 }));

test('every ifc lands in exactly one shard, deterministically', () => {
  const shards = shardFiles([...files, { path: 'readme.txt', size: 5 }], 5);
  assert.deepEqual(shards.flat().map((f) => f.path).sort(), files.map((f) => f.path).sort());
  assert.deepEqual(shardFiles([...files].reverse(), 5), shards);
});

test('shards are balanced by bytes', () => {
  const bytes = shardFiles(files, 4).map((s) => s.reduce((t, f) => t + f.size, 0));
  assert.ok(Math.max(...bytes) - Math.min(...bytes) <= Math.max(...files.map((f) => f.size)), `${bytes}`);
});

test('bad counts and empty corpora are refused', () => {
  assert.throws(() => shardFiles(files, 0), /positive integer/);
  assert.throws(() => shardFiles([{ path: 'a.txt' }], 2), /no .ifc files/);
});

test('shard and merge round-trip through the CLI entry', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-shards-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, files }));
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const out = join(dir, `s${i}.json`);
    main(['shard', '--manifest', manifest, '--shards', '3', '--index', String(i), '--out', out]);
    const shard = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(shard.version, 1);
    seen.push(...shard.files.map((f) => f.path));
  }
  assert.equal(new Set(seen).size, files.length);
  assert.equal(seen.length, files.length);
  assert.throws(() => main(['shard', '--manifest', manifest, '--shards', '3', '--index', '3', '--out', join(dir, 'x')]), /--index/);
  assert.throws(() => main(['shard', '--manifest', manifest, '--shards', '40', '--index', '39', '--out', join(dir, 'x')]), /empty/);
});

test('merge keeps one header and refuses a mismatched one', () => {
  assert.equal(mergeProducts(['model\tid\na\t1\n', 'model\tid\nb\t2\n']), 'model\tid\na\t1\nb\t2\n');
  assert.throws(() => mergeProducts(['model\tid\na\t1\n', 'model\tother\nb\t2\n']), /different header/);
  assert.throws(() => mergeProducts([]), /no products/);
});
