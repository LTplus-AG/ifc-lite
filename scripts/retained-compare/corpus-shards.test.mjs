/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyExclusions, exclusionReport, main, mergeProducts, shardFiles } from './corpus-shards.mjs';

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
  const none = join(dir, 'none.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, files }));
  writeFileSync(none, JSON.stringify({ excluded: [] }));
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const out = join(dir, `s${i}.json`);
    main(['shard', '--manifest', manifest, '--shards', '3', '--index', String(i), '--out', out, '--exclusions', none]);
    const shard = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(shard.version, 1);
    seen.push(...shard.files.map((f) => f.path));
  }
  assert.equal(new Set(seen).size, files.length);
  assert.equal(seen.length, files.length);
  assert.throws(() => main(['shard', '--manifest', manifest, '--shards', '3', '--index', '3', '--out', join(dir, 'x'), '--exclusions', none]), /--index/);
  assert.throws(() => main(['shard', '--manifest', manifest, '--shards', '40', '--index', '39', '--out', join(dir, 'x'), '--exclusions', none]), /empty/);
});

test('merge refuses fewer tables than shards', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-shards-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'a.tsv'), b = join(dir, 'b.tsv'), out = join(dir, 'out.tsv');
  writeFileSync(a, 'model\tid\na\t1\n');
  writeFileSync(b, 'model\tid\nb\t2\n');
  assert.throws(() => main(['merge', '--shards', '3', '--out', out, a, b]), /expected 3 products\.tsv files, got 2/);
  assert.throws(() => main(['merge', '--out', out, a, b]), /--shards is required/);
  main(['merge', '--shards', '2', '--out', out, a, b]);
  assert.equal(readFileSync(out, 'utf8'), 'model\tid\na\t1\nb\t2\n');
});

test('merge keeps one header and refuses a mismatched one', () => {
  assert.equal(mergeProducts(['model\tid\na\t1\n', 'model\tid\nb\t2\n']), 'model\tid\na\t1\nb\t2\n');
  assert.throws(() => mergeProducts(['model\tid\na\t1\n', 'model\tother\nb\t2\n']), /different header/);
  assert.throws(() => mergeProducts([]), /no products/);
});

const excludeOne = { path: 'm01.ifc', reason: 'did not finish in budget', evidence: 'run 1 job 2' };

test('an excluded model is in no shard and is reported as not checked', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-shards-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = join(dir, 'manifest.json');
  const exclusions = join(dir, 'exclusions.json');
  writeFileSync(manifest, JSON.stringify({ version: 1, files }));
  writeFileSync(exclusions, JSON.stringify({ excluded: [excludeOne] }));
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const out = join(dir, `s${i}.json`);
    main(['shard', '--manifest', manifest, '--shards', '3', '--index', String(i), '--out', out, '--exclusions', exclusions]);
    seen.push(...JSON.parse(readFileSync(out, 'utf8')).files.map((f) => f.path));
  }
  assert.equal(seen.length, files.length - 1);
  assert.ok(!seen.includes('m01.ifc'));
  const summary = join(dir, 'summary.md');
  process.env.GITHUB_STEP_SUMMARY = summary;
  context.after(() => { delete process.env.GITHUB_STEP_SUMMARY; });
  const line = main(['excluded', '--manifest', manifest, '--exclusions', exclusions]);
  assert.match(line, /1 model NOT CHECKED: m01\.ifc/);
  assert.match(readFileSync(summary, 'utf8'), /NOT CHECKED[\s\S]*m01\.ifc/);
  assert.match(exclusionReport([excludeOne]).warnings[0], /^::warning title=native corpus model NOT CHECKED::m01\.ifc/);
});

test('a stale, unexplained or duplicated exclusion is refused rather than hiding a model', () => {
  assert.throws(() => applyExclusions(files, [{ ...excludeOne, path: 'gone.ifc' }]), /not in the manifest/);
  assert.throws(() => applyExclusions(files, [{ path: 'm01.ifc', reason: 'x' }]), /non-empty evidence/);
  assert.throws(() => applyExclusions(files, [{ ...excludeOne, reason: ' ' }]), /non-empty reason/);
  assert.throws(() => applyExclusions(files, [excludeOne, excludeOne]), /listed twice/);
  assert.equal(applyExclusions(files, []).kept.length, files.length);
});

test('the committed exclusions name real manifest models, explained', () => {
  const repo = join(import.meta.dirname, '..', '..');
  const manifest = JSON.parse(readFileSync(join(repo, 'tests/models/manifest.json'), 'utf8'));
  const { excluded } = JSON.parse(readFileSync(join(import.meta.dirname, 'corpus-exclusions.json'), 'utf8'));
  assert.equal(applyExclusions(manifest.files, excluded).excluded.length, excluded.length);
  // Every remaining ifc still fits the 8 shards of the nightly.
  assert.equal(shardFiles(applyExclusions(manifest.files, excluded).kept, 8).every((s) => s.length > 0), true);
});
