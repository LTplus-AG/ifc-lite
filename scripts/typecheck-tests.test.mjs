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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { relativeExtends, parseCliMode, auditVacuity, audit, repoRootRefusal } from './typecheck-tests.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  assert.ok(msg, 'a tree with none of the workspace parents must be refused');
  assert.match(msg, /Refusing a vacuous pass/);
  assert.match(msg, /none of packages\/, apps\/ and examples\/ exists/);
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

/**
 * One `<parent>/<name>` workspace member carrying a single test file, wired so
 * the audit can resolve a program for it: a package.json with the `scripts` it
 * is given, and a tsconfig whose `files` already lists the test.
 */
function memberWithOneTest(parent, name, scripts = { typecheck: 'tsc' }) {
  return {
    [`${parent}/${name}/package.json`]: JSON.stringify({ name, scripts }),
    [`${parent}/${name}/tsconfig.json`]: JSON.stringify({
      compilerOptions: { noEmit: true },
      files: ['./src/a.test.ts'],
    }),
    [`${parent}/${name}/src/a.test.ts`]: 'export const a = 1;\n',
  };
}

/** One `apps/<name>` package carrying a single test file. */
function appWithOneTest(name) {
  return memberWithOneTest('apps', name);
}

test('audit(): an empty tree is refused, not reported as a clean scan', async () => {
  const root = synthTree({ 'README.md': 'no package parents here\n' });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root });
    assert.equal(code, 1);
    assert.match(stderr, /none of packages\/, apps\/ and examples\/ exists under/);
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

