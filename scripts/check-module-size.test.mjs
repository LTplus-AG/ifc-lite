#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Black-box regression harness for scripts/check-module-size.mjs.
 *
 * Method mirrors scripts/check-server-bin-targets.test.mjs: each case builds a
 * synthetic tree in a temp dir outside the repo, runs the UNMODIFIED checker
 * against it via `--root` / `--allowlist` / `--digest`, and asserts the exit
 * code AND the message. Nothing here reads the checker's source.
 *
 * The cases that matter most are the ones where a gate could pass having
 * measured nothing — no files, a missing search root, an unreadable or empty
 * allowlist, an absent digest pin. Three scripts in this repo have shipped
 * exiting 0 in exactly that state, so each is pinned here as an executable
 * "must exit non-zero" case.
 *
 * Run: node --test scripts/check-module-size.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowlistDigest, parseAllowlist } from './lib/module-size-ratchet.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-module-size.mjs');

/** A tree of `{ 'packages/a/b.ts': <line count> }` plus an allowlist string. */
function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'module-size-'));
  for (const [rel, lines] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    // `lines` real lines: n-1 newlines plus a terminating one.
    writeFileSync(full, `${Array.from({ length: lines }, (_, i) => `const l${i} = ${i};`).join('\n')}\n`);
  }
  for (const d of ['packages', 'apps']) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

function run(dir, allowlistText, { digest, allowlistPath } = {}) {
  let path = allowlistPath;
  if (path === undefined) {
    path = join(dir, 'allowlist.txt');
    writeFileSync(path, allowlistText ?? '');
  }
  const pin =
    digest ?? (allowlistText ? allowlistDigest(parseAllowlist(allowlistText, 'x')) : '0');
  const res = spawnSync(process.execPath, [CHECKER, '--root', dir, '--allowlist', path, '--digest', pin], {
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const cleanup = [];
test.afterEach?.(() => {});
process.on('exit', () => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});
function tree(files) {
  const d = makeTree(files);
  cleanup.push(d);
  return d;
}

test('clean tree passes and says how much it measured', () => {
  const dir = tree({ 'packages/a/small.ts': 100, 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 0, out);
  assert.match(out, /2 files measured, 1 allowlisted, 0 new over 400/);
});

test('a new file over the limit fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500, 'apps/v/new_god.tsx': 401 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /New TypeScript file\(s\) over 400 lines with no allowlist row/);
  assert.match(out, /apps\/v\/new_god\.tsx: 401 lines/);
});

test('exactly 400 lines is not over the limit', () => {
  const dir = tree({ 'packages/a/edge.ts': 400, 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 0, out);
});

test('an allowlisted file that GREW past its budget fails', () => {
  const dir = tree({ 'packages/a/big.ts': 501 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /grew PAST their recorded budget\. Shrink or split instead of\nraising the budget/);
  assert.match(out, /packages\/a\/big\.ts: 501 lines, budget 500/);
});

test('RAISING the budget to match does not buy a green — the digest fires', () => {
  // The escape hatch this pin exists to close (#2658): grow the file and raise
  // its budget in the same commit. The size check is satisfied; the digest is
  // not, unless the raiser also edits ALLOWLIST_DIGEST where a reviewer sees it.
  const dir = tree({ 'packages/a/big.ts': 501 });
  const stalePin = allowlistDigest(parseAllowlist('500 packages/a/big.ts\n', 'x'));
  const { code, out } = run(dir, '501 packages/a/big.ts\n', { digest: stalePin });
  assert.equal(code, 1, out);
  assert.match(out, /allowlist digest is \d+ \(1 rows, budgets total 501\)/);
  assert.match(out, /Raising a budget loosens this ratchet/);
});

test('a compensating pair of edits still moves the digest', () => {
  const dir = tree({ 'packages/a/x.ts': 450, 'packages/a/y.ts': 450 });
  const before = '500 packages/a/x.ts\n600 packages/a/y.ts\n';
  const after = '600 packages/a/x.ts\n500 packages/a/y.ts\n'; // same total
  const { code, out } = run(dir, after, { digest: allowlistDigest(parseAllowlist(before, 'x')) });
  assert.equal(code, 1, out);
  assert.match(out, /allowlist digest is/);
});

test('a stale row at or under the limit fails', () => {
  const dir = tree({ 'packages/a/small.ts': 100 });
  const { code, out } = run(dir, '380 packages/a/small.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /rows at or under the 400-line limit/);
});

test('a shrunk or vanished row is advisory, not a failure', () => {
  const dir = tree({ 'packages/a/big.ts': 300 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n700 packages/a/gone.ts\n');
  assert.equal(code, 0, out);
  assert.match(out, /note: packages\/a\/big\.ts: now 300 lines <= 400; delete its allowlist row/);
  assert.match(out, /note:\s+packages\/a\/gone\.ts \(budget 700\) no longer matches a tracked file/);
});

// ---------------------------------------------------------------------------
// Must-not-pass-vacuously. Every one of these exits non-zero.
// ---------------------------------------------------------------------------

test('VACUOUS: no TypeScript files at all fails', () => {
  const dir = tree({ 'packages/a/readme.md': 3 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /no TypeScript files matched/);
  assert.match(out, /Exiting 0 here would certify a tree nobody looked at/);
});

test('VACUOUS: only exempt TypeScript files fails', () => {
  // Everything the walker found was a test or a declaration file, so nothing
  // was actually measured. That must be loud, not green.
  const dir = tree({
    'packages/a/x.test.ts': 900,
    'packages/a/x.d.ts': 900,
    'packages/a/generated/y.ts': 900,
  });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /no TypeScript files matched/);
});

test('VACUOUS: a missing search root fails instead of scanning nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-size-'));
  cleanup.push(dir);
  mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'a', 'big.ts'), 'x\n'.repeat(500));
  // No `apps/` directory at all — a glob that resolved to nothing.
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /search root .*apps does not exist or is not a directory/);
});

test('VACUOUS: an unreadable allowlist fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, null, { allowlistPath: join(dir, 'does-not-exist.txt') });
  assert.equal(code, 1, out);
  assert.match(out, /cannot read allowlist/);
});

test('VACUOUS: an empty allowlist fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '', { digest: '0' });
  assert.equal(code, 1, out);
  assert.match(out, /empty or unreadable/);
});

test('VACUOUS: a comments-only allowlist fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '# all rows deleted\n', { digest: '0' });
  assert.equal(code, 1, out);
  assert.match(out, /parsed 0 rows/);
});

test('VACUOUS: a malformed allowlist row fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500\n', { digest: '0' });
  assert.equal(code, 1, out);
  assert.match(out, /malformed line/);
});

test('VACUOUS: a missing digest pin fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n', { digest: '' });
  assert.equal(code, 1, out);
  assert.match(out, /no digest pin/);
});

test('the committed gate runs green against the real repo', () => {
  // With no flags: the real tree, the real allowlist, the real pinned digest.
  // If this is red, either a module grew or the allowlist was edited without
  // moving the pin.
  const res = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8', cwd: ROOT });
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /check-module-size: OK \(\d+ files measured, \d+ allowlisted, 0 new over 400\)/);
});
