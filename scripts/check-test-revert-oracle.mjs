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
 * CI runs it only in a throwaway, read-only checkout with a hard timeout. An
 * capability gaps, UNOBSERVED, and broken baselines all block, through
 * distinguishable result channels.
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
 *   --ci                block UNOBSERVED, broken baselines and capability gaps
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  parseNameStatus,
  classifyDiff,
  aggregate,
  OBSERVED,
  UNOBSERVED,
  withoutBrowserSpecs,
} from './lib/revert-oracle.mjs';
import { isDependabotDependencyOnly } from './lib/revert-oracle-dependabot.mjs';
import { isVersionOnlyManifestDiff } from './lib/revert-oracle-version-bump.mjs';
import { isCommentOnlyDiff } from './lib/revert-oracle-comment-only.mjs';
import { ciExitCode } from './lib/revert-oracle-ci.mjs';
import {
  createResultEmitter,
  ORACLE_CHANNEL,
  PULL_REQUEST_CHANNEL,
  resultRecord,
} from './lib/revert-oracle-result.mjs';
import { planRuns } from './lib/revert-oracle-plan-runs.mjs';
import { loadTypeScript, typeOnlyProduction, typecheckPlans, gitShow } from './lib/revert-oracle-type-only.mjs';
import { runPlan } from './lib/revert-oracle-run-plan.mjs';
import { printHumanReport } from './lib/revert-oracle-human-report.mjs';
import { buildExecutionLedger, ledgerVerdict, partitionRunnablePlans } from './lib/revert-oracle-ledger.mjs';

const SELF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag === -1 ? SELF_ROOT : resolve(process.argv[rootFlag + 1] ?? SELF_ROOT);

// Restoration state, declared before the first abort path can fire: `die()`
// consults it, and a `let` in the temporal dead zone would throw instead.
let restoration = 'not-required';
let patchPath = null;
let resultContext = { base: null, head: null, production: [], tests: [] };
const resultEmitter = createResultEmitter(process.argv.includes('--json'));
const invocationId = randomUUID();
const startedAt = new Date().toISOString();
let cleaningUp = false;

// Exit codes. 0 is reserved for OBSERVED and nothing else.
const EXIT_OBSERVED = 0;
const EXIT_UNOBSERVED = 1;
const EXIT_NOTHING_CHECKED = 2;
const EXIT_INCONCLUSIVE = 3;
const EXIT_REVERT_FAILED = 4;
const EXIT_RESTORE_FAILED = 5;

function emitResult(channel, verdict, code, reason, details = {}) {
  resultEmitter.emit(resultRecord({
    ...details,
    ...resultContext,
    channel,
    verdict,
    exitCode: code,
    reason,
    invocationId,
    startedAt,
    finishedAt: new Date().toISOString(),
    restoration,
  }));
}

function die(code, message, extra = [], details = {}) {
  // `process.exit` skips the `finally` block, so every abort path restores the
  // tree itself. `restore` is a no-op until the revert has actually landed.
  const restored = typeof restore !== 'function' || restore('abort');
  let channel = details.channel ?? ORACLE_CHANNEL;
  let outcome = details.verdict ?? 'ERROR';
  if (!restored) {
    code = EXIT_RESTORE_FAILED;
    message = `the oracle could not restore the working tree after: ${message}`;
    channel = ORACLE_CHANNEL;
    outcome = 'RESTORE-FAILED';
  }
  console.error(`\n[revert-oracle] ABORT: ${message}`);
  for (const line of extra) console.error(`  ${line}`);
  console.error('');
  if (!resultEmitter.emitted) {
    emitResult(channel, outcome, code, message, details);
  }
  process.exit(code);
}

function emergency(signal) {
  if (cleaningUp) return;
  cleaningUp = true;
  console.error(`\n[revert-oracle] interrupted by ${signal} — restoring the tree before exiting`);
  const ok = restore(signal);
  emitResult(ORACLE_CHANNEL, ok ? 'INTERRUPTED' : 'RESTORE-FAILED', ok ? EXIT_INCONCLUSIVE : EXIT_RESTORE_FAILED, `the oracle was interrupted by ${signal}`);
  process.exit(ok ? EXIT_INCONCLUSIVE : EXIT_RESTORE_FAILED);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => emergency(sig));

