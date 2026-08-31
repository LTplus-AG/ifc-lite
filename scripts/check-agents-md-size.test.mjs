#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Black-box regression harness for scripts/check-agents-md-size.mjs, built the
 * same way as scripts/check-module-size.test.mjs: every case makes a synthetic
 * repository in a temp dir OUTSIDE this checkout, runs the unmodified checker
 * against it through `--root` / `--budgets`, and asserts the exit code AND the
 * message. Nothing here reads the checker's source, and nothing here touches
 * the real AGENTS.md.
 *
 * The fixtures are real `git init` repositories because discovery is
 * `git ls-files`, not a tree walk. That is not incidental: this checkout has
 * 171 registered worktrees and a filesystem walk of the primary one finds 103
 * AGENTS.md files against 6 tracked. `untracked AGENTS.md files are invisible`
 * below is the executable form of that claim.
 *
 * BOTH DIRECTIONS ARE PINNED for each tooth, because a gate that only ever
 * fails is as useless as one that only ever passes and neither is visible from
 * a green CI run: a file over budget fails and a file AT its budget passes; a
 * line one character over the limit fails and a line exactly AT the limit
 * passes; `--update` refuses a raise and accepts a lowering.
 *
 * Run: node --test scripts/check-agents-md-size.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-agents-md-size.mjs');

const cleanup = [];
process.on('exit', () => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

/** Markdown of exactly `bytes` bytes, in short lines. */
function doc(bytes) {
  const line = 'lorem ipsum dolor sit amet consectetur adipiscing elit\n';
  let out = '';
  while (out.length + line.length <= bytes) out += line;
  while (out.length < bytes) out += 'x';
  return out;
}

/** One line of exactly `chars` characters, plus a newline. */
function oneLine(chars) {
  return `${'a'.repeat(chars)}\n`;
}

function writeFile(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/**
 * A synthetic git repository: `tracked` files are added to the index, `loose`
 * files are written and left untracked. Nothing is committed — `git ls-files`
 * reads the index, and staying at zero commits keeps the fixture free of any
 * user.name/user.email requirement.
 */
function repo({ tracked = {}, loose = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agents-md-size-'));
  cleanup.push(dir);
  for (const [rel, content] of Object.entries(tracked)) writeFile(dir, rel, content);
  for (const [rel, content] of Object.entries(loose)) writeFile(dir, rel, content);
  const git = (...argv) => {
    const res = spawnSync('git', ['-C', dir, ...argv], { encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${argv.join(' ')}: ${res.stdout}${res.stderr}`);
    return res.stdout;
  };
  git('init', '-q', '-b', 'main');
  const paths = Object.keys(tracked);
  if (paths.length > 0) git('add', '--', ...paths);
  return dir;
}

function run(dir, budgetsText, extra = []) {
  const budgets = join(dir, 'budgets.txt');
  if (budgetsText !== null) writeFileSync(budgets, budgetsText);
  const res = spawnSync(process.execPath, [CHECKER, '--root', dir, '--budgets', budgets, ...extra], {
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}`, budgets };
}

const HEADER = '# budgets\n';

// --- tooth 1: the byte budget, in both directions -------------------------

test('a tracked EMPTY AGENTS.md round-trips instead of deadlocking', () => {
  // Both clamp guards, which shipped untested. parseAllowlist refuses `budget
  // <= 0`, so recording a 0-byte file at its true size wrote a row this gate's
  // own parser then rejects: --update exited 0 having written it and every later
  // run died with "bad budget in", with no way out but hand-editing. The check
  // branch had the twin defect, printing a permanent "1 bytes of headroom;
  // re-record with --update" note whose remedy is a no-op.
  const dir = repo({ tracked: { 'AGENTS.md': doc(100), 'sub/AGENTS.md': '' } });
  // Seeded with a real row: the parser fail-closes on a zero-row budget file,
  // so a header-only seed cannot bootstrap. That guard is correct and is not
  // what this test is about.
  const first = run(dir, `${HEADER}  6000 AGENTS.md\n`, ['--update']);
  assert.equal(first.code, 0, first.out);

  // The written row must be readable by the parser that wrote it.
  const check = run(dir, null);
  assert.equal(check.code, 0, check.out);
  assert.doesNotMatch(check.out, /bad budget in/);
  // ...and must not claim headroom it will never act on.
  assert.doesNotMatch(check.out, /sub\/AGENTS\.md.*bytes of headroom/);

  // A second --update changes nothing: the clamp is idempotent.
  const second = run(dir, null, ['--update']);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /0 lowered/);
});

test('a file at its recorded budget passes, and the run says what it measured', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(5000), 'rust/AGENTS.md': doc(1200) } });
  const { code, out } = run(dir, `${HEADER}5000 AGENTS.md\n1200 rust/AGENTS.md\n`);
  assert.equal(code, 0, out);
  assert.match(out, /2 tracked AGENTS\.md measured, 6200 bytes total, 2 budgeted, 0 over budget/);
});

