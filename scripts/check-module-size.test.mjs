#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Black-box regression harness for scripts/check-module-size.mjs.
 *
 * Method mirrors scripts/check-server-bin-targets.test.mjs: each case builds a
 * synthetic tree in a temp dir outside the repo, runs the UNMODIFIED checker
 * against it via `--root` / `--allowlist`, and asserts the exit code AND the
 * message. Nothing here reads the checker's source.
 *
 * The `--update` scoping cases (#3398) need a REAL git repository, because the
 * scope is derived from `git diff` against the merge base with main. They
 * `git init` inside the same temp dir; `tmpdir()` has no enclosing repository,
 * which is asserted as its own case so the derivation cannot quietly be reading
 * this checkout's diff instead.
 *
 * The cases that matter most are the ones where a gate could pass having
 * measured nothing — no files, a missing search root, an unreadable or empty
 * allowlist. Three scripts in this repo have shipped exiting 0 in exactly that
 * state, so each is pinned here as an executable "must exit non-zero" case.
 *
 * NO DIGEST PIN (removed by #3745; see scripts/check-module-size.mjs and
 * scripts/module-size-allowlist.txt for why). `allowlistDigest`/
 * `allowlistDigests` still exist in ./lib/module-size-ratchet.mjs and are
 * still tested there — they back the Rust-parity check, unrelated to this
 * gate's own pass/fail — but this file no longer passes `--digests` or
 * asserts anything about a digest.
 *
 * Run: node --test scripts/check-module-size.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowlistScope, parseAllowlist } from './lib/module-size-ratchet.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-module-size.mjs');

/** `lines` real lines: n-1 newlines plus a terminating one. */
function source(lines) {
  return `${Array.from({ length: lines }, (_, i) => `const l${i} = ${i};`).join('\n')}\n`;
}

function writeSource(dir, rel, lines) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, source(lines));
}

/** A tree of `{ 'packages/a/b.ts': <line count> }` plus an allowlist string. */
function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'module-size-'));
  for (const [rel, lines] of Object.entries(files)) writeSource(dir, rel, lines);
  for (const d of ['packages', 'apps', 'scripts']) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

function run(dir, allowlistText, { allowlistPath, extra = [] } = {}) {
  let path = allowlistPath;
  if (path === undefined) {
    path = join(dir, 'allowlist.txt');
    writeFileSync(path, allowlistText ?? '');
  }
  const res = spawnSync(process.execPath, [CHECKER, '--root', dir, '--allowlist', path, ...extra], {
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}`, allowlistPath: path };
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

/**
 * The same tree, but a REAL git repository with `files` committed on `main`.
 *
 * `--update` scopes itself to the files a change touched, and git is where that
 * answer comes from, so these cases cannot be faked with a plain directory.
 * `tmpdir()` has no enclosing repository (asserted below), which is what keeps
 * the derivation hermetic rather than reading this checkout's own diff.
 */
function gitTree(files) {
  const dir = tree(files);
  const git = (...argv) => {
    const res = spawnSync('git', ['-C', dir, ...argv], { encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${argv.join(' ')}: ${res.stdout}${res.stderr}`);
    return res.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ratchet@example.invalid');
  git('config', 'user.name', 'ratchet test');
  git('add', '--', ...Object.keys(files));
  git('commit', '-qm', 'base');
  return { dir, git };
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
  assert.match(out, /New source file\(s\) over 400 lines with no allowlist row/);
  assert.match(out, /apps\/v\/new_god\.tsx: 401 lines/);
});