process.on('uncaughtException', (error) => {
  console.error(error?.stack ?? String(error));
  die(EXIT_NOTHING_CHECKED, `the oracle crashed: ${error?.message ?? String(error)}`, [], {
    error: { name: error?.name ?? 'Error' },
  });
});

function notApplicable(message) {
  console.log(`  NOT APPLICABLE: ${message}`);
  emitResult(PULL_REQUEST_CHANNEL, 'NOT-APPLICABLE', 0, message);
  process.exit(0);
}

function rawGit(args, opts = {}) {
  return spawnSync(process.env.IFC_LITE_ORACLE_GIT_BIN ?? 'git', [...(process.env.IFC_LITE_ORACLE_GIT_PREFIX ? [process.env.IFC_LITE_ORACLE_GIT_PREFIX] : []), ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

function git(args, opts = {}) {
  const r = rawGit(args, opts);
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
  const opts = { base: 'upstream/main', head: 'HEAD', only: [], tests: [], mutation: null, json: false, ci: false };
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
    else if (a === '--ci') opts.ci = true;
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      emitResult(ORACLE_CHANNEL, 'HELP', 0, 'help requested');
      process.exit(0);
    } else die(EXIT_NOTHING_CHECKED, `unknown argument: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Package / runner resolution
// ---------------------------------------------------------------------------

// findUp() and planRuns() live in ./lib/revert-oracle-plan-runs.mjs (#4090):
// this file sits at its exact module-size budget with zero headroom, so the
// grouping/runner-selection logic moved to that already-uncapped sibling
// instead of growing this one. planRuns() is invoked below through
// requiredFeaturePlanOrDie(), which also converts an UnhandledCfgShapeError
// raised from inside it (via requiredFeatureCombos()) into a structured
// failure instead of an unhandled crash.

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
resultContext = { ...resultContext, base: baseSha, head: headSha };
const checkedOut = gitOrDie(['rev-parse', 'HEAD']).trim();
if (headSha !== checkedOut) {
  die(EXIT_NOTHING_CHECKED, `--head ${opts.head} (${headSha.slice(0, 9)}) is not the checked-out commit (${checkedOut.slice(0, 9)}). Check it out first; this tool patches the working tree in place.`);
}
if (baseSha === headSha) die(EXIT_NOTHING_CHECKED, 'base and head are the same commit; there is no change to revert.');

const mergeBase = gitOrDie(['merge-base', baseSha, headSha]).trim();
const entries = parseNameStatus(gitOrDie(['diff', '--name-status', `${mergeBase}`, headSha]));
if (entries.length === 0) die(EXIT_NOTHING_CHECKED, 'the diff is empty; nothing to check.');

if (opts.ci && isDependabotDependencyOnly(process.env.PR_AUTHOR_LOGIN, entries)) {
  notApplicable(
    'Dependabot changed dependency manifests/lockfiles only; ' +
      'the normal build and test lanes provide the compatibility verdict.',
  );
}

const { production, test: testEntries, ignored, inert, warnings } = classifyDiff(entries);
resultContext = {
  ...resultContext,
  production: production.map((entry) => entry.path),
  tests: testEntries.map((entry) => entry.path),
};
for (const w of warnings) console.log(`  WARNING: ${w}`);

// The changesets release PR ("chore: version packages") changes only
// package.json `"version"` fields and the matching Cargo.toml version
// literals — no test can observe a version bump. `isVersionOnlyManifestDiff`
// checks the actual diff content of every `production` file (not just its
// name), so a real dependency/scripts/exports edit in the same file still
// requires a test as before. See revert-oracle-version-bump.mjs for the
// full rationale and the false-negative it is written against.
if (
  opts.ci &&
  production.length > 0 &&
  production.every((e) => isVersionOnlyManifestDiff(e.path, gitOrDie(['diff', '-U0', mergeBase, headSha, '--', e.path])))
) {
  notApplicable(
    'every production file is a package.json/Cargo.toml version-only bump ' +
      '(release PR shape); nothing a test could observe.',
  );
}

// A diff whose every changed line is a JS/TS comment changes no runtime
// behaviour, so no test can ever observe it -- reverting a comment cannot
// make any test go red, by construction (#4165: a paragraph added above
// INERT_SUFFIXES documenting the .svg exception, nothing else, was
// UNOBSERVED even after a test file was added to the branch). See
// revert-oracle-comment-only.mjs for the full rationale and the
// must-not-regress case (a real line change in the same diff still counts).
if (
  opts.ci &&
  production.length > 0 &&
  production.every((e) => isCommentOnlyDiff(e.path, gitOrDie(['diff', '-U0', mergeBase, headSha, '--', e.path])))
) {
  notApplicable(
    'every production file\'s diff is comment-only (no code changed); ' +
      'nothing a test could observe.',
  );
}

let prodPaths = production.map((e) => e.path);
if (opts.only.length > 0) {
  const before = prodPaths.length;
  prodPaths = prodPaths.filter((p) => opts.only.some((o) => p === o || p.startsWith(o.endsWith('/') ? o : `${o}/`)));
  console.log(`  --only narrowed the revert set from ${before} to ${prodPaths.length} production file(s)`);
  if (prodPaths.length === 0) die(EXIT_NOTHING_CHECKED, `--only matched none of the ${before} changed production files.`);
}

let testPaths = withoutBrowserSpecs(testEntries.map((e) => e.path).filter((p) => existsSync(join(ROOT, p))), (p) => readFileSync(join(ROOT, p), 'utf8'), console.log);
if (opts.tests.length > 0) {
  testPaths = testPaths.filter((p) => opts.tests.includes(p));
  if (testPaths.length === 0) die(EXIT_NOTHING_CHECKED, '--test matched none of the branch\'s changed test files.');
}
resultContext = { ...resultContext, production: prodPaths, tests: testPaths };

console.log(
  `  files: ${production.length} production, ${testEntries.length} test, ${ignored.length} ignored, ${inert.length} inert`,
);

if (prodPaths.length === 0) {
  const message = 'this branch changes no production files; there is nothing whose absence a test could notice.';
  if (opts.ci) notApplicable(message);
  die(EXIT_NOTHING_CHECKED, message);
}
if (testPaths.length === 0) {
  die(
    opts.ci ? EXIT_UNOBSERVED : EXIT_NOTHING_CHECKED,
    'this branch changes production code and adds/changes NO test file. That is itself the finding: nothing can observe the change.',
    production.map((e) => `changed: ${e.path}`),
    opts.ci ? { channel: PULL_REQUEST_CHANNEL, verdict: UNOBSERVED } : {},
  );
}

// #4472: when every production file erases to the same JavaScript, no test
// RUN can observe the change -- only the type-checker can. Decided on the
// revert set (after --only), at base vs head, with the repo's own typescript.
const typeOnly = typeOnlyProduction(loadTypeScript(ROOT), prodPaths, (side, p) => gitShow(ROOT, side === 'base' ? mergeBase : headSha, p));
const observer = typeOnly.typeOnly ? 'typecheck' : 'tests';
console.log(`  observer: ${observer} (${typeOnly.reason})`);
let plans;
let unassigned;
let support = [];
if (observer === 'typecheck') {
  const t = typecheckPlans(testPaths, ROOT);
  for (const s of t.skipped) console.log(`  skipped: ${s} is not TypeScript, so it cannot observe a type-only change`);
  if (t.plans.length === 0 && t.unassigned.length === 0) {
    die(
      opts.ci ? EXIT_UNOBSERVED : EXIT_NOTHING_CHECKED,
      'type-only production change, and none of the changed test files is TypeScript: nothing can observe it.',
      prodPaths.map((p) => `changed: ${p}`),
      opts.ci ? { channel: PULL_REQUEST_CHANNEL, verdict: UNOBSERVED } : {},
    );
  }
  ({ plans, unassigned } = t);
  support = t.skipped;
} else {
  ({ plans, unassigned, support } = planRuns(testPaths, ROOT));
}
const partitioned = partitionRunnablePlans(plans, unassigned);
plans = partitioned.runnable;
const { gaps } = partitioned;
for (const gap of gaps) console.log(`  capability gap: ${gap.file}: ${gap.reason}`);
for (const file of support) console.log(`  support: ${file} (not an independently executable test entrypoint)`);
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

function restore(context) {
  if (restoration === 'not-required' || restoration === 'verified') return true;
  if (restoration === 'failed' || !patchPath) return false;
  const r = rawGit(['-c', 'core.autocrlf=false', 'apply', patchPath]);
  if (r.error || r.status !== 0) {
    restoration = 'failed';
    console.error(`\n[revert-oracle] !!! RESTORE FAILED (${context}) !!!`);
    console.error(r.error?.message ?? (r.stderr || '').trim());
    console.error(`The reverse patch is still on disk: ${patchPath}`);
    console.error(`Re-apply it by hand:  git apply ${patchPath}`);
    return false;
  }
  const statusRun = rawGit(['status', '--porcelain']);
  if (statusRun.error || statusRun.status !== 0) {
    restoration = 'failed';
    console.error(`\n[revert-oracle] !!! RESTORE VERIFICATION FAILED (${context}) !!!`);
    console.error(statusRun.error?.message ?? (statusRun.stderr || '').trim());
    return false;
  }
  const status = statusRun.stdout.trim();
  if (status !== '') {
    restoration = 'failed';
    console.error(`\n[revert-oracle] !!! TREE NOT BYTE-IDENTICAL AFTER RESTORE (${context}) !!!`);
    console.error(status);
    console.error(`Patch kept at: ${patchPath}`);
    return false;
  }
  restoration = 'verified';
  console.log(`  restored: forward re-applied the patch; \`git status --porcelain\` is empty`);
  return true;
}

// --- run ---------------------------------------------------------------------

let exitCode = EXIT_INCONCLUSIVE;
let result = null;

try {
  console.log('\n[1/3] baseline: running the branch\'s own tests, unmodified');
  const baselineResults = plans.map((p) => runPlan(p, ROOT, 'baseline'));
  const baseline = aggregate(baselineResults);

  console.log(`\n[2/3] reverting ${prodPaths.length} production file(s)`);
  const applyR = git(['-c', 'core.autocrlf=false', 'apply', '-R', '--verbose', patchPath]);
  if (applyR.status !== 0) {
    die(EXIT_REVERT_FAILED, 'the production patch would not reverse-apply — nothing was checked.', [
      ...(applyR.stderr || '').trim().split('\n'),
      'The tree is untouched (git apply is all-or-nothing).',
    ]);
  }
  restoration = 'required';
  for (const p of prodPaths) console.log(`  reverted: ${p}`);

  console.log('\n[3/3] re-running the same tests with production reverted');
  const revertedResults = plans.map((p) => runPlan(p, ROOT, 'reverted'));
  const revertedAgg = aggregate(revertedResults);

  const ledger = buildExecutionLedger({ plans, gaps, support, baselineResults, revertedResults });
  result = ledgerVerdict(ledger);
  result.baseline = baseline;
  result.revertedRun = revertedAgg;
  result.ledger = ledger;
  result.prodPaths = prodPaths;
  result.testPaths = testPaths;
  exitCode = opts.ci
    ? ciExitCode(result.verdict)
    : result.exitCode === 0 ? EXIT_OBSERVED : result.verdict === UNOBSERVED ? EXIT_UNOBSERVED : EXIT_INCONCLUSIVE;

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
      emitResult(ORACLE_CHANNEL, 'RESTORE-FAILED', EXIT_RESTORE_FAILED, 'the oracle could not restore the working tree after measurement');
      process.exit(EXIT_RESTORE_FAILED);
    }
  }
}

