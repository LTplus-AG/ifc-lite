#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for the `extends` path typecheck-tests.mjs writes into
 * every generated tsconfig.tests.json.
 *
 * The defect pinned here (#2664 review): the value came straight from
 * `path.relative()`, which returns a BARE `tsconfig.tests.base.json` whenever
 * the generated program sits next to the base config — i.e. whenever the
 * program is written at the repo root. tsc resolves a bare `extends` as a NODE
 * MODULE, not a path, so the base config was not found (TS6053) and the
 * `noEmit` it carries never applied. Confirmed with a two-file control: an
 * otherwise identical program with a bare extends emitted `a.js`; the
 * `./`-prefixed one emitted nothing. Combined with the CLI ignoring an
 * unrecognised argument, `node scripts/typecheck-tests.mjs packages/clash`
 * from the repo root left 9,609 untracked .js/.d.ts/.map files in the source
 * tree.
 *
 * Nothing about this is visible in normal use — the config parses, tsc runs,
 * every package under packages/ happens to get a `../../`-prefixed path that
 * resolves fine — which is exactly why it needs a test rather than a comment.
 *
 * A second group at the bottom covers anti-vacuity rather than `extends`
 * semantics: `--audit` used to print a success line after measuring nothing.
 *
 * Run: node --test scripts/typecheck-tests.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relativeExtends, parseCliMode, auditVacuity, audit } from './typecheck-tests.mjs';

test('a sibling base config is ./-prefixed, not bare', () => {
  // The repo-root case: pkgDir and the base config are the same directory.
  const root = path.resolve('/repo');
  assert.equal(
    relativeExtends(root, path.join(root, 'tsconfig.tests.base.json')),
    './tsconfig.tests.base.json',
  );
});

test('a base config above the package keeps its ../ prefix untouched', () => {
  // The packages/* case, which always worked and must keep working.
  const root = path.resolve('/repo');
  assert.equal(
    relativeExtends(path.join(root, 'packages', 'clash'), path.join(root, 'tsconfig.tests.base.json')),
    '../../tsconfig.tests.base.json',
  );
});

test('a base config in a subdirectory is ./-prefixed', () => {
  const root = path.resolve('/repo');
  assert.equal(
    relativeExtends(root, path.join(root, 'config', 'tsconfig.tests.base.json')),
    './config/tsconfig.tests.base.json',
  );
});

test('every result tsc would treat as a path, does start with . ', () => {
  // The property that actually matters: tsc treats `extends` as a relative
  // path only when it begins with `./` or `../`. Anything else is a package
  // name. Assert the property directly, not just the three cases above.
  const root = path.resolve('/repo');
  const targets = [
    path.join(root, 'tsconfig.tests.base.json'),
    path.join(root, 'a', 'tsconfig.tests.base.json'),
  ];
  const froms = [root, path.join(root, 'packages', 'clash'), path.join(root, 'apps', 'viewer')];
  for (const from of froms) {
    for (const target of targets) {
      const value = relativeExtends(from, target);
      assert.ok(
        value.startsWith('./') || value.startsWith('../'),
        `${value} (from ${from}) would be resolved as a node module, not a path`,
      );
    }
  }
});

// ---- CLI argument parsing (#2664 review).
//
// The unrecognised-argument guard added in this PR only ever looked at
// argv[2], so it caught `typecheck-tests.mjs packages/clash` but not
// `typecheck-tests.mjs --all packages/clash` — the trailing argument was
// dropped and all-package mode ran anyway. That is the same silent
// substitution the guard exists to stop: the caller asked for one package
// and got a repo-wide run, which is precisely how the 9,609 stray emitted
// files above were produced. Every accepted shape is enumerated here so a
// future argument can't be added by accident.

test('no arguments selects the cwd-driven per-package mode', () => {
  assert.deepEqual(parseCliMode([]), { mode: 'package' });
});

test('--all alone selects all-package mode', () => {
  assert.deepEqual(parseCliMode(['--all']), { mode: 'all' });
});

test('--audit alone selects audit mode', () => {
  assert.deepEqual(parseCliMode(['--audit']), { mode: 'audit' });
});