test('a file ONE byte over its budget fails, and names the growth', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(5001) } });
  const { code, out } = run(dir, `${HEADER}5000 AGENTS.md\n`);
  assert.equal(code, 1);
  assert.match(out, /grew PAST their recorded budget/);
  assert.match(out, /AGENTS\.md: 5001 bytes, budget 5000 \(\+1\)/);
  // The two remedies must stay distinguishable: the growth you caused, and the
  // growth you inherited from main.
  assert.match(out, /Delete something rather than raising one/);
  assert.match(out, /git checkout origin\/main -- scripts\/agents-md-budget\.txt/);
});

test('the admission rule is quoted at the point of failure, not only in the docblock', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(5001) } });
  const { out } = run(dir, `${HEADER}5000 AGENTS.md\n`);
  assert.match(out, /if what you\s+added is a lesson a CI gate could express, build the gate/i);
  assert.match(out, /prose is only for what no gate can express/i);
});

test('a file UNDER its budget passes with an advisory note, never a failure', () => {
  // A shrink landing in someone else's PR must not redden this one.
  const dir = repo({ tracked: { 'AGENTS.md': doc(4000) } });
  const { code, out } = run(dir, `${HEADER}5000 AGENTS.md\n`);
  assert.equal(code, 0, out);
  assert.match(out, /note: {2}AGENTS\.md: 4000 bytes, budget 5000 \(1000 bytes of headroom\)/);
});

test('a budget row whose file is gone is an advisory note, not a failure', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(4000) } });
  const { code, out } = run(dir, `${HEADER}4000 AGENTS.md\n900 packages/gone/AGENTS.md\n`);
  assert.equal(code, 0, out);
  assert.match(out, /note: {2}packages\/gone\/AGENTS\.md \(budget 900\) is no longer a tracked file/);
});

// --- tooth 1b: a NEW AGENTS.md with no row --------------------------------

test('a new AGENTS.md over the 6000-byte default fails as an unrecorded exemption', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(4000), 'packages/new/AGENTS.md': doc(6001) } });
  const { code, out } = run(dir, `${HEADER}4000 AGENTS.md\n`);
  assert.equal(code, 1);
  assert.match(out, /New AGENTS\.md over the 6000-byte default/);
  assert.match(out, /packages\/new\/AGENTS\.md: 6001 bytes \(default 6000, \+1\)/);
  assert.match(out, /needs --allow-raise/);
});

test('a new AGENTS.md at the default is a different failure with a different remedy', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(4000), 'packages/new/AGENTS.md': doc(6000) } });
  const { code, out } = run(dir, `${HEADER}4000 AGENTS.md\n`);
  assert.equal(code, 1);
  assert.match(out, /Tracked AGENTS\.md with no budget row/);
  assert.match(out, /packages\/new\/AGENTS\.md: 6000 bytes, no row/);
  assert.match(out, /needs no\n--allow-raise/);
  // It must NOT be reported as an over-default exemption: same red, different
  // remedy, and conflating them would send the contributor to --allow-raise.
  assert.doesNotMatch(out, /over the 6000-byte default/);
});

// --- tooth 2: line length, in both directions -----------------------------

test('a line exactly at the 2000-character limit passes', () => {
  const dir = repo({ tracked: { 'AGENTS.md': oneLine(2000) } });
  const { code, out } = run(dir, `${HEADER}2001 AGENTS.md\n`);
  assert.equal(code, 0, out);
  assert.match(out, /0 lines over 2000 chars/);
});

test('a line ONE character over the limit fails, and is located by line number', () => {
  const dir = repo({ tracked: { 'AGENTS.md': `short\n${oneLine(2001)}also short\n` } });
  const { code, out } = run(dir, `${HEADER}9000 AGENTS.md\n`);
  assert.equal(code, 1);
  assert.match(out, /Line\(s\) over 2000 characters/);
  assert.match(out, /AGENTS\.md:2: 2001 characters \(limit 2000\)/);
  assert.match(out, /the only fix is to break the line up/);
});

test('a long line fails even when the file is well under budget', () => {
  // The teeth are independent: this is the defect the byte budget alone misses,
  // because one wall of prose can shrink and stay a wall.
  const dir = repo({ tracked: { 'AGENTS.md': oneLine(3000) } });
  const { code, out } = run(dir, `${HEADER}9000 AGENTS.md\n`);
  assert.equal(code, 1);
  assert.match(out, /AGENTS\.md:1: 3000 characters/);
  assert.doesNotMatch(out, /grew PAST/);
});