test('a new .mjs file over the limit fails too (#3672)', () => {
  // The defect this gate itself shipped: SOURCE_RE was TS/TSX-only, so 208
  // .mjs files — the tree the CI gates live in — were outside the population
  // it printed OK for. Same shape as #3639 in check-source-text-assertions.
  const dir = tree({ 'packages/a/big.ts': 500, 'scripts/god-gate.mjs': 401 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /scripts\/god-gate\.mjs: 401 lines/);
});

test('a .test.mjs file of any size is exempt, and .cjs is in the population', () => {
  // One case, both carve-out edges: the test-file exemption must match the new
  // extensions (or seeding day one would have swept ~70 *.test.mjs files into
  // the allowlist), while a plain .cjs module is measured like any other.
  const dir = tree({
    'packages/a/big.ts': 500,
    'scripts/god-gate.test.mjs': 900,
    'scripts/legacy.cjs': 401,
  });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /scripts\/legacy\.cjs: 401 lines/);
  assert.doesNotMatch(out, /god-gate\.test\.mjs/);
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

test('RAISING the budget to match the file DOES buy a green (#3745)', () => {
  // The old behaviour here (RED unless a separately-committed digest also
  // moved) is exactly the contention #3745 was filed for: two PRs raising
  // DIFFERENT files in the SAME scope both had to rewrite the identical pinned
  // line. The row edit itself is the reviewable signal now; a plain
  // allowlist-only edit that matches the file's real, measured size is not a
  // second, separately-gated event.
  const dir = tree({ 'packages/a/big.ts': 501 });
  const { code, out } = run(dir, '501 packages/a/big.ts\n');
  assert.equal(code, 0, out);
});

test('two PRs raising DIFFERENT rows in the SAME scope both pass independently (#3745)', () => {
  // The RED this issue reproduced: both used to rewrite one pinned digest
  // line for the scope and could not both land without a merge conflict, even
  // though their row edits never touched the same line. There is nothing left
  // to rewrite in a second file, so each passes on its own — simulated here as
  // two independent worktrees, each with only ITS OWN row raised to match its
  // own file, the other row left at the pre-existing (lower) budget exactly as
  // a real branch that never touched that file would leave it.
  const dirA = tree({ 'packages/a/x.ts': 455, 'packages/a/y.ts': 450 });
  const afterA = '455 packages/a/x.ts\n450 packages/a/y.ts\n';
  assert.equal(run(dirA, afterA).code, 0);

  const dirB = tree({ 'packages/a/x.ts': 450, 'packages/a/y.ts': 455 });
  const afterB = '450 packages/a/x.ts\n455 packages/a/y.ts\n';
  assert.equal(run(dirB, afterB).code, 0);
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
  assert.match(out, /no TypeScript or Node-script files matched/);
  assert.match(out, /Exiting 0 here would certify a tree nobody looked at/);
});

test('VACUOUS: only exempt TypeScript files fails', () => {
  // Everything the walker found was a test or a declaration file, so nothing
  // was actually measured. That must be loud, not green.
  const dir = tree({
    'packages/a/x.test.ts': 900,
    'packages/a/x.d.ts': 900,
    'packages/a/generated/y.ts': 900,
    'scripts/x.test.mjs': 900,
  });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /no TypeScript or Node-script files matched/);
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
  const { code, out } = run(dir, '');
  assert.equal(code, 1, out);
  assert.match(out, /empty or unreadable/);
});

test('VACUOUS: a comments-only allowlist fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '# all rows deleted\n');
  assert.equal(code, 1, out);
  assert.match(out, /parsed 0 rows/);
});

test('VACUOUS: a malformed allowlist row fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500\n');
  assert.equal(code, 1, out);
  assert.match(out, /malformed line/);
});

// ---------------------------------------------------------------------------
// --update: the regeneration half. The whole point of these is the direction
// it must REFUSE — a ratchet whose own baseline command can raise a budget has
// no teeth left.
// ---------------------------------------------------------------------------

const HEADER = '# header line kept verbatim\n';

test('--update refuses to raise a budget, and writes nothing', () => {
  const dir = tree({ 'packages/a/big.ts': 501 });
  const before = `${HEADER}500 packages/a/big.ts\n`;
  const { code, out, allowlistPath } = run(dir, before, { extra: ['--update', '--all'] });
  assert.equal(code, 1, out);
  assert.match(out, /refusing to loosen the ratchet/);
  assert.match(out, /packages\/a\/big\.ts: 501 lines, budget 500 \(\+1\)/);
  assert.match(out, /Nothing was written/);
  // Not "mostly nothing": byte-for-byte unchanged.
  assert.equal(readFileSync(allowlistPath, 'utf8'), before);
});

test('--update refuses to add a new exemption, and writes nothing', () => {
  const dir = tree({ 'packages/a/big.ts': 500, 'apps/v/new_god.tsx': 401 });
  const before = `${HEADER}500 packages/a/big.ts\n`;
  const { code, out, allowlistPath } = run(dir, before, { extra: ['--update', '--all'] });
  assert.equal(code, 1, out);
  assert.match(out, /new exemption/);
  assert.match(out, /apps\/v\/new_god\.tsx: 401 lines/);
  assert.equal(readFileSync(allowlistPath, 'utf8'), before);
});