if (restoration === 'required' || restoration === 'failed') {
  die(EXIT_RESTORE_FAILED, 'restoration was never verified.');
}

// --- report -------------------------------------------------------------------

printHumanReport(result, observer, opts.only.length > 0);

rmSync(tmp, { recursive: true, force: true });
emitResult(
  result.verdict === OBSERVED || result.verdict === UNOBSERVED ? PULL_REQUEST_CHANNEL : ORACLE_CHANNEL,
  result.verdict,
  exitCode,
  result.reason,
  {
    observer,
    baseline: { kind: result.baseline.kind, passed: result.baseline.passed, total: result.baseline.total },
    reverted: { kind: result.revertedRun.kind, passed: result.revertedRun.passed, failed: result.revertedRun.failed, total: result.revertedRun.total, evidence: result.revertedRun.evidence },
    ledger: result.ledger,
  },
);
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
 * CI POLICY
 * ---------------------------------------------------------------------------
 * `test.yml` supplies the five required bounds: its own throwaway checkout, a
 * hard timeout and workflow concurrency, blocking capability gaps, a full clone
 * with `--base origin/main`, and the maintainer-only `revert-oracle-exempt`
 * label for legitimate refactors. `--ci` implements that verdict policy.
 * --------------------------------------------------------------------------- */
