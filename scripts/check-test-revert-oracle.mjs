#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * REVERT ORACLE — a pre-push check that asks whether a branch's tests actually
 * observe the branch's production change.
 *
 * WHY. Across a session of ~35 reviewed branches every gate was green on the
 * defective ones too: api-surface, unused-locals, changesets, clippy, ratchet.
 * More gates of that shape would not have helped. The one technique that
 * separated real coverage from decoration was mechanical: revert ONLY the
 * production hunk and check that the tests go red. Doing that by hand found,
 * among others, a renderer `device.ts` change (a `requiredFeatures` request
 * plus a new public method) that could be deleted entirely while the suite
 * stayed at 1027 pass, and a guard whose every test stubbed the very module
 * being guarded.
 *
 * WHAT IT DOES.
 *   1. Split `git diff <base>...<head>` into production / test / ignored files.
 *   2. Run the branch's own added-or-changed tests. They must be green
 *      (a red baseline proves nothing about the revert).
 *   3. Reverse-apply the production hunks only.
 *   4. Run the same tests again.
 *   5. Restore by FORWARD-applying the identical patch and prove the tree is
 *      byte-identical.
 *
 * VERDICTS.
 *   OBSERVED      assertions went red -> the change is covered. Exit 0.
 *   UNOBSERVED    everything still passes -> THE FINDING. Exit 1.
 *   INCONCLUSIVE  the reverted tests never loaded / never ran. Exit 3.
 *
 * THE INCONCLUSIVE CASE IS THE POINT. A blunt revert usually also deletes
 * test-only exports (`__resetCacheForTests`), so the test file dies at import
 * with `SyntaxError: does not provide an export named ...`. Exit code is
 * non-zero and the runner reports a failure — and NOT ONE ASSERTION RAN. A
 * naive version of this tool scores that as "red, therefore covered" and hands
 * back exactly the false reassurance it was written to prevent. So the verdict
 * is taken from the runner's OUTPUT, never from its exit code, and anything
 * that smells of a load failure is reported as INCONCLUSIVE with a
 * recommendation to supply a surgical `--mutation` patch instead.
 *
 * VITEST HIDES THAT CASE. Node's ESM loader throws when a named export is
 * missing; Vite instead binds the import to `undefined`, so the module loads,
 * the test body runs, and vitest prints an ordinary `Failed Tests` banner
 * carrying `TypeError: <name> is not a function`. Structurally it is
 * indistinguishable from a real RED, so that text is read as a load failure
 * too — see `LOAD_ERROR_PATTERNS` in `lib/revert-oracle.mjs`.
 *
 * NOT A CI CHECK, DELIBERATELY. It mutates the working tree and it is slow.
 * See the LIMITATIONS block at the bottom of this file, and `--help`, for what
 * wiring it into CI would require.
 *
 * @unwired-by-design it reverse-applies patches to the working tree and reruns
 * a branch's suites twice; a pre-push interrogation tool, not a required check.
 *
 * USAGE
 *   node scripts/check-test-revert-oracle.mjs [options]
 *
 *   --base <ref>        default: upstream/main
 *   --head <ref>        default: HEAD (must equal the checked-out commit)
 *   --only <pathspec>   restrict the production revert to these paths
 *                       (repeatable; this is how you interrogate ONE file of a
 *                       branch that adds many)
 *   --mutation <file>   use this patch instead of the derived one. Written in
 *                       the same orientation as `git diff base...head`; it is
 *                       reverse-applied. Use it for sub-expression findings and
 *                       to escape an INCONCLUSIVE.
 *   --test <path>       restrict the tests that get run (repeatable)
 *   --root <dir>        repository to operate on (default: this script's repo).
 *                       Lets you point a version of the oracle you trust at a
 *                       checkout that predates it.
 *   --json              emit a machine-readable result alongside the report
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import {
  parseNameStatus,
  classifyDiff,
  detectRunner,
  cargoRunner,
  rootScriptsRunner,
  parseRunnerOutput,
  aggregate,
  verdict,
  UNOBSERVED,
  SURGICAL_ADVICE,
} from './lib/revert-oracle.mjs';

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag === -1 ? SELF_ROOT : resolve(process.argv[rootFlag + 1] ?? SELF_ROOT);

// Restoration state, declared before the first abort path can fire: `die()`
// consults it, and a `let` in the temporal dead zone would throw instead.
let reverted = false;
let restoreVerified = false;
let patchPath = null;

// Exit codes. 0 is reserved for OBSERVED and nothing else.
const EXIT_OBSERVED = 0;
const EXIT_UNOBSERVED = 1;
const EXIT_NOTHING_CHECKED = 2;
const EXIT_INCONCLUSIVE = 3;
const EXIT_REVERT_FAILED = 4;
const EXIT_RESTORE_FAILED = 5;

function die(code, message, extra = []) {
  // `process.exit` skips the `finally` block, so every abort path restores the
  // tree itself. `restore` is a no-op until the revert has actually landed.
  if (typeof restore === 'function') restore('abort');
  console.error(`\n[revert-oracle] ABORT: ${message}`);
  for (const line of extra) console.error(`  ${line}`);
  console.error('');
  process.exit(code);
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) die(EXIT_NOTHING_CHECKED, `git ${args.join(' ')} could not run: ${r.error.message}`);
  return r;
}