test('a bare package argument is rejected, not silently treated as cwd', () => {
  const result = parseCliMode(['packages/clash']);
  assert.ok('error' in result, 'a package argument must not select a mode');
  assert.match(result.error, /packages\/clash/);
});

test('a trailing argument after --all is rejected, not ignored', () => {
  const result = parseCliMode(['--all', 'packages/clash']);
  assert.ok('error' in result, '--all with a trailing argument must not run all-package mode');
  assert.match(result.error, /packages\/clash/);
});

test('a trailing argument after --audit is rejected, not ignored', () => {
  const result = parseCliMode(['--audit', 'packages/clash']);
  assert.ok('error' in result, '--audit with a trailing argument must not run audit mode');
  assert.match(result.error, /packages\/clash/);
});

test('--all and --audit together are rejected: they are different runs', () => {
  const result = parseCliMode(['--all', '--audit']);
  assert.ok('error' in result, 'two modes at once must not silently pick one');
});

test('a repeated flag is rejected too', () => {
  assert.ok('error' in parseCliMode(['--all', '--all']));
});

test('every rejection names the offending argument, so the message is actionable', () => {
  for (const args of [['packages/clash'], ['--all', 'packages/clash'], ['--audit', 'packages/clash'], ['-h']]) {
    const result = parseCliMode(args);
    assert.ok('error' in result, `${args.join(' ')} must be rejected`);
    const offender = args[args.length - 1];
    assert.ok(
      result.error.includes(offender),
      `error for "${args.join(' ')}" must name ${offender}, got: ${result.error}`,
    );
  }
});

// --- Anti-vacuity: an audit that measured nothing must not report a clean run ---
//
// `--audit` used to print `TOTAL 0 / 0` and `every test file on disk is in a
// typecheck program.` with exit 0 when it found no packages at all, so CI read
// "we looked and it was clean" from a run that had looked at nothing. The
// audit takes no `--root` (REPO_ROOT comes from the script's own location), so
// the end-to-end reproduction is a copy of the script run from an empty tree;
// `auditVacuity` is the decision that reproduction exercises, driven directly
// here so every branch has a case.

test('vacuity: no package parent at all is a refusal, not a clean audit', () => {
  const msg = auditVacuity({ seenParents: [], packagesWithTests: null, testFiles: null });
  assert.ok(msg, 'a tree with neither packages/ nor apps/ must be refused');
  assert.match(msg, /Refusing a vacuous pass/);
  assert.match(msg, /none of packages\/, apps\/ exists/);
});

test('vacuity: package parents that hold no tests are a refusal', () => {
  const msg = auditVacuity({ seenParents: ['packages', 'apps'], packagesWithTests: 0, testFiles: 0 });
  assert.ok(msg, 'zero packages carrying tests must be refused');
  assert.match(msg, /Refusing a vacuous pass/);
  assert.match(msg, /no package with a test file/);
});

test('vacuity: the structural pass runs before any count exists', () => {
  // Called once before the walk, when the counts are still unknown: only the
  // "nowhere to look" branch may fire, and a healthy parent list must not.
  assert.equal(
    auditVacuity({ seenParents: ['packages', 'apps'], packagesWithTests: null, testFiles: null }),
    null,
  );
});

test('vacuity: a package count far under the floor is a refusal', () => {
  const msg = auditVacuity({ seenParents: ['packages', 'apps'], packagesWithTests: 2, testFiles: 40 });
  assert.ok(msg, 'two packages is a collapsed walk, not a shrunken repo');
  assert.match(msg, /only 2 package\(s\) carried test files, floor is 30/);
  // The remedy must name the constant to change, so the fix is not a guess.
  assert.match(msg, /AUDITED_PACKAGES_FLOOR/);
});

test('vacuity: a healthy package count with a collapsed test-file count is still a refusal', () => {
  // The two floors are independent on purpose: the package enumeration can
  // work while findTestFiles/TEST_FILE_RE stops recognising test files, and
  // that leaves the package number looking entirely healthy.
  const msg = auditVacuity({ seenParents: ['packages', 'apps'], packagesWithTests: 46, testFiles: 10 });
  assert.ok(msg, 'a healthy package count must not excuse an empty test-file count');
  assert.match(msg, /only 10 test file\(s\) found, floor is 900/);
  assert.match(msg, /TEST_FILES_FLOOR/);
});