test('line length is measured in a NESTED AGENTS.md too', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(100), 'packages/x/AGENTS.md': oneLine(2500) } });
  const { code, out } = run(dir, `${HEADER}100 AGENTS.md\n2501 packages/x/AGENTS.md\n`);
  assert.equal(code, 1);
  assert.match(out, /packages\/x\/AGENTS\.md:1: 2500 characters/);
});

// --- discovery: tracked files only ----------------------------------------

test('untracked AGENTS.md files are invisible to the gate', () => {
  // The reason discovery is `git ls-files`: this checkout carries 171
  // worktrees, and a walk of the primary one finds 103 AGENTS.md against 6
  // tracked. Each loose file here would fail the gate if it were measured.
  const dir = repo({
    tracked: { 'AGENTS.md': doc(4000) },
    loose: {
      'wtbase/AGENTS.md': doc(90000),
      'node_modules/pkg/AGENTS.md': oneLine(9000),
      '.claude/worktrees/wt-1/AGENTS.md': doc(90000),
    },
  });
  const { code, out } = run(dir, `${HEADER}4000 AGENTS.md\n`);
  assert.equal(code, 0, out);
  assert.match(out, /1 tracked AGENTS\.md measured/);
});

test('a file named like AGENTS.md but not AGENTS.md is not an instruction file', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(4000), 'docs/OLD-AGENTS.md': doc(90000) } });
  const { code, out } = run(dir, `${HEADER}4000 AGENTS.md\n`);
  assert.equal(code, 0, out);
  assert.match(out, /1 tracked AGENTS\.md measured/);
});

// --- fail closed ----------------------------------------------------------

test('a root that is not a git worktree FAILS, it does not fall back to a walk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-md-nogit-'));
  cleanup.push(dir);
  writeFileSync(join(dir, 'AGENTS.md'), doc(90000));
  const { code, out } = run(dir, `${HEADER}4000 AGENTS.md\n`);
  assert.equal(code, 1);
  assert.match(out, /cannot list tracked AGENTS\.md files/);
  assert.match(out, /no fallback walk/);
});

test('tmpdir has no enclosing repository, so the fixtures cannot be reading this checkout', () => {
  // If tmpdir() were inside a git repo, every "untracked" case above would be
  // measuring that repo's index instead of the fixture's.
  const probe = spawnSync('git', ['-C', tmpdir(), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  assert.notEqual(probe.status, 0, `tmpdir() is inside a git worktree: ${probe.stdout}`);
});

test('a repository with no tracked AGENTS.md fails rather than certifying nothing', () => {
  const dir = repo({ tracked: { 'README.md': doc(100) } });
  const { code, out } = run(dir, `${HEADER}4000 AGENTS.md\n`);
  assert.equal(code, 1);
  assert.match(out, /no tracked AGENTS\.md found/);
  assert.match(out, /certify an instruction file nobody looked at/);
});

test('an empty budget file fails, and so does one that is all comments', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(100) } });
  assert.equal(run(dir, '').code, 1);
  const { code, out } = run(dir, '# nothing but a header\n');
  assert.equal(code, 1);
  assert.match(out, /parsed 0 rows/);
});

test('a malformed or duplicated budget row fails loudly', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(100) } });
  assert.match(run(dir, `${HEADER}notanumber AGENTS.md\n`).out, /bad budget in/);
  assert.match(run(dir, `${HEADER}100 AGENTS.md\n200 AGENTS.md\n`).out, /duplicate row for AGENTS\.md/);
});

// --- --update -------------------------------------------------------------

test('--update on a GROWN file refuses without --allow-raise and writes nothing', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(5001) } });
  const before = `${HEADER}5000 AGENTS.md\n`;
  const { code, out, budgets } = run(dir, before, ['--update']);
  assert.equal(code, 1);
  assert.match(out, /refusing to loosen the ratchet/);
  assert.match(out, /AGENTS\.md: 5001 bytes, budget 5000 \(\+1\)/);
  assert.match(out, /Nothing was written/);
  assert.equal(readFileSync(budgets, 'utf8'), before, 'the budget file must be byte-identical');
});

test('--update --allow-raise records the raise, and says RAISED', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(5001) } });
  const { code, out, budgets } = run(dir, `${HEADER}5000 AGENTS.md\n`, ['--update', '--allow-raise']);
  assert.equal(code, 0, out);
  assert.match(out, /RAISED: {2}AGENTS\.md: 5001 bytes, budget 5000 \(\+1\)/);
  assert.match(readFileSync(budgets, 'utf8'), /^ *5001 AGENTS\.md$/m);
});