test('--update DOES lower a slack budget and drop a stale row', () => {
  // Both directions that tighten. This is the case that makes a rebase onto a
  // moved main a one-command operation instead of a hand edit.
  const dir = tree({ 'packages/a/big.ts': 450, 'packages/a/small.ts': 100 });
  const { code, out, allowlistPath } = run(
    dir,
    `${HEADER}500 packages/a/big.ts\n420 packages/a/small.ts\n700 packages/a/gone.ts\n`,
    { extra: ['--update', '--all'] },
  );
  assert.equal(code, 0, out);
  assert.equal(
    readFileSync(allowlistPath, 'utf8'),
    `${HEADER}   450 packages/a/big.ts\n`,
  );
  assert.match(out, /wrote 1 rows/);
});

test('--update --allow-raise does raise it, and says so in the output', () => {
  const dir = tree({ 'packages/a/big.ts': 501 });
  const { code, out, allowlistPath } = run(dir, `${HEADER}500 packages/a/big.ts\n`, {
    extra: ['--update', '--allow-raise', '--all'],
  });
  assert.equal(code, 0, out);
  assert.match(out, /RAISED:\s+packages\/a\/big\.ts: 501 lines, budget 500/);
  assert.equal(readFileSync(allowlistPath, 'utf8'), `${HEADER}   501 packages/a/big.ts\n`);
});

test('--allow-raise without --update is refused rather than silently ignored', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, `${HEADER}500 packages/a/big.ts\n`, { extra: ['--allow-raise'] });
  assert.equal(code, 1, out);
  assert.match(out, /--allow-raise only means something with --update/);
});

test('VACUOUS: --update refuses to write an allowlist with no rows', () => {
  // Every file under the limit. Silently writing an empty allowlist would
  // parse as "0 rows" on the next run and fail there instead, or — worse —
  // read as a clean tree.
  const dir = tree({ 'packages/a/small.ts': 100 });
  const { code, out, allowlistPath } = run(dir, `${HEADER}500 packages/a/small.ts\n`, {
    extra: ['--update', '--all'],
  });
  assert.equal(code, 1, out);
  assert.match(out, /refusing to write an allowlist with 0 rows/);
  assert.equal(readFileSync(allowlistPath, 'utf8'), `${HEADER}500 packages/a/small.ts\n`);
});

test('what --update writes is what the gate then accepts', () => {
  // The regeneration and the check must agree, or the baseline command hands
  // you a tree that fails its own gate.
  const dir = tree({ 'packages/a/big.ts': 450, 'packages/a/x.ts': 900 });
  const { code, out, allowlistPath } = run(
    dir,
    `${HEADER}500 packages/a/big.ts\n900 packages/a/x.ts\n`,
    { extra: ['--update', '--all'] },
  );
  assert.equal(code, 0, out);
  const after = run(dir, null, { allowlistPath });
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /0 new over 400/);
});

test('scoping is two levels, and everything else falls back to its first segment', () => {
  assert.equal(allowlistScope('packages/export/src/deep/a.ts'), 'packages/export');
  assert.equal(allowlistScope('apps/viewer/src/b.tsx'), 'apps/viewer');
  assert.equal(allowlistScope('rust/core/src/c.rs'), 'rust/core');
  // Not `packages` alone — that would still couple every package to every
  // other, which is most of the contention this removes.
  assert.notEqual(allowlistScope('packages/export/src/a.ts'), 'packages');
  assert.equal(allowlistScope('scripts/d.ts'), 'scripts');
  assert.equal(allowlistScope('top-level.ts'), 'top-level.ts');
});