function gitOrDie(args) {
  const r = git(args);
  if (r.status !== 0) {
    die(EXIT_NOTHING_CHECKED, `git ${args.join(' ')} failed`, (r.stderr || '').trim().split('\n'));
  }
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { base: 'upstream/main', head: 'HEAD', only: [], tests: [], mutation: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(EXIT_NOTHING_CHECKED, `${a} needs a value`);
      return v;
    };
    if (a === '--base') opts.base = next();
    else if (a === '--head') opts.head = next();
    else if (a === '--only') opts.only.push(next());
    else if (a === '--test') opts.tests.push(next());
    else if (a === '--mutation') opts.mutation = next();
    else if (a === '--root') next(); // already consumed above, before ROOT is frozen
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else die(EXIT_NOTHING_CHECKED, `unknown argument: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Package / runner resolution
// ---------------------------------------------------------------------------

function findUp(startDir, filename) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir || !parent.startsWith(ROOT)) return null;
    dir = parent;
  }
}

function crateNameFor(absFile) {
  const dir = findUp(dirname(absFile), 'Cargo.toml');
  if (!dir) return null;
  const toml = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
  const m = /^\s*\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m.exec(toml);
  return m ? { dir, crate: m[1] } : null;
}

/** Group test files by the package that owns them and pick each one's runner. */
function planRuns(testPaths) {
  /** @type {Map<string, {dir: string, files: string[], script: string|undefined, crate: string|null}>} */
  const groups = new Map();
  const unassigned = [];

  for (const rel of testPaths) {
    const abs = join(ROOT, rel);
    if (rel.endsWith('.rs')) {
      const c = crateNameFor(abs);
      if (!c) { unassigned.push(rel); continue; }
      const key = `cargo:${c.crate}`;
      if (!groups.has(key)) groups.set(key, { dir: c.dir, files: [], script: undefined, crate: c.crate });
      groups.get(key).files.push(rel);
      continue;
    }
    const pkgDir = findUp(dirname(abs), 'package.json');
    if (!pkgDir) { unassigned.push(rel); continue; }
    if (!groups.has(pkgDir)) {
      let script;
      try {
        script = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).scripts?.test;
      } catch {
        script = undefined;
      }
      groups.set(pkgDir, { dir: pkgDir, files: [], script, crate: null });
    }
    groups.get(pkgDir).files.push(rel);
  }

  const plans = [];
  for (const [key, g] of groups) {
    const relFiles = g.files.map((f) => relative(g.dir, join(ROOT, f)) || f);
    const runner = g.crate
      ? cargoRunner(g.crate)
      : (g.dir === ROOT ? rootScriptsRunner(g.files) : null) ?? detectRunner(g.script, relFiles);
    plans.push({ key, dir: g.dir, files: g.files, relFiles, runner, script: g.script, crate: g.crate });
  }
  return { plans, unassigned };
}

/** Resolve a runner binary the way the package itself would. */
function resolveBin(bin, pkgDir) {
  if (bin === 'node') return process.execPath;
  if (bin === 'cargo') return 'cargo';
  let dir = pkgDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', '.bin', bin);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || !parent.startsWith(ROOT)) return null;
    dir = parent;
  }
}

function runPlan(plan, label) {
  const cwd = plan.crate ? ROOT : plan.dir;
  const binPath = resolveBin(plan.runner.bin, plan.dir);
  if (!binPath) {
    return {
      kind: 'runner-missing',
      passed: null,
      failed: null,
      total: null,
      evidence: [`runner binary "${plan.runner.bin}" not found from ${relative(ROOT, plan.dir) || '.'} — run pnpm install`],
    };
  }
  const started = Date.now();
  const r = spawnSync(binPath, plan.runner.args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const parsed = parseRunnerOutput({
    family: plan.runner.family,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.status,
    spawnError: r.error ? `${r.error.message}` : undefined,
  });
  parsed.rawExitCode = r.status;
  parsed.durationMs = Date.now() - started;
  parsed.tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
  console.log(
    `  [${label}] ${relative(ROOT, plan.dir) || '.'} (${plan.runner.family}) -> ${parsed.kind}` +
      ` (pass ${parsed.passed ?? '?'}, fail ${parsed.failed ?? '?'}, total ${parsed.total ?? '?'}, exit ${r.status}, ${parsed.durationMs}ms)`,
  );
  return parsed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));

console.log('[revert-oracle] does this branch\'s test actually observe this branch\'s change?');
console.log(`  repo:  ${ROOT}`);
console.log(`  base:  ${opts.base}`);
console.log(`  head:  ${opts.head}`);

// The tool mutates the working tree. It refuses to start on a dirty one, both
// because a revert on top of local edits is meaningless and because a clean
// tree is the invariant that makes restoration verifiable.
const preStatus = gitOrDie(['status', '--porcelain']).trim();
if (preStatus !== '') {
  die(EXIT_NOTHING_CHECKED, 'the working tree is dirty; this check needs a clean tree to revert into and to verify restoration against.', preStatus.split('\n'));
}

const baseSha = gitOrDie(['rev-parse', '--verify', `${opts.base}^{commit}`]).trim();
const headSha = gitOrDie(['rev-parse', '--verify', `${opts.head}^{commit}`]).trim();
const checkedOut = gitOrDie(['rev-parse', 'HEAD']).trim();
if (headSha !== checkedOut) {
  die(EXIT_NOTHING_CHECKED, `--head ${opts.head} (${headSha.slice(0, 9)}) is not the checked-out commit (${checkedOut.slice(0, 9)}). Check it out first; this tool patches the working tree in place.`);
}
if (baseSha === headSha) die(EXIT_NOTHING_CHECKED, 'base and head are the same commit; there is no change to revert.');

const mergeBase = gitOrDie(['merge-base', baseSha, headSha]).trim();
const entries = parseNameStatus(gitOrDie(['diff', '--name-status', `${mergeBase}`, headSha]));
if (entries.length === 0) die(EXIT_NOTHING_CHECKED, 'the diff is empty; nothing to check.');

const { production, test: testEntries, ignored, warnings } = classifyDiff(entries);
for (const w of warnings) console.log(`  WARNING: ${w}`);

let prodPaths = production.map((e) => e.path);
if (opts.only.length > 0) {
  const before = prodPaths.length;
  prodPaths = prodPaths.filter((p) => opts.only.some((o) => p === o || p.startsWith(o.endsWith('/') ? o : `${o}/`)));
  console.log(`  --only narrowed the revert set from ${before} to ${prodPaths.length} production file(s)`);
  if (prodPaths.length === 0) die(EXIT_NOTHING_CHECKED, `--only matched none of the ${before} changed production files.`);
}

let testPaths = testEntries.map((e) => e.path).filter((p) => existsSync(join(ROOT, p)));
if (opts.tests.length > 0) {
  testPaths = testPaths.filter((p) => opts.tests.includes(p));
  if (testPaths.length === 0) die(EXIT_NOTHING_CHECKED, '--test matched none of the branch\'s changed test files.');
}

console.log(`  files: ${production.length} production, ${testEntries.length} test, ${ignored.length} ignored`);

if (prodPaths.length === 0) {
  die(EXIT_NOTHING_CHECKED, 'this branch changes no production files; there is nothing whose absence a test could notice.');
}
if (testPaths.length === 0) {
  die(
    EXIT_NOTHING_CHECKED,
    'this branch changes production code and adds/changes NO test file. That is itself the finding: nothing can observe the change.',
    production.map((e) => `changed: ${e.path}`),
  );
}

const { plans, unassigned } = planRuns(testPaths);
if (unassigned.length > 0) {
  die(EXIT_NOTHING_CHECKED, 'could not find an owning package for some test files', unassigned);
}
const runnerless = plans.filter((p) => !p.runner);
if (runnerless.length > 0) {
  die(
    EXIT_NOTHING_CHECKED,
    'no runner could be derived for some packages — refusing to report a clean result for tests that were never run',
    runnerless.map((p) => `${relative(ROOT, p.dir) || '.'}: scripts.test = ${JSON.stringify(p.script)}`),
  );
}
for (const p of plans) {
  console.log(`  runner: ${relative(ROOT, p.dir) || '.'} -> ${p.runner.bin} ${p.runner.args.join(' ')}`);
}

// --- build the revert patch -------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'revert-oracle-'));
patchPath = join(tmp, 'production.patch');
let patchText;
if (opts.mutation) {
  patchText = readFileSync(resolve(opts.mutation), 'utf8');
  console.log(`  mutation: ${opts.mutation} (${patchText.split('\n').length} lines, reverse-applied)`);
} else {
  patchText = gitOrDie(['diff', '--binary', mergeBase, headSha, '--', ...prodPaths]);
}
if (patchText.trim() === '') {
  rmSync(tmp, { recursive: true, force: true });
  die(EXIT_NOTHING_CHECKED, 'the production patch is empty; nothing would be reverted.');
}
writeFileSync(patchPath, patchText);

// --- restoration, guaranteed ------------------------------------------------
//
// Restoration is a FORWARD re-apply of the identical patch, never `git
// checkout --` / `git restore` / `git reset --hard` / `git stash`: those
// commands would also erase anything else in the tree if an assumption were
// wrong, and they cannot be verified against the patch that was applied.

function restore(context) {
  if (!reverted || !patchPath) return true;
  const r = git(['apply', patchPath]);
  if (r.status !== 0) {
    console.error(`\n[revert-oracle] !!! RESTORE FAILED (${context}) !!!`);
    console.error((r.stderr || '').trim());
    console.error(`The reverse patch is still on disk: ${patchPath}`);
    console.error(`Re-apply it by hand:  git apply ${patchPath}`);
    return false;
  }
  reverted = false;
  const status = git(['status', '--porcelain']).stdout.trim();
  if (status !== '') {
    console.error(`\n[revert-oracle] !!! TREE NOT BYTE-IDENTICAL AFTER RESTORE (${context}) !!!`);
    console.error(status);
    console.error(`Patch kept at: ${patchPath}`);
    return false;
  }
  restoreVerified = true;
  console.log(`  restored: forward re-applied the patch; \`git status --porcelain\` is empty`);
  return true;
}

let cleaningUp = false;
function emergency(signal) {
  if (cleaningUp) return;
  cleaningUp = true;
  console.error(`\n[revert-oracle] interrupted by ${signal} — restoring the tree before exiting`);
  const ok = restore(signal);
  process.exit(ok ? EXIT_INCONCLUSIVE : EXIT_RESTORE_FAILED);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => emergency(sig));
process.on('uncaughtException', (err) => {
  console.error(err?.stack ?? String(err));
  emergency('uncaughtException');
});

// --- run ---------------------------------------------------------------------

let exitCode = EXIT_INCONCLUSIVE;
let result = null;

try {
  console.log('\n[1/3] baseline: running the branch\'s own tests, unmodified');
  const baselineResults = plans.map((p) => runPlan(p, 'baseline'));
  const baseline = aggregate(baselineResults);

  console.log(`\n[2/3] reverting ${prodPaths.length} production file(s)`);
  const applyR = git(['apply', '-R', '--verbose', patchPath]);
  if (applyR.status !== 0) {
    die(EXIT_REVERT_FAILED, 'the production patch would not reverse-apply — nothing was checked.', [
      ...(applyR.stderr || '').trim().split('\n'),
      'The tree is untouched (git apply is all-or-nothing).',
    ]);
  }
  reverted = true;
  for (const p of prodPaths) console.log(`  reverted: ${p}`);

  console.log('\n[3/3] re-running the same tests with production reverted');
  const revertedResults = plans.map((p) => runPlan(p, 'reverted'));
  const revertedAgg = aggregate(revertedResults);

  result = verdict({ baseline, reverted: revertedAgg });
  result.baseline = baseline;
  result.revertedRun = revertedAgg;
  result.prodPaths = prodPaths;
  result.testPaths = testPaths;
  exitCode = result.exitCode === 0 ? EXIT_OBSERVED : result.verdict === UNOBSERVED ? EXIT_UNOBSERVED : EXIT_INCONCLUSIVE;

  if (revertedAgg.kind !== 'pass' && revertedAgg.kind !== 'assertion-failure') {
    const worst = revertedResults.find((r) => r.kind === revertedAgg.kind);
    if (worst?.tail) {
      console.log('\n  --- last lines of the failing reverted run ---');
      for (const line of worst.tail.split('\n')) console.log(`  | ${line}`);
    }
  }
} finally {
  if (!cleaningUp) {
    const ok = restore('normal exit');
    if (!ok) {
      console.error('[revert-oracle] the working tree was NOT restored. Do not push. Fix the tree first.');
      process.exit(EXIT_RESTORE_FAILED);
    }
  }
}

if (!restoreVerified && reverted) {
  die(EXIT_RESTORE_FAILED, 'restoration was never verified.');
}

// --- report -------------------------------------------------------------------

const banner = {
  OBSERVED: '  ✔ OBSERVED',
  UNOBSERVED: '  ✘ UNOBSERVED  <-- FINDING',
  INCONCLUSIVE: '  ? INCONCLUSIVE',
  'BASELINE-BROKEN': '  ! BASELINE-BROKEN',
}[result.verdict];

console.log('\n' + '='.repeat(78));
console.log(banner);
console.log('='.repeat(78));
console.log(`  reverted:  ${result.prodPaths.join('\n             ')}`);
console.log(`  tests run: ${result.testPaths.join('\n             ')}`);
console.log(`  baseline:  ${result.baseline.kind} — ${result.baseline.passed ?? '?'} passed / ${result.baseline.total ?? '?'} collected`);
console.log(`  reverted:  ${result.revertedRun.kind} — ${result.revertedRun.passed ?? '?'} passed, ${result.revertedRun.failed ?? '?'} failed / ${result.revertedRun.total ?? '?'} collected`);
console.log(`\n  ${result.reason}`);
if (result.advice) console.log(`\n  NEXT: ${result.advice}`);
// An OBSERVED earned by reverting many files at once can be carried by a single
// line of the change while the rest is unobserved -- the shape of the
// `device.ts` case this tool was written for. Say so rather than let the tick
// read as a verdict on the whole branch.
if (result.verdict === 'OBSERVED' && result.prodPaths.length > 1 && opts.only.length === 0) {
  console.log(
    `\n  NOTE: ${result.prodPaths.length} production files were reverted together, so this tick may be ` +
      'earned by one of them. Re-run with --only <path> per file to find the unobserved ones.',
  );
}
if (result.verdict === 'INCONCLUSIVE' && result.advice !== SURGICAL_ADVICE) console.log(`\n  ALSO: ${SURGICAL_ADVICE}`);
console.log('');

if (opts.json) {
  console.log(
    JSON.stringify(
      {
        verdict: result.verdict,
        reason: result.reason,
        base: baseSha,
        head: headSha,
        production: result.prodPaths,
        tests: result.testPaths,
        baseline: { kind: result.baseline.kind, passed: result.baseline.passed, total: result.baseline.total },
        reverted: { kind: result.revertedRun.kind, passed: result.revertedRun.passed, failed: result.revertedRun.failed, total: result.revertedRun.total, evidence: result.revertedRun.evidence },
      },
      null,
      2,
    ),
  );
}

rmSync(tmp, { recursive: true, force: true });
process.exit(exitCode);

/* ---------------------------------------------------------------------------
 * LIMITATIONS — read before trusting an OBSERVED
 * ---------------------------------------------------------------------------
 *
 * An OBSERVED means "some assertion in the branch's changed tests went red when
 * the production hunks were removed". That is strictly weaker than "the change
 * is well tested". Specifically:
 *
 * 1. COARSE GRANULARITY. The default reverts every production hunk at once, so
 *    OBSERVED can be earned by one line of a fifty-line change while the other
 *    forty-nine are unobserved. The `renderer-timing-pairing-guard` case is
 *    exactly this shape: whole-branch is OBSERVED, `--only <one file>` is
 *    UNOBSERVED. Use `--only`, and `--mutation` for sub-expression clauses (a
 *    `&& !(value instanceof DataView)` cannot be reverted at file granularity).
 *
 * 2. IT CANNOT SEE INTO A SUB-EXPRESSION AT ALL without `--mutation`. Every
 *    guard clause, every added `&&`, every widened tolerance that is part of a
 *    larger edited line is invisible to the automatic mode.
 *
 * 3. WRONG-REASON RED. An assertion may go red because the revert broke
 *    something incidental (a type default, an unrelated re-export) rather than
 *    because the test observes the behaviour. The tool reports the RED, not its
 *    cause. Read the failing assertion.
 *
 * 4. ONLY THE BRANCH'S OWN CHANGED TESTS RUN. A pre-existing test elsewhere may
 *    cover the change; the tool will still call it UNOBSERVED. That is the
 *    intended bias — the branch should carry its own witness — but it is not a
 *    claim that no test anywhere covers the code.
 *
 * 5. NON-DETERMINISM IS INVISIBLE. A test that passes because a race settled
 *    the convenient way will keep passing here. This tool detects "the test
 *    does not observe the change"; it does not detect "the test observes it
 *    only sometimes". Run it more than once on anything timing-shaped.
 *
 * 6. IT TRUSTS THE RUNNER'S OUTPUT FORMAT. `parseRunnerOutput` knows vitest,
 *    `node --test` TAP, and cargo as they print TODAY. A runner upgrade that
 *    changes the summary lines degrades results to UNPARSEABLE (safe) but a
 *    changed FAILURE banner could in principle turn a load failure into a
 *    reported OBSERVED. The synthetic fixtures in `revert-oracle.test.mjs` are
 *    verbatim captures for exactly this reason; refresh them on a major bump.
 *
 * 7. FALSE "OBSERVED" IS POSSIBLE, and vitest DOES produce the shape today.
 *    The shape is: the revert removes a named export, the runner binds the
 *    import to `undefined` instead of failing to link, and the resulting
 *    failure is reported as a NAMED test with no recognised load-error string.
 *    `node --test` (via tsx) is immune -- Node's ESM loader throws
 *    `SyntaxError: ... does not provide an export named X` at instantiation --
 *    and cargo is immune because Rust cannot compile a dead binding at all.
 *    Vitest is not: vite's SSR transform rewrites the import to a property
 *    read, so a removed export becomes `undefined` at use site. Measured, on
 *    vitest 4.1.11:
 *      - removed export CALLED as a function/class ->
 *        `TypeError: X is not a function` / `... is not a constructor`.
 *        Caught: that pattern is in LOAD_ERROR_PATTERNS.
 *      - removed export whose member is READ (`CONFIG.limit`) ->
 *        `TypeError: Cannot read properties of undefined (reading 'limit')`
 *        under a `Failed Tests` banner. NOT caught -> reads as
 *        `assertion-failure` -> false OBSERVED.
 *      - removed export compared DIRECTLY (`expect(LIMIT).toBe(5)`) ->
 *        an ordinary `expected undefined to be 5` AssertionError, textually
 *        indistinguishable from a genuine RED. No pattern can catch this one;
 *        closing it needs the removed export NAMES from the patch to be
 *        cross-checked against the failure text, which this tool does not do.
 *    So on a vitest package, an OBSERVED earned by a revert that deleted an
 *    export must be read by a human before it is trusted. The ReferenceError
 *    and `is not a function` patterns bias toward INCONCLUSIVE where they can,
 *    but the guarantee is a heuristic, not a proof.
 *
 * 8. RUST IS COARSER STILL. `#[cfg(test)] mod tests` lives inside the file
 *    being reverted, so the automatic mode on a Rust branch will usually report
 *    INCONCLUSIVE (compile error). That is correct, not a bug; use --mutation.
 *
 * 9. NO WORKSPACE BUILD. If a package needs a built dependency (`dist/`), the
 *    baseline run fails and you get BASELINE-BROKEN. Build first.
 *
 * ---------------------------------------------------------------------------
 * WIRING IT INTO CI — deliberately NOT done
 * ---------------------------------------------------------------------------
 * This is a thing a person runs before pushing. It reverse-applies production
 * code into the working tree, which is a bad property for a required check, and
 * it runs each affected suite twice. If someone later wants it in CI it would
 * need: (a) its own job on a throwaway checkout, never sharing a workspace with
 * another job; (b) a hard timeout and a concurrency cap, since cost is 2x the
 * affected suites; (c) a policy decision on INCONCLUSIVE, which is common and
 * benign and must NOT fail the build or it will be disabled within a week;
 * (d) `--base origin/main` and a fetch depth that reaches the merge base;
 * (e) an opt-out label, because legitimate refactor-only branches exist.
 * Until those five are decided, leaving it manual is the honest choice.
 * --------------------------------------------------------------------------- */