test('vacuity: the real repo\'s measured counts pass', () => {
  // 46 packages / 1,434 test files as measured on a healthy tree. If this ever
  // fails, the floors were raised past what the repo actually has.
  assert.equal(
    auditVacuity({ seenParents: ['packages', 'apps'], packagesWithTests: 46, testFiles: 1434 }),
    null,
  );
});

// ---------------------------------------------------------------------------
// The guards, driven END TO END through audit().
//
// Everything above calls `auditVacuity` directly, which proves the function is
// right and proves NOTHING about whether the gate still calls it. The #3201
// review demonstrated the gap by deleting the quantitative block from
// `audit()`: the whole suite stayed green while the gate went back to calling a
// collapsed two-package walk clean. These tests fail if any of the four call
// sites is removed, because they exercise the refusals through `audit()`
// itself against a synthetic tree.

/**
 * Run `audit()` and return its exit code together with everything it wrote to
 * stderr. Asserting the exit code alone is not enough: `audit()` also returns 1
 * from the offenders check, which fires BEFORE the quantitative floors, so a
 * test that only checked for 1 would pass on a tree that never reached the
 * guard it claims to exercise. The refusal text is what identifies the branch.
 */
async function runAudit(opts) {
  const stderr = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (...args) => stderr.push(args.join(' '));
  console.log = () => {};
  try {
    const code = await audit(opts);
    return { code, stderr: stderr.join('\n') };
  } finally {
    console.error = realError;
    console.log = realLog;
  }
}

/** Build a throwaway workspace and return its root. */
function synthTree(spec) {
  const root = mkdtempSync(path.join(tmpdir(), 'typecheck-tests-audit-'));
  for (const [rel, contents] of Object.entries(spec)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

/** One `apps/<name>` package carrying a single test file. */
function appWithOneTest(name) {
  return {
    [`apps/${name}/package.json`]: JSON.stringify({ name, scripts: { typecheck: 'tsc' } }),
    [`apps/${name}/tsconfig.json`]: JSON.stringify({
      compilerOptions: { noEmit: true },
      files: ['./src/a.test.ts'],
    }),
    [`apps/${name}/src/a.test.ts`]: 'export const a = 1;\n',
  };
}

test('audit(): an empty tree is refused, not reported as a clean scan', async () => {
  const root = synthTree({ 'README.md': 'no package parents here\n' });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root });
    assert.equal(code, 1);
    assert.match(stderr, /none of packages\/, apps\/ exists under/);
    assert.match(stderr, /Refusing a vacuous pass/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit(): package parents that exist but hold no tests are refused', async () => {
  const root = synthTree({ 'apps/.keep': '', 'packages/.keep': '' });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root });
    assert.equal(code, 1);
    assert.match(stderr, /contain no package with a test file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit(): a partial collapse is refused by the package floor', async () => {
  // The case the empty-tree guards cannot see, and the one the floors exist
  // for: the walk works, finds real packages with real tests, and every file
  // it found IS in a program — but it found two packages instead of 46.
  const root = synthTree({ ...appWithOneTest('one'), ...appWithOneTest('two') });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root });
    assert.equal(code, 1);
    assert.match(stderr, /only 2 package\(s\) carried test files, floor is 30/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit(): a partial collapse is refused by the test-file floor too', async () => {
  // Same tree, package floor lowered so it cannot be what fires. The refusal
  // must still come, from the independent test-file floor.
  const root = synthTree({ ...appWithOneTest('one'), ...appWithOneTest('two') });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root, packagesFloor: 1 });
    assert.equal(code, 1);
    assert.match(stderr, /only 2 test file\(s\) found, floor is 900/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit(): the same tree passes once both floors are below what it holds', async () => {
  // The paired probe. Without this, every assertion above could be satisfied
  // by an audit() that returns 1 unconditionally on a synthetic tree.
  const root = synthTree({ ...appWithOneTest('one'), ...appWithOneTest('two') });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root, packagesFloor: 1, testFilesFloor: 1 });
    assert.equal(code, 0, `expected a clean audit, got: ${stderr}`);
    assert.equal(stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