test('regenerating the real allowlist reproduces it byte for byte', () => {
  // The format is hand-maintained today, so `--update` must not reflow it.
  // Run against a COPY of the repo's allowlist in a temp dir — the committed
  // one is never written by a test.
  const realText = readFileSync(join(ROOT, 'scripts', 'module-size-allowlist.txt'), 'utf8');
  const rows = parseAllowlist(realText, 'real');
  const dir = tree({});
  for (const [rel, budget] of rows) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${Array.from({ length: budget }, (_, i) => `const l${i} = ${i};`).join('\n')}\n`);
  }
  const copy = join(dir, 'copied-allowlist.txt');
  writeFileSync(copy, realText);
  const { code, out } = run(dir, null, {
    allowlistPath: copy,
    extra: ['--update', '--all'],
  });
  assert.equal(code, 0, out);
  assert.equal(readFileSync(copy, 'utf8'), realText);
});

test('the committed gate runs green against the real repo', () => {
  // With no flags: the real tree, the real allowlist.
  // If this is red, either a module grew or a new god file has no row.
  const res = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8', cwd: ROOT });
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /check-module-size: OK \(\d+ files measured, \d+ allowlisted, 0 new over 400\)/);
});

// ---------------------------------------------------------------------------
// --update is SCOPED to the change (#3398). Repo-wide re-recording rewrote 11
// allowlist rows and moved 5 digest lines on an unmodified checkout of
// afa717bcf, with `git status` clean, which is the mechanism behind the
// two-PR collision #3398 was filed for.
// ---------------------------------------------------------------------------

const SCOPED_BEFORE = `${HEADER}   500 packages/a/big.ts\n   460 packages/b/slack.ts\n`;

test('the temp dir the scoping cases build in has no enclosing git repository', () => {
  // Anti-vacuity for every case below: if tmpdir() sat inside a repository,
  // the derivation would read THAT repository's diff and the scoped runs would
  // pass or fail for a reason nothing here controls.
  const res = spawnSync('git', ['-C', tmpdir(), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  assert.notEqual(res.status, 0, `tmpdir() is inside a git repo: ${res.stdout}`);
});

test('--update re-records the changed file and leaves the untouched row alone', () => {
  const { dir, git } = gitTree({ 'packages/a/big.ts': 500, 'packages/b/slack.ts': 450 });
  git('checkout', '-q', '-b', 'feature');
  writeSource(dir, 'packages/a/big.ts', 520);

  const { code, out, allowlistPath } = run(dir, SCOPED_BEFORE, { extra: ['--update', '--allow-raise'] });
  assert.equal(code, 0, out);
  // packages/b/slack.ts has 10 lines of headroom and this change never touched
  // it. Byte-for-byte: its row keeps the committed 460, not the measured 450.
  assert.equal(
    readFileSync(allowlistPath, 'utf8'),
    `${HEADER}   520 packages/a/big.ts\n   460 packages/b/slack.ts\n`,
  );
  // The count is the population scoping can ACT on, not every changed path:
  // this fixture changes 2 paths and exactly 1 of them is an allowlistable
  // module, so a bare "2 changed file(s)" would have overstated the scope.
  assert.match(out, /scoped to 1 changed module\(s\) \(of 2 changed path\(s\)\) vs main \([0-9a-f]{9}\)/);
  assert.match(out, /pass --all to re-record every row/);
});

test('--update on an unchanged worktree writes the allowlist back unchanged', () => {
  const { dir } = gitTree({ 'packages/a/big.ts': 500, 'packages/b/slack.ts': 450 });
  const { code, out, allowlistPath } = run(dir, SCOPED_BEFORE, { extra: ['--update'] });
  assert.equal(code, 0, out);
  assert.equal(readFileSync(allowlistPath, 'utf8'), SCOPED_BEFORE);
  assert.match(out, /0 lowered, 0 removed, 0 raised, 0 added/);
});

test('--all is the deliberate opt-out, and it DOES annex the untouched row', () => {
  // The A/B against the case above, same fixture: the sweep is still available,
  // it just has to be asked for.
  const { dir } = gitTree({ 'packages/a/big.ts': 500, 'packages/b/slack.ts': 450 });
  const { code, out, allowlistPath } = run(dir, SCOPED_BEFORE, { extra: ['--update', '--all'] });
  assert.equal(code, 0, out);
  assert.equal(
    readFileSync(allowlistPath, 'utf8'),
    `${HEADER}   500 packages/a/big.ts\n   450 packages/b/slack.ts\n`,
  );
  assert.match(out, /lowered:\s+packages\/b\/slack\.ts: 450 lines, budget 460/);
  assert.match(out, /re-recording EVERY row in the tree/);
});

test('--update outside a git worktree fails closed and names --all', () => {
  // Falling back to repo-wide here is the annexation again, in the one place
  // nobody is reading the output.
  const dir = tree({ 'packages/a/big.ts': 450, 'packages/b/slack.ts': 450 });
  const { code, out, allowlistPath } = run(dir, SCOPED_BEFORE, { extra: ['--update'] });
  assert.equal(code, 1, out);
  assert.match(out, /deriving those needs git/);
  assert.match(out, /is not inside a git worktree/);
  assert.match(out, /pass\n--all for a deliberate repo-wide regenerate/);
  assert.equal(readFileSync(allowlistPath, 'utf8'), SCOPED_BEFORE);
});

test('a god file the change ADDED but never committed is in scope', () => {
  const { dir } = gitTree({ 'packages/a/big.ts': 500 });
  writeSource(dir, 'packages/a/new_god.ts', 401);
  const before = `${HEADER}   500 packages/a/big.ts\n`;

  const refused = run(dir, before, { extra: ['--update'] });
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /packages\/a\/new_god\.ts: 401 lines \(new exemption\)/);
  assert.equal(readFileSync(refused.allowlistPath, 'utf8'), before);

  const allowed = run(dir, before, { allowlistPath: refused.allowlistPath, extra: ['--update', '--allow-raise'] });
  assert.equal(allowed.code, 0, allowed.out);
  assert.equal(
    readFileSync(allowed.allowlistPath, 'utf8'),
    `${HEADER}   500 packages/a/big.ts\n   401 packages/a/new_god.ts\n`,
  );
});

test('--all without --update is refused rather than silently ignored', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, `${HEADER}500 packages/a/big.ts\n`, { extra: ['--all'] });
  assert.equal(code, 1, out);
  assert.match(out, /--all only means something with --update/);
});

test('--update refuses a --root that is not the top of its worktree', () => {
  // A tree NESTED in some other repository must not inherit that repository's
  // diff: git answers in paths relative to the outer top, which match nothing
  // the walk measured, so every row would silently carry through and the run
  // would report a scope it never actually had.
  const { dir } = gitTree({ 'packages/a/big.ts': 500 });
  const nested = join(dir, 'nested');
  writeSource(nested, 'packages/a/big.ts', 500);
  writeSource(nested, 'packages/b/slack.ts', 450);
  for (const d of ['apps', 'scripts']) mkdirSync(join(nested, d), { recursive: true });

  const { code, out, allowlistPath } = run(nested, SCOPED_BEFORE, { extra: ['--update'] });
  assert.equal(code, 1, out);
  assert.match(out, /is not the top of its git worktree/);
  assert.equal(readFileSync(allowlistPath, 'utf8'), SCOPED_BEFORE);
});

// pnpm forwards the conventional `--` separator to the script verbatim, so
// `pnpm lint:module-size-baseline -- --all` reached parseArgs as a bare `--`
// and died with "unknown argument" before writing anything. The docstring no
// longer spells it that way, but a contributor typing it out of habit must not
// hit a hard failure from a gate whose own subject is advice that works.
test('a bare -- separator is tolerated, not a hard failure', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n', { extra: ['--'] });
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /unknown argument/);
});

// `--no-renames` in changedFiles() is load-bearing and was silent when removed:
// rename detection reports only the DESTINATION, so the source's allowlist row
// -- the one that must be dropped, because that file no longer exists -- stays
// out of scope and survives the regenerate. The gate then still exits 0, with
// the stale row reported only as an advisory `missing` note.
test('a renamed module puts BOTH paths in scope, so the source row drops', () => {
  const { dir, git } = gitTree({ 'packages/a/big.ts': 500, 'packages/b/slack.ts': 450 });
  git('checkout', '-q', '-b', 'feature');
  git('mv', 'packages/a/big.ts', 'packages/a/renamed.ts');

  const { code, out, allowlistPath } = run(dir, SCOPED_BEFORE, { extra: ['--update', '--allow-raise'] });
  assert.equal(code, 0, out);
  // The source row is GONE and the destination has one, both at 500 lines.
  // packages/b/slack.ts is untouched, so it keeps its committed 460.
  assert.equal(
    readFileSync(allowlistPath, 'utf8'),
    `${HEADER}   500 packages/a/renamed.ts\n   460 packages/b/slack.ts\n`,
  );
});

// changedFiles() falls back from `origin/main` to a local `main`, and that ref
// can be arbitrarily stale (changedFiles' own comment carries the measurement).
// A stale base widens the scope, so the warning is the only thing between a
// contributor and the annexation this whole change exists to stop -- and it was
// as invisible as the two guards above: deleting it left the suite green, and
// so did making it fire unconditionally. Asserted in BOTH directions, because a
// warning that always fires is as useless as one that never does.
test('the local-main fallback warns, and an origin/main base does not', () => {
  const { dir, git } = gitTree({ 'packages/a/big.ts': 500, 'packages/b/slack.ts': 450 });
  git('checkout', '-q', '-b', 'feature');
  writeSource(dir, 'packages/a/big.ts', 480);

  // No `origin/main` ref: the merge base comes from local `main`.
  const fell = run(dir, SCOPED_BEFORE, { extra: ['--update'] });
  assert.equal(fell.code, 0, fell.out);
  assert.match(fell.out, /WARNING -- no merge base with origin\/main/);
  assert.match(fell.out, /fell back to local 'main'/);

  // Same tree with the remote-tracking ref present: no warning.
  git('update-ref', 'refs/remotes/origin/main', 'main');
  const clean = run(dir, SCOPED_BEFORE, { extra: ['--update'] });
  assert.equal(clean.code, 0, clean.out);
  assert.doesNotMatch(clean.out, /WARNING/);
  assert.match(clean.out, /vs origin\/main \(/);
});

// The docstring's remedy for growth inherited from main has been wrong three
// times: it named the scoped command (which cannot reach outside the branch's
// own files), then `-- --all` (which pnpm forwards verbatim and parseArgs
// rejected), then `--all` alone (which refuses to write, because re-recording a
// grown file is a raise). Prose describing a command is a claim about
// behaviour; these two pin the claim so the next rewrite has to agree with
// something executable.
test('--update --all alone refuses inherited growth rather than clearing it', () => {
  const dir = tree({ 'packages/a/big.ts': 520 });
  const { code, out } = run(dir, '   500 packages/a/big.ts\n', { extra: ['--update', '--all'] });
  assert.equal(code, 1, out);
  assert.match(out, /Nothing was written/);
});

test('--update --all --allow-raise is what actually clears inherited growth', () => {
  const dir = tree({ 'packages/a/big.ts': 520 });
  const { code, out, allowlistPath } = run(dir, '   500 packages/a/big.ts\n', {
    extra: ['--update', '--all', '--allow-raise'],
  });
  assert.equal(code, 0, out);
  assert.match(readFileSync(allowlistPath, 'utf8'), /520 packages\/a\/big\.ts/);
});

// A scoped regenerate used to print "Commit both." and exit 0 even when the
// gate stayed red for growth inherited from main — reporting success for a run
// that fixed nothing the contributor was failing on. The docstring described
// the case; the code exited 0 before ever re-evaluating what it wrote.
test('a scoped regenerate that leaves the gate red exits 1 and names the sweep', () => {
  // The growth must PREDATE the branch point, or it lands in the branch's own
  // diff and the scoped run correctly fixes it. slack.ts is committed on main
  // already over its recorded 460 budget; the branch touches only big.ts.
  const { dir, git } = gitTree({ 'packages/a/big.ts': 500, 'packages/b/slack.ts': 520 });
  git('checkout', '-q', '-b', 'feature');
  writeSource(dir, 'packages/a/big.ts', 520);

  const { code, out } = run(dir, SCOPED_BEFORE, { extra: ['--update', '--allow-raise'] });
  assert.equal(code, 1, out);
  assert.match(out, /the gate is STILL RED for\s+files outside this change's scope/);
  assert.match(out, /--all --allow-raise/);
});

// ---------------------------------------------------------------------------
// NO SELF-REWRITE CASES HERE ANY MORE (#3745). #3727/#3693 were about a run
// that measured scripts/check-module-size.mjs and then rewrote it in the same
// run: the ALLOWLIST_DIGESTS block lived in that file, so a sweep changing the
// scope count moved its line count after its row had been written. Removing the
// pin removes the rewrite, so those cases can no longer be built -- they needed
// a stand-in file with a pin block in it, and there is no pin to put in one.
// The settle step went with the pin (scripts/lib/module-size-self-pin.mjs is
// deleted in the same change): with no self-rewrite there is no fixed point to
// reach, and `--update` plans against a measurement the write cannot invalidate.
// The property those cases asserted end-to-end -- what --update writes, the next
// plain run accepts, with nothing done in between -- is asserted above by 'what
// --update writes is what the gate then accepts' and by the scoped --update
// cases.
// ---------------------------------------------------------------------------
