/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `addedLineRanges` is the one function here whose correctness is load-bearing
 * downstream: validate-findings.mjs refuses any finding whose line falls outside
 * a range this produces, so a bug here either silently drops real findings or
 * lets hallucinated line numbers through. It is tested against hand-checked
 * hunks rather than a fixture, because a fixture generated from this function
 * would agree with it whatever it does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedLineRanges, buildInput, isExcluded, pageFiles, MAX_PATCH_BYTES } from './build-review-input.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'build-review-input.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'review-input-'));
const SHA = 'a'.repeat(40);
let seq = 0;

const run = (rows, extra = []) => {
  const f = join(TMP, `files-${(seq += 1)}.json`);
  const out = join(TMP, `out-${seq}.json`);
  writeFileSync(f, JSON.stringify(rows));
  const r = spawnSync(process.execPath, [SCRIPT, '--sha', SHA, '--files-file', f, '--out', out, ...extra], {
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, result: r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null };
};

// ======================================================== addedLineRanges

test('a single added block yields one range', () => {
  // +10,+11,+12 are added; the hunk starts the new file at line 10.
  const patch = '@@ -1,2 +10,5 @@\n context\n+added one\n+added two\n context';
  // line 10 is ' context', 11 and 12 are the additions.
  assert.deepEqual(addedLineRanges(patch), [[11, 12]]);
});

test('two separated blocks yield two ranges', () => {
  const patch = ['@@ -1,4 +1,6 @@', ' a', '+x', ' b', ' c', '+y', ' d'].join('\n');
  // new file: 1=' a', 2='+x', 3=' b', 4=' c', 5='+y', 6=' d'
  assert.deepEqual(addedLineRanges(patch), [[2, 2], [5, 5]]);
});

test('removed lines do not advance the new-file counter', () => {
  const patch = ['@@ -1,3 +1,2 @@', ' a', '-gone', '+new'].join('\n');
  // new file: 1=' a', then '-gone' consumes nothing, 2='+new'
  assert.deepEqual(addedLineRanges(patch), [[2, 2]]);
});

test('multiple hunks each restart at their own header', () => {
  const patch = ['@@ -1,1 +1,2 @@', ' a', '+b', '@@ -50,1 +51,2 @@', ' c', '+d'].join('\n');
  assert.deepEqual(addedLineRanges(patch), [[2, 2], [52, 52]]);
});

test('a `+++` header line is not counted as an addition', () => {
  const patch = ['+++ b/file.ts', '@@ -1,1 +1,2 @@', ' a', '+real'].join('\n');
  const ranges = addedLineRanges(patch);
  assert.deepEqual(ranges, [[2, 2]], 'only the real addition counts');
});

// ============================================================== exclusions

test('generated and vendored paths are excluded', () => {
  for (const p of ['pnpm-lock.yaml', 'Cargo.lock', 'packages/x/__snapshots__/a.snap', 'tests/fixtures/a.ts', 'packages/wasm/pkg/x.d.ts', 'docs/a.png', 'scripts/api-surface.json']) {
    assert.equal(isExcluded(p), true, `${p} should be excluded`);
  }
});

test('real source is NOT excluded', () => {
  for (const p of ['packages/export/src/step.ts', 'rust/geometry/src/lib.rs', 'scripts/check-x.mjs']) {
    assert.equal(isExcluded(p), false, `${p} must be reviewed`);
  }
});

// ================================================= what is recorded, not dropped

test('a file with no patch is recorded as unreviewable, never silently absent', () => {
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    { filename: 'src/huge.ts', status: 'modified' },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.result.files.length, 1);
  // Structured, not an annotated string: the validator refuses an input where a
  // path is in both `files` and `unreviewable`, and against a string like
  // "src/huge.ts (too large)" that check can never match.
  assert.deepEqual(r.result.unreviewable[0], { path: 'src/huge.ts', reason: 'no patch returned; too large' });
  assert.match(r.out, /NOT shown to the reviewer/);
});

test('a deleted file is unreviewable, not a phantom clean file', () => {
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+b' },
    { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-a\n-b' },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.result.unreviewable[0], { path: 'src/gone.ts', reason: 'deleted' });
});

// ============================================================ refusals

test('NO_FILES refuses rather than emitting an empty review input', () => {
  // A reviewer handed an empty input reports it clean, confidently. That is the
  // absence-reads-as-success shape, one layer below where it usually appears.
  const r = run([{ filename: 'pnpm-lock.yaml', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NO_FILES/);
});

test('REVIEW_TOO_LARGE refuses rather than reviewing a prefix', () => {
  const big = `@@ -1,1 +1,2 @@\n a\n+${'x'.repeat(MAX_PATCH_BYTES)}`;
  const r = run([{ filename: 'src/big.ts', status: 'modified', patch: big }]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /REVIEW_TOO_LARGE/);
  assert.match(r.out, /split the PR/);
});

test('a bad --sha is refused', () => {
  const f = join(TMP, 'f.json');
  writeFileSync(f, JSON.stringify([{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1,2 @@\n a\n+b' }]));
  const r = spawnSync(process.execPath, [SCRIPT, '--sha', 'nope', '--files-file', f, '--out', join(TMP, 'o.json')], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /NO_SHA/);
});

// ================================================================== paging

test('the pager stops at a short page and reports a complete read', () => {
  const pages = { 1: Array(100).fill({ filename: 'a' }), 2: [{ filename: 'b' }] };
  const seen = [];
  const r = pageFiles((p) => { seen.push(p); return pages[p] ?? []; });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(r.truncated, false);
  assert.equal(r.rows.length, 101);
});

test('a file list past the page budget reports truncated, and the caller refuses', () => {
  const r = pageFiles(() => Array(10).fill({ filename: 'a' }), { maxPages: 3, perPage: 10 });
  assert.equal(r.truncated, true);
});

test('a non-array page is BAD_PAYLOAD, not an empty read', () => {
  assert.throws(() => pageFiles(() => ({})), (e) => e.reason === 'BAD_PAYLOAD');
});

// =========================================================== the whole shape

test('the emitted input carries exactly what the reviewer may see', () => {
  const r = run([
    { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,1 +1,2 @@\n a\n+added' },
    { filename: 'pnpm-lock.yaml', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
  ]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(Object.keys(r.result).sort(), ['excluded', 'files', 'headSha', 'unreviewable']);
  assert.equal(r.result.headSha, SHA);
  assert.equal(r.result.files[0].path, 'src/a.ts');
  assert.deepEqual(r.result.files[0].addedLineRanges, [[2, 2]]);
  assert.deepEqual(r.result.excluded, ['pnpm-lock.yaml']);
  // The PR title and body are attacker-controlled and carry no review value, so
  // they are not in the shape at all rather than being sanitised later.
  assert.equal(r.result.title, undefined);
  assert.equal(r.result.body, undefined);
});
