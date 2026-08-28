#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type-checks the test sources that no emit program can see.
 *
 * The root `tsconfig.json` excludes `**\/*.test.ts` so tests never land in
 * `dist/`, every `packages/*` config inherits that through
 * `tsconfig.packages.json`, and `exclude` filters `include` — so a package's
 * `"include": ["src/**\/*"]` cannot bring its own tests back. The consequence
 * is silent: vitest and `tsx --test` transpile per file without checking
 * types, so an unchecked test still runs while everything it asserts at type
 * level (`expectTypeOf`, `@ts-expect-error`, a typed fixture) is unverified
 * (#2457).
 *
 * Rather than 40 near-identical `tsconfig.test.json` files, this script
 * derives one test program per package from the package's own tsconfig:
 *
 *   {
 *     "extends": ["./tsconfig.json", "../../tsconfig.tests.base.json"],
 *     "compilerOptions": { "types": [...] },
 *     "files": ["./src/foo.test.ts", ...]
 *   }
 *
 * `files` is the load-bearing part: unlike `include`, it is NOT filtered by
 * `exclude`, so the generated program is immune to the very trap it exists to
 * close. `tsconfig.tests.base.json` turns emit off. The result is written to
 * `<pkg>/tsconfig.tests.json`, which is gitignored — it is a pure function of
 * the package's tsconfig plus the test files on disk, so a package added
 * tomorrow is covered without touching this script.
 *
 * Usage:
 *   node ../../scripts/typecheck-tests.mjs     (cwd = a package; the per-package `typecheck` script)
 *   node scripts/typecheck-tests.mjs --all     (cwd = repo root; every package)
 *   node scripts/typecheck-tests.mjs --audit   (cwd = repo root; the repo-wide coverage gate)
 *
 * The no-argument form reads the CURRENT DIRECTORY as one package, so run bare
 * from the repo root it used to type-check the whole repository as a single
 * program (#3362). `repoRootRefusal` below refuses that; see it for what was
 * measured.
 *
 * ANTI-VACUITY (#3194, #3200). `--audit` used to print
 * `TOTAL 0 / 0` followed by `every test file on disk is in a typecheck
 * program.` and exit 0 when it found no packages at all — a scan of nothing
 * reported as a clean scan. Reproduced by running a copy of this script from
 * an otherwise-empty tree, and again from a tree where `packages/` and `apps/`
 * exist but are empty. Four guards now stand between an empty input set and
 * that success line: neither package parent existing is a failure, no package
 * carrying tests is a failure, and — against the real repo, where a collapse
 * would otherwise be invisible — fewer than `AUDITED_PACKAGES_FLOOR` packages
 * or `TEST_FILES_FLOOR` test files is a failure. A directory the walk cannot
 * read is loud too, and distinguished from one that is missing: they call for
 * different fixes, and neither of them means "this package has no tests".
 *
 * SCAN SCOPE, stated so nobody mistakes the OK for a whole-repo claim: the
 * audit walks every parent `pnpm-workspace.yaml` declares — `packages/*`,
 * `apps/*` and `examples/*`. Test files under `tests/` are NOT in
 * any typecheck program today (`tests/tsconfig.json` extends the root config,
 * whose `exclude` carries `**\/*.test.ts`, and `tsx --test` transpiles without
 * checking) — the very #2457 gap this file exists to close, one directory
 * over, and tracked in #3200. The success line names its scope rather than
 * claiming every test file on disk.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_NAME = 'typecheck-tests.mjs';
const TSC = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TEST_FILE_RE = /\.test\.(ts|tsx|mts|cts)$/;
// `target` is Rust's build directory (apps/server is a crate). Nothing under
// it matches TEST_FILE_RE, so skipping it fixes no false positive — it stops
// the walk descending through a whole Rust build tree on every local run. CI
// checkouts are clean, so this is a local-speed change only. Safe to skip
// unconditionally: `.gitignore` carries a repo-wide `target/`, so no directory
// of that name can hold a tracked test file.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'pkg', '.git', '.turbo', 'target']);
const GENERATED_CONFIG = 'tsconfig.tests.json';

/**
 * Package parents the audit walks. Not the whole repo — see SCAN SCOPE above.
 *
 * All three of the parents `pnpm-workspace.yaml` declares. `examples` was
 * missing until the #3201 review, and that gap was the same shape as the
 * skipped-directory bug fixed below, one level further out and strictly worse:
 * an unwatched PARENT is never a skipped DIRECTORY, so the "look inside every
 * skipped directory" check could not reach it either. `examples/*` members are
 * real TypeScript workspace packages with their own tsconfigs, so a test at
 * `examples/collab-demo/src/foo.test.ts` escaped in silence. Adding the parent
 * changed no count on a healthy tree — `find examples -name '*.test.*'` returns
 * 0 today, so the audit still reports 1,434 files across 46 packages — which is
 * exactly why only a regression test keeps it closed (typecheck-tests.test.mjs).
 */
const PACKAGE_PARENTS = ['packages', 'apps', 'examples'];

/** `packages/`; `packages/ and apps/`; `packages/, apps/ and examples/`. */
function parentList(names) {
  const parts = names.map((p) => `${p}/`);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * Lower bound on how many workspace packages must actually reach the audit.
 * Measured on a healthy tree: 46 packages carry test files, all of them under
 * `packages/` and `apps/` — no `examples/*` member has one today. Set to 30 — about a third of headroom, enough that ordinary
 * churn (a package split, a few merged or retired) never forces an edit here,
 * while the failure this guards against still trips: it is the WHOLESALE
 * blindings this floor is sized for — a wrong scan root, a `readdirSync` that
 * returns nothing, a package.json read that stops finding files — and each of
 * those collapses the count to zero or near it, not to 29.
 *
 * It is deliberately not the guard for a PARTIAL drop, and this PR's own change
 * supplies the counter-example: a package that loses its `tsconfig.json` stops
 * being audited and the count falls by one. That case is caught earlier and by
 * name — if the package carries test files the skipped-directory check in
 * `audit()` fails the run before these counts are consulted, and if it carries
 * none, no coverage was lost by dropping it.
 */
const AUDITED_PACKAGES_FLOOR = 30;

/**
 * Lower bound on how many test files the walk must find. A second floor,
 * because the audit has two independent ways to go blind and each leaves the
 * other's number looking healthy: the package enumeration can collapse, or the
 * package walk can succeed while `findTestFiles` stops recognising test files
 * (a change to TEST_FILE_RE, a new extension). Measured on a healthy tree:
 * 1,434 test files. Set to 900.
 */
const TEST_FILES_FLOOR = 900;

/** Test files on disk under `dir`, sorted, repo-relative-free (absolute). */
function findTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A directory that is MISSING and one that cannot be READ are different
    // events, and neither of them is "this package has no test files". The
    // previous `catch { return out; }` collapsed both into an empty result,
    // which is how `--audit` could report a clean tree it never opened.
    throw new Error(
      err?.code === 'ENOENT'
        ? `${dir} does not exist — refusing to treat a missing directory as one containing no test files`
        : `${dir} could not be read (${err?.code ?? err?.message}) — refusing to treat an unreadable directory as one containing no test files`,
      { cause: err },
    );
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTestFiles(full, out);
    else if (TEST_FILE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

/** tsconfig files allow `//` line comments; JSON.parse does not. */
function readTsconfig(file) {
  const raw = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(raw);
}

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * A tsconfig `extends` value pointing at `target`, relative to `fromDir`, that
 * tsc will always resolve as a PATH rather than as a node module.
 *
 * tsc treats an `extends` string as a relative path only when it starts with
 * `./` or `../`; anything else goes through node module resolution. A plain
 * `path.relative()` produces a bare `tsconfig.tests.base.json` whenever the two
 * are siblings — which happens for every generated program written at the repo
 * root — and tsc then fails to find it (TS6053) and quietly drops everything it
 * carried, `noEmit` included.
 */
function relativeExtends(fromDir, target) {
  const rel = toPosix(path.relative(fromDir, target));
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Write `<pkgDir>/tsconfig.tests.json` and return its path, or null when the
 * package has no test files.
 */
function writeTestProgram(pkgDir) {
  const tests = findTestFiles(pkgDir).sort();
  if (tests.length === 0) return null;

  const own = readTsconfig(path.join(pkgDir, 'tsconfig.json'));
  const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };

  // A package that pins `types` (e.g. `["@webgpu/types"]`) drops the ambient
  // declarations its tests need. Widen — never narrow — for the test program:
  // `node` for the builtins tests reach for, and vitest's globals for the
  // packages whose vitest config runs with `globals: true`. Both are dev-only;
  // the emit program keeps its own narrower `types`.
  const types = new Set(own.compilerOptions?.types ?? []);
  types.add('node');
  if (deps.vitest) types.add('vitest/globals');

  const config = {
    '//': 'GENERATED by scripts/typecheck-tests.mjs — do not edit, do not commit. See tsconfig.tests.base.json.',
    extends: [
      './tsconfig.json',
      // `./`-prefixed, ALWAYS. A tsconfig `extends` value without a leading
      // `./` or `../` is resolved as a NODE MODULE, not as a relative path.
      // path.relative() returns a bare `tsconfig.tests.base.json` whenever
      // pkgDir is the repo root itself — so the base config was silently not
      // found (`tsc --showConfig` reports TS6053), and with it the `noEmit`
      // it carries. Controlled: an otherwise identical program with a bare
      // extends emitted `a.js`; with `./` it emitted nothing. That is how the
      // repo-root run in the #2664 review left 9,609 untracked build outputs
      // scattered through the source tree.
      relativeExtends(pkgDir, path.join(REPO_ROOT, 'tsconfig.tests.base.json')),
    ],
    compilerOptions: { types: [...types] },
    files: tests.map((f) => `./${toPosix(path.relative(pkgDir, f))}`),
  };

  const target = path.join(pkgDir, GENERATED_CONFIG);
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return { config: target, testCount: tests.length };
}

async function tsc(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [TSC, ...args], {
      cwd: REPO_ROOT,
      maxBuffer: 256 * 1024 * 1024,
    });
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** The three real ways to run this, printed by every refusal below. */
const USAGE_LINES = [
  `    cd <package> && node ../../scripts/${SCRIPT_NAME}   (that one package)`,
  `    node scripts/${SCRIPT_NAME} --all                   (every package)`,
  `    node scripts/${SCRIPT_NAME} --audit                 (repo-wide coverage gate)`,
];

/**
 * Are these the same directory?
 *
 * `path.resolve` is the whole answer on every path this is actually reached
 * through, so the realpath fallback runs zero syscalls in practice. It is kept
 * as defence for platforms this was not measured on: four invocations were
 * tried on macOS - cd through a symlink, the same with --preserve-symlinks,
 * invoking through the link from the real directory, and that with
 * --preserve-symlinks - and `resolve` matched in all four, because getcwd(3)
 * already returns the resolved path and Node's ESM loader realpaths the module
 * URL. Only the symlink test reaches the fallback today.
 */
function samePath(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    // One of them cannot be resolved, so they are not provably the same path.
    // Reported by the caller that actually reads it, not swallowed here.
    return false;
  }
}

/**
 * Why the repo root is not a package: the message, or null when `pkgDir` is fine.
 *
 * `parseCliMode` already refuses the ARGUMENT form of this mistake — `node
 * scripts/typecheck-tests.mjs packages/clash` from the root used to ignore its
 * argument and fall through to the cwd branch. The CWD form was left open, and
 * it is the same substitution with the argument omitted: `node
 * scripts/typecheck-tests.mjs` run bare from the root takes zero arguments,
 * which `parseCliMode` accepts as `package` mode, and `checkOnePackage` then
 * reads the REPOSITORY as the package. Measured on this tree (#3362): it wrote
 * a 1,520-line /tsconfig.tests.json naming 1,505 test files and handed the lot
 * to one tsc invocation, printing nothing at all while it did so.
 *
 * #3363 added that path to .gitignore, which was right for diff noise and which
 * also removed the last visible symptom — an untracked file someone would
 * notice. A guard is what is left.
 *
 * Exported for its unit test: like `parseCliMode`, every wrong answer here is
 * invisible at the call site, because the script runs and reports on something
 * other than what was asked for.
 *
 * @param {string} pkgDir
 * @param {string} [repoRoot]
 * @returns {string | null}
 */
export function repoRootRefusal(pkgDir, repoRoot = REPO_ROOT) {
  if (!samePath(pkgDir, repoRoot)) return null;
  return [
    `${SCRIPT_NAME}: refusing to treat the repository root as a package.`,
    '',
    '  The no-argument mode checks the CURRENT DIRECTORY as one package, and',
    `  ${pkgDir} is the repo root. Running it there builds a single tsconfig`,
    '  program naming every test file in the repo and type-checks them all at',
    '  once, which is not what any caller has ever wanted (#2664, #3362).',
    '',
    '  You probably meant one of:',
    ...USAGE_LINES,
  ].join('\n');
}

/** Per-package mode: generate this package's test program and check it. */
async function checkOnePackage(pkgDir) {
  const refusal = repoRootRefusal(pkgDir);
  if (refusal) {
    console.error(refusal);
    return 2;
  }
  // Never empty: `path.relative` returns '' only for the repo root itself, and
  // the refusal above is the only way past this line.
  const name = path.relative(REPO_ROOT, pkgDir);
  const program = writeTestProgram(pkgDir);
  if (!program) {
    console.log(`typecheck-tests: ${name} has no test files, nothing to check`);
    return 0;
  }
  const { ok, output } = await tsc(['-p', program.config]);
  if (output.trim()) console.log(output.trimEnd());
  if (!ok) {
    console.error(`typecheck-tests: ${name} FAILED (${program.testCount} test files)`);
    return 1;
  }
  console.log(`typecheck-tests: ${name} OK (${program.testCount} test files)`);
  return 0;
}

/**
 * @param {string[]} [seenParents] filled with the package parents that exist,
 *   so a caller can tell "no packages here" from "nowhere to look for them".
 */
function workspaceDirs(seenParents = [], scanRoot = REPO_ROOT, skipped = []) {
  const dirs = [];
  for (const group of PACKAGE_PARENTS) {
    const base = path.join(scanRoot, group);
    if (!existsSync(base)) continue;
    seenParents.push(group);
    for (const name of readdirSync(base).sort()) {
      const dir = path.join(base, name);
      if (!statSync(dir).isDirectory()) continue;
      const missing = [];
      if (!existsSync(path.join(dir, 'tsconfig.json'))) missing.push('tsconfig.json');
      if (!existsSync(path.join(dir, 'package.json'))) missing.push('package.json');
      // A directory without both files cannot be audited — there is no program
      // to resolve and no `typecheck` script to check. But "cannot be audited"
      // is not "has no tests": the caller has to look inside before the run
      // may claim it covered this parent. See auditSkipped() below.
      if (missing.length > 0) {
        skipped.push({ dir, missing });
        continue;
      }
      dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Does this audit run have enough input to mean anything? Returns the refusal
 * message, or null when the run is worth trusting.
 *
 * Pure and exported so `typecheck-tests.test.mjs` can drive every branch in
 * isolation. That is NOT sufficient on its own: testing this function only
 * through direct calls leaves nothing asserting that `audit()` still calls it,
 * and all four call sites could be deleted with the suite green (#3201
 * review). `audit()` therefore takes an injectable `scanRoot` and injectable
 * floors — the `opts.candidateFloor ?? CANDIDATE_FLOOR` seam that
 * `check-refwalk-guards.mjs` uses — so the same tests drive the refusals END TO
 * END through `audit()` against a synthetic tree. The CLI exposes no override,
 * so the gate itself always runs the real root and the real floors.
 *
 * `packagesWithTests` / `testFiles` are null on the structural pass, which
 * runs before any tsc invocation; the quantitative floors need counts that
 * only exist after the walk.
 *
 * @param {{seenParents: string[], packagesWithTests: number|null, testFiles: number|null}} counts
 * @returns {string|null}
 */
export function auditVacuity({
  seenParents,
  packagesWithTests,
  testFiles,
  scanRoot = REPO_ROOT,
  packagesFloor = AUDITED_PACKAGES_FLOOR,
  testFilesFloor = TEST_FILES_FLOOR,
}) {
  if (seenParents.length === 0) {
    return (
      `none of ${parentList(PACKAGE_PARENTS)} exists under ${scanRoot}. ` +
      `Refusing a vacuous pass: this audit exists to prove workspace test files reach a typecheck ` +
      `program, and it found nowhere to look for them.`
    );
  }
  if (packagesWithTests === null || testFiles === null) return null;
  if (packagesWithTests === 0) {
    return (
      `${parentList(seenParents)} contain no package with a test file. ` +
      `Refusing a vacuous pass: an audit that found zero test files has proved nothing about ` +
      `typecheck coverage.`
    );
  }
  if (packagesWithTests < packagesFloor) {
    return (
      `only ${packagesWithTests} package(s) carried test files, floor is ${packagesFloor}. ` +
      `Refusing a vacuous pass: this repo has about 46, so a count this low means the package walk ` +
      `stopped working, not that the packages went away. If packages were genuinely removed, lower ` +
      `AUDITED_PACKAGES_FLOOR in the same commit.`
    );
  }
  if (testFiles < testFilesFloor) {
    return (
      `only ${testFiles} test file(s) found, floor is ${testFilesFloor}. ` +
      `Refusing a vacuous pass: this repo has about 1,434, so a count this low means the test-file ` +
      `walk or TEST_FILE_RE stopped matching, not that the tests went away. If tests were genuinely ` +
      `removed, lower TEST_FILES_FLOOR in the same commit.`
    );
  }
  return null;
}

/**
 * Repo-wide mode: prove every test file under the workspace parents is a
 * root file of some typecheck program, and that every package carrying tests
 * actually runs one. This is the part that fails when a test file stops being
 * checked — without it the arrangement rots the next time a package is added.
 */
async function audit({
  scanRoot = REPO_ROOT,
  packagesFloor = AUDITED_PACKAGES_FLOOR,
  testFilesFloor = TEST_FILES_FLOOR,
} = {}) {
  const rows = [];
  const problems = [];
  const seenParents = [];
  const skipped = [];
  const dirs = workspaceDirs(seenParents, scanRoot, skipped);
  const floors = { scanRoot, packagesFloor, testFilesFloor };

  // Anti-vacuity, structural. Checked before any tsc runs, because with an
  // empty input set everything below it succeeds by having nothing to do.
  const vacuous = auditVacuity({ seenParents, packagesWithTests: null, testFiles: null, ...floors });
  if (vacuous) {
    console.error(`\ntypecheck-tests: ${vacuous}`);
    return 1;
  }

  // #3201 review: the success line said "all N test file(s) ... under
  // packages/ and apps/ are in a typecheck program", but workspaceDirs skips
  // any directory missing tsconfig.json or package.json, and those files were
  // never counted. A package added without a tsconfig.json therefore had its
  // tests escape silently — the exact #2457 rot this gate exists to stop, one
  // level up. Look inside every skipped directory before claiming the parent.
  for (const { dir, missing } of skipped) {
    const rel = toPosix(path.relative(scanRoot, dir));
    const stray = findTestFiles(dir);
    if (stray.length === 0) continue;
    problems.push(
      `${rel}: ${stray.length} test file(s) on disk but no ${missing.join(' and no ')}, ` +
        `so this audit cannot resolve a typecheck program for it and skipped it entirely. ` +
        `Add the missing file(s), or move the tests into a package that has them. ` +
        // Both reds are correct and precise, but they arrive one CI run apart:
        // adding the tsconfig.json this asks for promotes the directory into
        // the walk below, which then fails it for having no "typecheck"
        // script. Name both here so the fix is one round trip, not two.
        `A directory promoted this way also needs a "typecheck" script — under packages/ that must be ` +
        `"node ../../scripts/${SCRIPT_NAME}" — or the next run fails on that instead.`,
    );
  }

  for (const dir of dirs) {
    const rel = toPosix(path.relative(scanRoot, dir));
    const onDisk = findTestFiles(dir).sort();
    if (onDisk.length === 0) continue;

    const pkgJson = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const typecheckScript = pkgJson.scripts?.typecheck;
    if (!typecheckScript) {
      problems.push(
        `${rel}: ${onDisk.length} test file(s) on disk but no "typecheck" script, so turbo never checks them. ` +
          `Add "typecheck": "node ../../scripts/typecheck-tests.mjs".`,
      );
    } else if (rel.startsWith('packages/') && !typecheckScript.includes(SCRIPT_NAME)) {
      // Existence is not enough. Below, this audit validates a program it
      // GENERATES ITSELF from the same enumeration — so a package whose script
      // is `echo ok`, or a bare `tsc --noEmit` against the emit config that
      // excludes tests, passes both `turbo typecheck` and this gate while its
      // tests go unchecked. That is the exact rot this file exists to stop,
      // reproduced one level up, so the script's CONTENT has to be asserted.
      problems.push(
        `${rel}: "typecheck" is ${JSON.stringify(typecheckScript)}, which does not run ${SCRIPT_NAME}. ` +
          `turbo would report it green while this package's ${onDisk.length} test file(s) go unchecked. ` +
          `Use "typecheck": "node ../../scripts/${SCRIPT_NAME}".`,
      );
    }

    // Which project is supposed to cover this package's tests? Packages use
    // the generated test program; apps and examples typecheck their own
    // tsconfig. That is right for examples/*: unlike packages/*, their
    // tsconfigs are standalone (no `extends` of the root config), so they
    // never inherit the `**/*.test.ts` exclude that makes the generated
    // program necessary — `"include": ["src"]` already reaches their tests.
    const generated = rel.startsWith('packages/') ? writeTestProgram(dir) : null;
    const project = generated?.config ?? path.join(dir, 'tsconfig.json');

    const { output } = await tsc(['-p', project, '--showConfig']);
    let rootFiles = [];
    try {
      rootFiles = (JSON.parse(output).files ?? []).map((f) => path.resolve(dir, f));
    } catch {
      problems.push(`${rel}: could not read the resolved config for ${toPosix(path.relative(scanRoot, project))}`);
    }
    const covered = new Set(rootFiles.filter((f) => TEST_FILE_RE.test(f)));
    const missing = onDisk.filter((f) => !covered.has(f));
    for (const f of missing) {
      problems.push(`${toPosix(path.relative(scanRoot, f))} is in no typecheck program`);
    }
    rows.push({ pkg: rel, inProgram: onDisk.length - missing.length, onDisk: onDisk.length });
  }

  // No rows means nothing was measured, so there is no table to print and
  // `Math.max()` over an empty list would be -Infinity. Refuse here rather
  // than fall through to a success line describing a run that looked at
  // nothing.
  if (rows.length === 0) {
    console.error(
      `\ntypecheck-tests: ${auditVacuity({ seenParents, packagesWithTests: 0, testFiles: 0, ...floors })}`,
    );
    return 1;
  }

  const width = Math.max(...rows.map((r) => r.pkg.length));
  for (const row of rows) {
    const flag = row.inProgram === row.onDisk ? ' ' : '!';
    console.log(`${flag} ${row.pkg.padEnd(width)}  ${String(row.inProgram).padStart(4)} / ${String(row.onDisk).padStart(4)}`);
  }
  const totalIn = rows.reduce((s, r) => s + r.inProgram, 0);
  const totalOn = rows.reduce((s, r) => s + r.onDisk, 0);
  console.log(`  ${'TOTAL'.padEnd(width)}  ${String(totalIn).padStart(4)} / ${String(totalOn).padStart(4)}`);

  if (problems.length > 0) {
    console.error('\ntypecheck-tests: test sources outside every typecheck program (#2457):');
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }

  // Anti-vacuity, quantitative. After the offenders check: a run that found a
  // real problem should say so rather than argue about how much it measured.
  const undersized = auditVacuity({
    seenParents,
    packagesWithTests: rows.length,
    testFiles: totalOn,
    ...floors,
  });
  if (undersized) {
    console.error(`\ntypecheck-tests: ${undersized}`);
    return 1;
  }

  console.log(
    `\ntypecheck-tests: all ${totalOn} test file(s) across ${rows.length} package(s) under ` +
      `${parentList(PACKAGE_PARENTS)} are in a typecheck program.`,
  );
  return 0;
}

/** Repo-wide mode used by `pnpm typecheck:tests`: check every package. */
async function checkAll() {
  const dirs = workspaceDirs().filter((d) => toPosix(path.relative(REPO_ROOT, d)).startsWith('packages/'));
  const targets = [];
  for (const dir of dirs) {
    const program = writeTestProgram(dir);
    if (program) targets.push({ dir, config: program.config });
  }
  let failures = 0;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const { dir, config } = targets[next++];
      const { ok, output } = await tsc(['-p', config]);
      const name = toPosix(path.relative(REPO_ROOT, dir));
      if (!ok) {
        failures += 1;
        console.log(output.trimEnd());
        console.log(`typecheck-tests: ${name} FAILED`);
      } else {
        console.log(`typecheck-tests: ${name} OK`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(os.cpus().length, 8) }, worker));
  return failures === 0 ? 0 : 1;
}

// The generator is worth sharing: check-unused-locals.mjs needs the same test
// program, or it measures a tree with the tests cut out of it. Exported rather
// than duplicated, so the two cannot drift into disagreeing about what a
// package's test program contains.
// `relativeExtends` is exported for its unit test (typecheck-tests.test.mjs)
// rather than for any other caller: the bug it fixes is invisible in normal
// use — the generated config still parses, tsc still runs, it just silently
// stops honouring `noEmit` — so a test is the only thing that keeps it fixed.
/**
 * Decide what one invocation asked for, from the arguments after the script
 * path (`process.argv.slice(2)`).
 *
 * This script accepts exactly three shapes and nothing else: no arguments
 * (the cwd-driven per-package mode, which is how the packages' own
 * `typecheck` scripts invoke it), `--all`, or `--audit`. Anything else is an
 * error rather than a mode, because the failure this guard exists to prevent
 * is a SILENT SUBSTITUTION, not a typo: `node scripts/typecheck-tests.mjs
 * packages/clash` from the repo root used to ignore its argument and fall
 * through to the cwd branch, building a 1,115-file program rooted at the repo
 * — and, because that program's `extends` was bare rather than `./`-prefixed
 * (fixed above), running WITHOUT noEmit and leaving 9,609 untracked
 * .js/.d.ts/.map files across the source tree (#2664 review).
 *
 * The whole list is validated, not just the first argument. Checking argv[2]
 * alone left the identical substitution one step away: `--all packages/clash`
 * dropped the trailing argument and ran the repo-wide check, so a caller who
 * asked for one package silently got every package. `--all --audit` is
 * rejected for the same reason — they are two different runs, and picking one
 * would be a guess.
 *
 * Exported for its unit test (typecheck-tests.test.mjs): the accepted set is
 * only three items, but every wrong answer here is invisible at the call site
 * — the script runs, succeeds, and reports on something other than what was
 * asked for.
 *
 * @param {string[]} args
 * @returns {{mode: 'package'|'all'|'audit'} | {error: string}}
 */
export function parseCliMode(args) {
  if (args.length === 0) return { mode: 'package' };
  if (args.length === 1) {
    if (args[0] === '--audit') return { mode: 'audit' };
    if (args[0] === '--all') return { mode: 'all' };
    return { error: `unrecognised argument ${JSON.stringify(args[0])}` };
  }
  return { error: `expected at most one argument, got ${args.map((a) => JSON.stringify(a)).join(' ')}` };
}

export { audit, writeTestProgram, GENERATED_CONFIG, relativeExtends };

// Only run the CLI when invoked as one — importing this must not typecheck the
// repo and call process.exit.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const parsed = parseCliMode(process.argv.slice(2));
  let exitCode;
  if ('error' in parsed) {
    // Say what was wrong instead of silently doing something else — see
    // parseCliMode above for why an ignored argument is the dangerous case.
    console.error(`${SCRIPT_NAME}: ${parsed.error}.`);
    console.error('');
    console.error('  This script takes no package argument. Usage:');
    for (const line of USAGE_LINES) console.error(line);
    exitCode = 2;
  } else if (parsed.mode === 'audit') exitCode = await audit();
  else if (parsed.mode === 'all') exitCode = await checkAll();
  else exitCode = await checkOnePackage(process.cwd());
  process.exit(exitCode);
}
