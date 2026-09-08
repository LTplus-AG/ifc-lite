#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for the allowlist IDENTITY check in
 * scripts/check-source-text-assertions.mjs (#3664).
 *
 * ALLOWLIST_CEILING is a count, and a count cannot tell "one row removed, a
 * different row added" apart from "nothing changed" -- both leave
 * allowlist.size exactly where it was. This check compares the current
 * allowlist against the one committed at this branch's merge base and fails
 * when a path is present now that was not present there, regardless of
 * whether the total size moved.
 *
 * Method mirrors scripts/check-module-size.test.mjs's `gitTree()`: each case
 * builds a REAL git repository in a temp dir outside this checkout (so the
 * derivation cannot quietly read this repo's own history), commits a "base"
 * state, checks out a "feature" branch, mutates the allowlist and re-runs the
 * UNMODIFIED gate via `--root`. Nothing here reads the gate's source.
 *
 * Fixture test files use the same read-then-.includes shape the gate's own
 * detector tests pin, so `analyze()` flags them without needing the full
 * repo's TEST_FILE_RE tree layout beyond `packages/`, `apps/`, `scripts/`.
 *
 * Run: node --test scripts/check-source-text-assertions-identity.test.mjs
 * (a named step of the CI node-test job, and covered by its glob catch-all).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(ROOT, 'scripts', 'check-source-text-assertions.mjs');
const DETECT = join(ROOT, 'scripts', 'source-text-assertion-detect.mjs');

/** A source-text-assertion test fixture the detector flags, naming `rel`. */
function violatingTest(rel) {
  return `import { readFileSync } from 'node:fs';
const p = '${rel}';
const source = readFileSync(p, 'utf8');
assert.ok(source.includes('someCall('));
`;
}

const cleanup = [];
process.on('exit', () => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

/**
 * A real git repo, outside any enclosing repository, with `files` (a map of
 * relative test-file path -> the .txt allowlist content to commit alongside
 * them, keyed 'allowlist') committed on `main`.
 */
function gitTree(testFiles, allowlistText) {
  const dir = mkdtempSync(join(tmpdir(), 'source-text-identity-'));
  cleanup.push(dir);
  for (const d of ['packages', 'apps', 'scripts']) mkdirSync(join(dir, d), { recursive: true });
  for (const [rel, content] of Object.entries(testFiles)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'source-text-assertion-allowlist.txt'), allowlistText);
  // The gate reads its own ceiling constant out of ITS base-revision source,
  // so the synthetic tree needs a copy of the real gate under the same path.
  // Copying the file under test, rather than writing a stub, is the point:
  // the identity check's own ceiling-parsing regex is exercised against the
  // real file, not a hand-written approximation of it.
  // The detector import is repointed at the REAL file's absolute path rather
  // than copied alongside: it pulls in `typescript` from this repo's
  // node_modules, which a temp dir outside the repo cannot resolve, and
  // nothing under test here is the detector itself (that has its own harness,
  // scripts/check-source-text-assertions.test.mjs).
  const gateSrc = readFileSync(GATE, 'utf8').replace(
    "from './source-text-assertion-detect.mjs'",
    `from ${JSON.stringify(pathToFileURL(DETECT).href)}`,
  );
  assert.notEqual(gateSrc, readFileSync(GATE, 'utf8'), 'detector import rewrite did not match');
  writeFileSync(join(dir, 'scripts', 'check-source-text-assertions.mjs'), gateSrc);

  const git = (...argv) => {
    const res = spawnSync('git', ['-C', dir, ...argv], { encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${argv.join(' ')}: ${res.stdout}${res.stderr}`);
    return res.stdout;
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ratchet@example.invalid');
  git('config', 'user.name', 'ratchet test');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { dir, git };
}

// The GATE IN THE TREE, not the real one at ROOT: ALLOWLIST_CEILING is a
// constant compiled into the script, not a value it reads from the tree it
// scans, so a case that varies the ceiling has to run the mutated COPY.
// `--root` still points scanning (SEARCH_DIRS, ALLOWLIST_PATH) at `dir`.
function run(dir) {
  const gateCopy = join(dir, 'scripts', 'check-source-text-assertions.mjs');
  const res = spawnSync(process.execPath, [gateCopy, '--root', dir], { encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

/** Sets ALLOWLIST_CEILING in the gate copy at `dir/scripts/...mjs` to `n`. */
function setCeiling(dir, n) {
  const path = join(dir, 'scripts', 'check-source-text-assertions.mjs');
  const src = readFileSync(path, 'utf8');
  const next = src.replace(/const ALLOWLIST_CEILING = \d+;/, `const ALLOWLIST_CEILING = ${n};`);
  assert.notEqual(next, src, 'ceiling regex did not match the real gate source');
  writeFileSync(path, next);
}

const A_TEST = 'apps/v/a.test.ts';
const B_TEST = 'apps/v/b.test.ts';

test('a same-size swap (A removed, B added, ceiling untouched) fails', () => {
  const { dir, git } = gitTree(
    { [A_TEST]: violatingTest(A_TEST) },
    `${A_TEST}  # cannot convert yet\n`,
  );
  setCeiling(dir, 1);
  git('add', '-A');
  git('commit', '-qm', 'set ceiling to 1');

  git('checkout', '-q', '-b', 'feature');
  // Convert A behaviourally (delete the violating fixture) and introduce a
  // DIFFERENT violation, B, keeping the allowlist at exactly 1 row.
  unlinkSync(join(dir, A_TEST));
  const bFull = join(dir, B_TEST);
  mkdirSync(dirname(bFull), { recursive: true });
  writeFileSync(bFull, violatingTest(B_TEST));
  writeFileSync(join(dir, 'scripts', 'source-text-assertion-allowlist.txt'), `${B_TEST}  # swapped in\n`);
  git('add', '-A');
  git('commit', '-qm', 'swap A for B, same size');

  const { code, out } = run(dir);
  assert.equal(code, 1, out);
  assert.match(out, /New allowlist entries not present at the merge base/);
  assert.match(out, new RegExp(B_TEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // A must NOT be reported as a new entry -- it was removed, not added.
  assert.doesNotMatch(out.split('New allowlist entries')[1] ?? '', /apps\/v\/a\.test\.ts\n/);
});

test('removing an entry outright (no replacement, ceiling lowered) passes', () => {
  const { dir, git } = gitTree(
    { [A_TEST]: violatingTest(A_TEST), [B_TEST]: violatingTest(B_TEST) },
    `${A_TEST}  # cannot convert yet\n${B_TEST}  # cannot convert yet\n`,
  );
  setCeiling(dir, 2);
  git('add', '-A');
  git('commit', '-qm', 'set ceiling to 2');

  git('checkout', '-q', '-b', 'feature');
  unlinkSync(join(dir, A_TEST));
  writeFileSync(join(dir, 'scripts', 'source-text-assertion-allowlist.txt'), `${B_TEST}  # cannot convert yet\n`);
  setCeiling(dir, 1);
  git('add', '-A');
  git('commit', '-qm', 'convert A, lower ceiling');

  const { code, out } = run(dir);
  assert.equal(code, 0, out);
  assert.match(out, /check-source-text-assertions: OK \(1 allowlisted, 0 marked, 0 new\)/);
});

test('an untouched allowlist and tree passes with no identity failure', () => {
  const { dir, git } = gitTree(
    { [A_TEST]: violatingTest(A_TEST) },
    `${A_TEST}  # cannot convert yet\n`,
  );
  setCeiling(dir, 1);
  git('add', '-A');
  git('commit', '-qm', 'set ceiling to 1');

  git('checkout', '-q', '-b', 'feature');
  // No changes at all on the feature branch.
  const { code, out } = run(dir);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /New allowlist entries/);
});

test('a genuinely new violation with no allowlist row still fails as before', () => {
  const { dir, git } = gitTree({}, '');
  setCeiling(dir, 0);
  git('add', '-A');
  git('commit', '-qm', 'set ceiling to 0');

  git('checkout', '-q', '-b', 'feature');
  const full = join(dir, A_TEST);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, violatingTest(A_TEST));
  git('add', '-A');
  git('commit', '-qm', 'add a violation, no allowlist row');

  const { code, out } = run(dir);
  assert.equal(code, 1, out);
  assert.match(out, /Source-text assertions found in NEW test files/);
  assert.doesNotMatch(out, /New allowlist entries not present at the merge base/);
});

test('a pure addition (ceiling raised to cover it, nothing removed) passes', () => {
  const { dir, git } = gitTree(
    { [A_TEST]: violatingTest(A_TEST) },
    `${A_TEST}  # cannot convert yet\n`,
  );
  setCeiling(dir, 1);
  git('add', '-A');
  git('commit', '-qm', 'set ceiling to 1');

  git('checkout', '-q', '-b', 'feature');
  const full = join(dir, B_TEST);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, violatingTest(B_TEST));
  writeFileSync(
    join(dir, 'scripts', 'source-text-assertion-allowlist.txt'),
    `${A_TEST}  # cannot convert yet\n${B_TEST}  # newly discovered, out of reach\n`,
  );
  setCeiling(dir, 2);
  git('add', '-A');
  git('commit', '-qm', 'add B, raise ceiling to 2');

  const { code, out } = run(dir);
  assert.equal(code, 0, out);
  assert.match(out, /check-source-text-assertions: OK \(2 allowlisted, 0 marked, 0 new\)/);
});

test('no origin/main and no local main: identity check degrades with a warning, not an error', () => {
  const { dir } = gitTree(
    { [A_TEST]: violatingTest(A_TEST) },
    `${A_TEST}  # cannot convert yet\n`,
  );
  setCeiling(dir, 1);
  const gitCommit = spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
  assert.equal(gitCommit.status, 0, gitCommit.stdout + gitCommit.stderr);
  const commit = spawnSync('git', ['-C', dir, 'commit', '-qm', 'only commit, branch is main'], {
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, commit.stdout + commit.stderr);
  // HEAD IS main here (no divergent branch), so `merge-base main HEAD` trivially
  // resolves to HEAD itself -- to genuinely exercise "no base resolvable", rename
  // the branch so neither `origin/main` nor `main` exists.
  const rename = spawnSync('git', ['-C', dir, 'branch', '-m', 'main', 'not-main'], { encoding: 'utf8' });
  assert.equal(rename.status, 0, rename.stdout + rename.stderr);

  const { code, out } = run(dir);
  assert.equal(code, 0, out);
  assert.match(out, /WARNING -- could not resolve a merge base/);
  assert.doesNotMatch(out, /New allowlist entries/);
});