test('audit(): a package with tests but no tsconfig.json is a failure, not a silent skip', async () => {
  // #3201 review finding 3. workspaceDirs skips a directory missing either
  // tsconfig.json or package.json. Before this check, the tests inside such a
  // directory were never counted and never mentioned, while the success line
  // still claimed every test file under packages/ and apps/ was in a program.
  const root = synthTree({
    ...appWithOneTest('one'),
    ...appWithOneTest('two'),
    'packages/zz-unwired/package.json': JSON.stringify({ name: 'zz-unwired' }),
    'packages/zz-unwired/src/thing.test.ts': "const x: number = 'not a number';\n",
  });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root, packagesFloor: 1, testFilesFloor: 1 });
    assert.equal(code, 1, 'a test file in an unauditable directory must fail the gate');
    assert.match(stderr, /packages\/zz-unwired: 1 test file\(s\) on disk but no tsconfig\.json/);
    // #3201 review finding 4: adding the tsconfig.json this message asks for
    // promotes the directory into the walk, which then reds for a missing
    // "typecheck" script — two CI runs for one fix. The remedy has to name
    // both, so the message is asserted to mention the second one.
    assert.match(stderr, /also needs a "typecheck" script/);
    assert.match(stderr, /typecheck-tests\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit(): a directory missing both files is named for both', async () => {
  const root = synthTree({
    ...appWithOneTest('one'),
    'packages/zz-loose/src/thing.test.ts': 'export const x = 1;\n',
  });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root, packagesFloor: 1, testFilesFloor: 1 });
    assert.equal(code, 1);
    assert.match(stderr, /no tsconfig\.json and no package\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit(): an unauditable directory with no tests is not a failure', async () => {
  // The paired probe: the check must fire on stray TESTS, not on every
  // directory that lacks a tsconfig. `packages/wasm` and `apps/landing` are
  // real examples in this repo today, and neither carries a file this audit's
  // TEST_FILE_RE matches.
  //
  // The two are not the same case, and the distinction matters. `apps/landing`
  // has no test file at all. `packages/wasm` carries FIVE — package.test.mjs,
  // styling-indexed-colour-split.test.mjs, tessellation-quality.test.mjs,
  // textures.test.mjs, type-only-geometry.test.mjs — run by its own
  // `"test": "node --test test/*.test.mjs"`. They are outside this gate's
  // remit rather than absent: TEST_FILE_RE is /\.test\.(ts|tsx|mts|cts)$/, and
  // .mjs needs no typechecking. That they are genuinely executed is asserted
  // elsewhere — check-test-glob-coverage.mjs audits 47 packages to this gate's
  // 46 and reports zero unrun test files.
  const root = synthTree({
    ...appWithOneTest('one'),
    'packages/zz-nobuild/package.json': JSON.stringify({ name: 'zz-nobuild' }),
    'packages/zz-nobuild/src/thing.ts': 'export const x = 1;\n',
  });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root, packagesFloor: 1, testFilesFloor: 1 });
    assert.equal(code, 0, `expected a clean audit, got: ${stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- examples/* is a package parent too (#3201 review finding 3) ---
//
// pnpm-workspace.yaml lists THREE parents — `packages/*`, `apps/*` and
// `examples/*` — and PACKAGE_PARENTS covered the first two. That gap is the
// same shape as the skipped-directory bug this PR fixes, one level further
// out and strictly worse: an unwatched PARENT is not a skipped DIRECTORY, so
// the "look inside every skipped directory" check never reached it either.
// `examples/babylonjs-viewer` and `examples/collab-demo` are full TypeScript
// workspace members; a test at `examples/collab-demo/src/foo.test.ts` was
// invisible to this gate rather than reported by it. (`find examples -name
// '*.test.*'` returns 0 today, so there was no live offender — which is
// exactly why only a test can keep it closed.)

test('audit(): a test file under examples/ is audited, not invisible', async () => {
  const root = synthTree({
    ...appWithOneTest('one'),
    // A real examples member as they exist today: no `typecheck` script.
    ...memberWithOneTest('examples', 'demo', { dev: 'vite' }),
  });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root, packagesFloor: 1, testFilesFloor: 1 });
    assert.equal(code, 1, 'a test file under examples/ with no typecheck script must fail the gate');
    assert.match(stderr, /examples\/demo: 1 test file\(s\) on disk but no "typecheck" script/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit(): a wired examples member passes and is counted', async () => {
  // The paired probe. Without it the assertion above is satisfied by any
  // audit() that refuses everything under examples/, and the widened scope
  // would be a new way to go red rather than a new thing to see.
  const root = synthTree({ ...appWithOneTest('one'), ...memberWithOneTest('examples', 'demo') });
  try {
    const { code, stderr } = await runAudit({ scanRoot: root, packagesFloor: 2, testFilesFloor: 2 });
    // packagesFloor 2 / testFilesFloor 2 are the load-bearing part: they pass
    // only if examples/demo was walked and COUNTED, not merely tolerated.
    assert.equal(code, 0, `expected a clean audit, got: ${stderr}`);
    assert.equal(stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit(): an empty tree names every parent it looked for', async () => {
  // The refusal has to be actionable, and it is the only place the scanned
  // parents are spelled out for a reader. If PACKAGE_PARENTS grows again,
  // this fails until the message follows.
  const root = synthTree({ 'README.md': 'no package parents here\n' });
  try {
    const { stderr } = await runAudit({ scanRoot: root });
    assert.match(stderr, /none of packages\/, apps\/ and examples\/ exists under/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- The repo root is not a package (#3362).
//
// `parseCliMode` already refuses the ARGUMENT form of this mistake: `node
// scripts/typecheck-tests.mjs packages/clash` from the root used to ignore its
// argument and fall through to the cwd branch. The CWD form is the same
// substitution with the argument left off, and it was still open: zero
// arguments is a legal `package` mode, so `checkOnePackage(process.cwd())` read
// the REPOSITORY as the package. Measured on this tree before the guard, from
// the repo root with no arguments:
//
//   tsconfig.tests.json written at the repo root: 1,520 lines, 1,505 test
//   files listed, and not one line of output while it happened.
//
// #3363 gitignored that path — correct for diff noise, and it removed the last
// visible symptom, which is why the guard has to exist rather than the file
// being noticed.
//
// The unit cases below pin the path arithmetic; the spawn case below them pins
// that `checkOnePackage` actually consults it, which is the half a guard placed
// only in `parseCliMode` would leave undone.

test('the repo root itself is refused (issue 3362)', () => {
  const message = repoRootRefusal('/repo', '/repo');
  assert.ok(message, 'the repo root must be refused, not treated as a package');
  assert.match(message, /refusing to treat the repository root as a package/);
});

test('the refusal says what the caller probably meant (issue 3362)', () => {
  const message = repoRootRefusal('/repo', '/repo');
  assert.match(message, /--audit/, 'names the repo-wide coverage gate');
  assert.match(message, /--all/, 'names the every-package run');
  assert.match(message, /cd <package>/, 'names the single-package run');
});

test('a trailing slash and a `.` segment are the same directory (issue 3362)', () => {
  assert.ok(repoRootRefusal('/repo/', '/repo'), 'a trailing slash must not spell a different directory');
  assert.ok(repoRootRefusal('/repo/./', '/repo'), 'a `.` segment must not spell a different directory');
  assert.ok(repoRootRefusal('/repo/packages/..', '/repo'), 'a `..` segment must not spell a different directory');
});

test('a real package directory is not refused (issue 3362)', () => {
  assert.equal(repoRootRefusal('/repo/packages/clash', '/repo'), null);
  assert.equal(repoRootRefusal('/repo/apps/viewer', '/repo'), null);
  // A directory whose path merely STARTS with the root is not the root.
  assert.equal(repoRootRefusal('/repo-two', '/repo'), null);
});

test('the default root is the repo this script lives in, not a guess (issue 3362)', () => {
  // Called with ONE argument, the way checkOnePackage calls it. If the default
  // resolved anywhere other than the repo root, every case above would still
  // pass while the live guard pointed at nothing.
  assert.ok(repoRootRefusal(REPO_ROOT), 'the default repoRoot must be the repository root');
  assert.equal(repoRootRefusal(path.join(REPO_ROOT, 'packages')), null);
});

test('a symlinked spelling of the repo root is still the repo root (issue 3362)', () => {
  // `process.cwd()` reports the realpath while REPO_ROOT comes from this file's
  // own URL, so a symlinked checkout spells one directory two ways. A plain
  // string compare misses, and missing here admits the run being refused.
  const dir = mkdtempSync(path.join(tmpdir(), 'typecheck-tests-symlink-'));
  const link = path.join(dir, 'repo');
  try {
    symlinkSync(REPO_ROOT, link, 'dir');
    assert.ok(repoRootRefusal(link), 'a symlink to the repo root must be refused too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('running it bare from the repo root refuses and writes no program (issue 3362)', async () => {
  // The end-to-end half. A guard that exists but that checkOnePackage never
  // calls passes every unit case above and still writes the 1,505-file program.
  const generated = path.join(REPO_ROOT, 'tsconfig.tests.json');
  // Never a legitimate artifact after this guard, and the file's own header
  // says it is generated and must not be committed, so clearing a leftover from
  // an older run is safe.
  rmSync(generated, { force: true });

  const child = spawn(process.execPath, ['scripts/typecheck-tests.mjs'], { cwd: REPO_ROOT });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  // Without the guard the program appears within about a second and tsc then
  // runs for minutes. Watch for the file and for the clock, so this case FAILS
  // rather than hangs when the guard is missing.
  let wroteProgram = false;
  const watcher = setInterval(() => {
    if (existsSync(generated)) {
      wroteProgram = true;
      child.kill('SIGKILL');
    }
  }, 100);
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearInterval(watcher);
  clearTimeout(deadline);

  try {
    assert.equal(wroteProgram, false, `it wrote ${generated}: the repository was treated as a package`);
    assert.equal(code, 2, `expected exit 2, got ${code}: ${out}`);
    assert.match(out, /refusing to treat the repository root as a package/);
    assert.doesNotMatch(out, /has no test files, nothing to check/, 'it must refuse, not report a vacuous pass');
  } finally {
    rmSync(generated, { force: true });
  }
});