test('--update LOWERS a shrunk row with no flag at all, and keeps the header', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(4000) } });
  const header = '# budgets\n# the rule: DELETE SOMETHING.\n';
  const { code, out, budgets } = run(dir, `${header}5000 AGENTS.md\n`, ['--update']);
  assert.equal(code, 0, out);
  assert.match(out, /lowered: {2}AGENTS\.md: 4000 bytes, budget 5000 \(-1000\)/);
  const written = readFileSync(budgets, 'utf8');
  assert.ok(written.startsWith(header), `header was not carried over:\n${written}`);
  assert.match(written, /^ *4000 AGENTS\.md$/m);
});

test('--update ADDS a row for a new under-default file without --allow-raise', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(4000), 'packages/new/AGENTS.md': doc(1500) } });
  const { code, out, budgets } = run(dir, `${HEADER}4000 AGENTS.md\n`, ['--update']);
  assert.equal(code, 0, out);
  assert.match(out, /lowered: {2}packages\/new\/AGENTS\.md: 1500 bytes \(new row, was the 6000-byte default\)/);
  assert.match(readFileSync(budgets, 'utf8'), /^ *1500 packages\/new\/AGENTS\.md$/m);
});

test('--update REFUSES a new over-default file without --allow-raise', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(4000), 'packages/new/AGENTS.md': doc(6001) } });
  const before = `${HEADER}4000 AGENTS.md\n`;
  const { code, out, budgets } = run(dir, before, ['--update']);
  assert.equal(code, 1);
  assert.match(out, /new exemption/);
  assert.match(out, /packages\/new\/AGENTS\.md: 6001 bytes \(new row, over the 6000-byte default\)/);
  assert.equal(readFileSync(budgets, 'utf8'), before);
});

test('--update drops a row whose file is no longer tracked', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(4000) } });
  const { code, out, budgets } = run(dir, `${HEADER}4000 AGENTS.md\n900 packages/gone/AGENTS.md\n`, [
    '--update',
  ]);
  assert.equal(code, 0, out);
  assert.match(out, /removed: {2}packages\/gone\/AGENTS\.md \(budget 900\) is no longer a tracked file/);
  assert.doesNotMatch(readFileSync(budgets, 'utf8'), /packages\/gone/);
});

test('--update re-records budgets but still EXITS 1 while a long line remains', () => {
  // A regenerate that printed success over a red gate is the defect this repo
  // keeps rediscovering. `--update` cannot break a paragraph up, and must not
  // pretend the gate is green because the byte rows are now correct.
  const dir = repo({ tracked: { 'AGENTS.md': `${oneLine(2500)}${doc(1000)}` } });
  const bytes = statSync(join(dir, 'AGENTS.md')).size;
  const { code, out, budgets } = run(dir, `${HEADER}9000 AGENTS.md\n`, ['--update']);
  assert.equal(code, 1);
  assert.match(out, /wrote 1 rows/);
  assert.match(out, /STILL RED on line length/);
  assert.match(out, /AGENTS\.md:1: 2500 characters/);
  assert.match(readFileSync(budgets, 'utf8'), new RegExp(`^ *${bytes} AGENTS\\.md$`, 'm'));
});

// --- argument handling ----------------------------------------------------

test('--allow-raise without --update is refused rather than silently ignored', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(100) } });
  const { code, out } = run(dir, `${HEADER}100 AGENTS.md\n`, ['--allow-raise']);
  assert.equal(code, 1);
  assert.match(out, /--allow-raise only means something with --update/);
});

test('an unknown argument fails instead of being ignored', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(100) } });
  const { code, out } = run(dir, `${HEADER}100 AGENTS.md\n`, ['--all']);
  assert.equal(code, 1);
  assert.match(out, /unknown argument: --all/);
});

test('a bare `--` is tolerated, because pnpm forwards it verbatim', () => {
  const dir = repo({ tracked: { 'AGENTS.md': doc(100) } });
  const { code, out } = run(dir, `${HEADER}100 AGENTS.md\n`, ['--', '--update']);
  assert.equal(code, 0, out);
  assert.match(out, /wrote 1 rows/);
});

// --- the committed baseline ------------------------------------------------

test('the committed budget file parses and covers every tracked AGENTS.md', () => {
  // Not a size assertion — the real budgets move. This pins that the shipped
  // baseline is well formed and that no tracked instruction file is missing
  // from it, which is the one property a `--update` cannot restore for you.
  const text = readFileSync(join(ROOT, 'scripts', 'agents-md-budget.txt'), 'utf8');
  const rows = new Map(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => {
        const [budget, path] = l.split(/\s+/);
        return [path, Number(budget)];
      }),
  );
  assert.ok(rows.size >= 6, `expected at least 6 rows, got ${rows.size}`);
  const tracked = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--', '*AGENTS.md', 'AGENTS.md'], {
    encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  for (const rel of tracked.stdout.split('\0').filter((p) => /(^|\/)AGENTS\.md$/.test(p))) {
    assert.ok(rows.has(rel), `${rel} is tracked but has no budget row`);
  }
});
