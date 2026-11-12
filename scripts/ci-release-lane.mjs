#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lean lane for the Version Packages PR (`changeset-release/main`).
 *
 * WHY. changesets/action rewrites that PR after every merge to `main`, so it
 * had 183 `Test` runs on 170 heads in the week of 2026-11-04, about 100
 * runner-hours, almost all of it the full suite testing version bumps. Its
 * diff is package.json versions, CHANGELOGs and deleted changesets, plus
 * Cargo versions when Rust crates are bumped. Any Cargo change runs in full
 * (release-version-diff.mjs). Three of the four release MERGES before
 * 2026-11-12 (#8665, #8359, #8311, #8192) touched Cargo.lock; what share of
 * the PR's many intermediate heads would still go lean is not measured, and
 * shadow mode is how to measure it.
 *
 * WHY THE OWNER'S SWITCH. A lean run is sound only if the PR cannot reach `main`
 * except through Mergify's `release` queue, whose merge conditions require the
 * full lanes and whose two-step CI makes Mergify test on a
 * `mergify/merge-queue/*` draft (observed: draft #8727 for #8665), where
 * ci-pr-lane.mjs runs every lane. `releaseQueueRoute`
 * (lib/release-queue-route.mjs) checks the config and that this PR meets the
 * queue's entry conditions. But a lean run turns the
 * required aggregate green, and whether a PR with green required checks can
 * be merged directly is set outside this repository (the `main` ruleset). So
 * the lean lane sits behind OWNER_ALLOWS_LEAN, which the owner released on
 * 2026-11-12 relying on that ruleset; false makes `on` report like `shadow`.
 *
 * THE SWITCH is the repo variable `CI_RELEASE_LANE`:
 *   unset / `off`  today's behaviour.
 *   `shadow`       every lane runs; the aggregate's summary lists what the
 *                  lean lane would skip and whether any of it failed, runs
 *                  the lean lane's own checks (LEAN_CHECKS), and names what
 *                  still stands between this run and a lean one.
 *   `on`           the release PR runs `changes` (late-changeset gate),
 *                  `rust-semver`, `silent-revert` and `release-pr` (Rust
 *                  major-offset and README checks) and skips the rest. With
 *                  OWNER_ALLOWS_LEAN false, as `shadow`.
 * Any other value is `off`. Lean needs ALL of: a `pull_request` into `main`,
 * head ref exactly `changeset-release/main`, the head in this repository (a
 * fork's branch of that name runs full), the Mergify route above, a diff that
 * only moves versions (`diffProblems`, lib/release-version-diff.mjs), and
 * OWNER_ALLOWS_LEAN.
 *
 * FAIL CLOSED, BY POLARITY. `changes` withholds its path-filter outputs only
 * when this step printed exactly `lane=lean`; a crash, an empty or a garbled
 * output runs the path filter and every lane. The aggregate re-derives the
 * decision (`--verify`) and fails a lean run it cannot justify, because it
 * counts `skipped` as a pass. A body-only edit does not replay a lean verdict
 * unless the lane still holds: `release-pr` runs only in a lean run, and the
 * no-op probe refuses to replay a head where it succeeded (test.yml).
 *
 *   node scripts/ci-release-lane.mjs --decide   `changes` job; writes the lane output
 *   node scripts/ci-release-lane.mjs --verify   aggregate; exit 1 on an unjustified lean run
 *
 * Inputs: GITHUB_EVENT_NAME, CI_RELEASE_LANE, HEAD_REF, HEAD_REPO, REPO,
 * BASE_REF, PR_LABELS (JSON array of names), PR_DRAFT; for --verify also LANE (the `changes` output) and NEEDS
 * (`toJSON(needs)`). Both read the PR's diff as `git diff HEAD~1 HEAD` on the
 * merge-ref checkout, so they need fetch-depth 2.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { boundedSpawnSync } from './lib/bounded-process.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { diffProblems } from './lib/release-version-diff.mjs';
import { RELEASE_HEAD_REF, releaseQueueRoute } from './lib/release-queue-route.mjs';

export const MODES = ['off', 'shadow', 'on'];

/** Jobs a lean run still runs. Every other job the aggregate needs is skipped. */
export const LEAN_KEPT_JOBS = ['changes', 'rust-semver', 'silent-revert', 'release-pr'];

/**
 * What `release-pr` runs, one step each (test.yml pins the job to this list).
 * Node builtins only and no history, so `--verify` can run them on its own
 * depth-2 checkout in shadow, where `release-pr` itself does not run.
 * check-changesets.mjs and check-changeset-bump.mjs are not here: on a release
 * PR no changeset is pending and the bump check anchors on the release head
 * itself, so both pass vacuously (run on a6b915f888 merged into its base,
 * #9783 review).
 */
export const LEAN_CHECKS = ['scripts/check-rust-major-offset.mjs', 'scripts/docs/check-package-readmes.mjs'];

/**
 * THE OWNER'S HOLD. A lean run makes the required aggregate green on the
 * release PR, and nothing in this repository can stop a direct merge of a PR
 * whose required checks are green: the queue route above is checked when the
 * run starts, a label can be removed after it, and making a lean run leave
 * the aggregate red would also keep the PR out of the queue, because Mergify
 * injects branch-protection checks as queue conditions by default
 * (`branch_protection_injection_mode: queue`). Whether a direct merge is
 * possible is set outside the repository: today the `main` ruleset lets only
 * Mergify update `main`. The owner chose to rely on that (2026-11-12, #9783),
 * so the hold is released; setting it back to false makes `on` behave as
 * `shadow` again. The steps of the jobs a lean run skips are not audited for
 * version-reading checks beyond those in LEAN_CHECKS; shadow measures that.
 */
export const OWNER_ALLOWS_LEAN = true;

/**
 * Pure decision.
 *
 * @param {{ event?: string, mode?: string, headRef?: string, headRepo?: string, repo?: string, baseRef?: string,
 *   labels?: string, draft?: string, mergify?: () => string, diff?: () => string[], ownerAllowsLean?: boolean }} input
 *   `labels` is the JSON array of PR label names and `draft` the string `true`/`false`, as test.yml passes them.
 *   `mergify` and `diff` are read only when needed.
 * @returns {{ lane: 'lean'|'full', mode: string, pending?: string[], reason: string, warning?: string }}
 *   `pending` is set exactly on a reported-only (shadow or held) decision and names every
 *   condition still between this run and a lean one (never empty there:
 *   lean is exactly the empty list).
 */
export function decideReleaseLane({ event, mode, headRef, headRepo, repo, baseRef, labels, draft, mergify, diff, ownerAllowsLean = OWNER_ALLOWS_LEAN }) {
  const raw = String(mode ?? '').toLowerCase();
  const m = raw === '' ? 'off' : raw;
  const full = (reason, extra = {}) => ({ lane: 'full', mode: m, reason, ...extra });
  if (!MODES.includes(m)) return full('unknown CI_RELEASE_LANE value', { mode: 'off', warning: `CI_RELEASE_LANE=${JSON.stringify(String(mode))} is not one of ${MODES.join(', ')}; running the full lanes` });
  if (m === 'off') return full('CI_RELEASE_LANE is unset or off');
  if (headRef !== RELEASE_HEAD_REF) return full('not the release PR');
  if (event !== 'pull_request') return full(`${event || 'unknown event'} always runs the full lanes`);
  if (baseRef !== 'main') return full(`base is ${JSON.stringify(baseRef)}, not main`);
  if (!repo || headRepo !== repo) return full(`head is in ${JSON.stringify(headRepo)}, not this repository`);
  let route;
  try {
    const names = JSON.parse(labels ?? 'null');
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw new Error('PR_LABELS is not a JSON array of strings');
    route = releaseQueueRoute(mergify(), { labels: names, draft: draft === 'true' ? true : draft === 'false' ? false : undefined });
  } catch (err) {
    route = { ok: false, reason: `the queue route is unreadable (${err.message})` };
  }
  if (!route.ok) return full(`${route.reason}, so this run is the only gate`, { warning: `release lane refused: ${route.reason}` });
  let problems;
  try {
    problems = diff();
  } catch (err) {
    problems = [`diff unreadable (${err.message})`];
  }
  if (problems.length > 0) return full(`the diff is more than a version bump: ${problems.slice(0, 5).join('; ')}`);
  // The ONE list of what still stands between this run and a lean one. Lean
  // happens only when it is empty, so a condition added here cannot be left
  // out, and the report cannot list one the decision ignores. Shadow and the
  // held `on` report it whatever the PR's queue state: measuring must not
  // wait on a label.
  const pending = [
    m === 'shadow' ? 'with CI_RELEASE_LANE=on' : '',
    ownerAllowsLean ? '' : 'with OWNER_ALLOWS_LEAN released',
    route.queueable ? '' : 'once this PR is queueable',
  ].filter(Boolean);
  if (pending.length === 0) return { mode: m, lane: 'lean', reason: `CI_RELEASE_LANE=on on the release PR; ${route.queueReason}; ${route.reason}` };
  if (m === 'shadow') return full(`shadow mode: full lanes run, lean lane reported; ${route.queueReason}`, { pending });
  if (!ownerAllowsLean) return full(`CI_RELEASE_LANE=on, but the lean lane is held until the owner decides how release PRs reach main (OWNER_ALLOWS_LEAN); full lanes run, lean lane reported; ${route.queueReason}`, { pending, warning: 'CI_RELEASE_LANE=on is held (OWNER_ALLOWS_LEAN=false); running the full lanes' });
  // `on`, hold released, something still pending: refused outright, naming
  // what is pending, because this run would be the last gate.
  return full(`lean lane not granted, still pending: ${pending.join(', ')}; queue state: ${route.queueReason}`, { warning: `release lane refused; still pending: ${pending.join(', ')}` });
}

/**
 * The aggregate's check. A `lean` lane must re-derive as lean, the kept jobs
 * must exist and have succeeded: a skipped one would pass the aggregate's map.
 */
export function verifyReleaseLane(input) {
  const d = decideReleaseLane(input);
  const runChecks = input.runChecks ?? (() => []);
  let results;
  try {
    results = JSON.parse(input.needs ?? '');
  } catch {
    return { ok: false, lines: ['❌ NEEDS is not readable JSON; cannot tell which lanes ran.'] };
  }
  const unknown = LEAN_KEPT_JOBS.filter((j) => !(j in results));
  if (unknown.length > 0) return { ok: false, lines: [`❌ ci-release-lane.mjs names job(s) the aggregate does not need: ${unknown.join(', ')}. Update LEAN_KEPT_JOBS.`] };
  const resultOf = (j) => results[j]?.result ?? 'absent';
  const skippedByLean = Object.keys(results).filter((j) => !LEAN_KEPT_JOBS.includes(j));
  const row = (j) => `- \`${j}\`: ${resultOf(j)}`;
  if (input.lane === 'lean') {
    if (d.lane !== 'lean') return { ok: false, lines: [`❌ UNJUSTIFIED_RELEASE_LANE: \`changes\` chose the lean lane but this run re-derives \`${d.lane}\` (${d.reason}). Skipped lanes are not a pass here.`] };
    // `skipped` passes the aggregate's map, so a kept job that did not run
    // would leave the lean run with no gate at all.
    const notRun = LEAN_KEPT_JOBS.filter((j) => resultOf(j) !== 'success');
    if (notRun.length > 0) return { ok: false, lines: [`❌ RELEASE_CHECKS_DID_NOT_PASS: a lean run needs every kept job to succeed: ${notRun.map((j) => `\`${j}\` was ${resultOf(j)}`).join(', ')}.`] };
    return { ok: true, lines: ['## Release PR lean lane (`CI_RELEASE_LANE=on`)', '', d.reason, '', 'Skipped on purpose; the `release` merge queue runs them:', '', ...skippedByLean.map(row)] };
  }
  if (d.pending) {
    // The aggregate's own rule (`case "$r" in success|skipped) ;;`): anything
    // else, `cancelled` included, is a rejection the lean lane would defer.
    const failed = skippedByLean.filter((j) => !['success', 'skipped'].includes(resultOf(j)));
    // A lane that skipped here skips on this PR whatever the lean lane does.
    const ran = skippedByLean.filter((j) => resultOf(j) !== 'skipped').map(row);
    // `release-pr` runs only in a lean run, so its checks run here instead.
    const checks = runChecks();
    const checksFailed = checks.filter((c) => !c.ok).map((c) => c.script);
    // The decision names what still stands between this run and a lean one,
    // so the report never reads as a claim about today.
    const lean = `lean lane (${d.pending.join(', ')})`;
    const lines = [`## Release PR lean lane, reported only (\`CI_RELEASE_LANE=${d.mode}\`)`, '', d.reason, '', `Lanes that ran here and the ${lean} would skip:`, '', ...(ran.length > 0 ? ran : ['- (none: every such lane skipped on this run)'])];
    lines.push('', `Its own checks (\`release-pr\`), run here:`, '', ...checks.map((c) => `- \`${c.script}\`: ${c.ok ? 'pass' : `FAIL: ${c.tail}`}`));
    if (failed.length > 0) lines.push('', `⚠️ The ${lean} would defer a failure to the merge queue: ${failed.join(', ')}.`);
    if (checksFailed.length > 0) lines.push('', `⚠️ The ${lean} would fail its own checks: ${checksFailed.join(', ')}.`);
    if (failed.length === 0 && checksFailed.length === 0) lines.push('', `None of them failed. The ${lean} would reach the same verdict.`);
    return { ok: true, lines };
  }
  const lines = [`Release lane full: ${d.reason}.`];
  if (d.lane === 'lean') lines.push('⚠️ The decision re-derives as lean, but `changes` published no lean lane (the decision step failed or is missing), so every lane ran.');
  return { ok: true, lines };
}

/** Output lines without Node's own warnings and crash banner. */
const signalLines = (s) => String(s ?? '').split('\n').filter((l) => l.trim() && !/^\(node:\d+\) (\[\w+\] )?\w*Warning:|^\(Use `node --trace-|^Node\.js v\d/.test(l));

/** Runs LEAN_CHECKS in `cwd`, as `release-pr` would, each with one line of its output. */
export function runLeanChecks(cwd, scripts = LEAN_CHECKS) {
  return scripts.map((script) => {
    // Bounded well inside the aggregate's 5-minute budget; each takes well under a second.
    const r = boundedSpawnSync(process.execPath, [script], { cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.error) return { script, ok: false, tail: r.error.message };
    const stderr = signalLines(r.stderr);
    const out = [...signalLines(r.stdout), ...stderr];
    // A crash's error line says more than the stack under it.
    const errorLine = r.status !== 0 ? stderr.find((l) => /^\w*Error\b.*:/.test(l)) : undefined;
    return { script, ok: r.status === 0, tail: errorLine ?? out.at(-1) ?? '' };
  });
}

function gitReader(cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    entries: () => git(['diff', '--no-renames', '--name-status', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean).map((l) => {
      const [status, path] = l.split('\t');
      return { status: status[0], path };
    }),
    show: (rev, path) => git(['show', `${rev}:${path}`]),
  };
}

export function run(argv, env = process.env, cwd = process.cwd()) {
  const git = gitReader(cwd);
  const input = {
    event: env.GITHUB_EVENT_NAME,
    mode: env.CI_RELEASE_LANE,
    headRef: env.HEAD_REF,
    headRepo: env.HEAD_REPO,
    repo: env.REPO,
    baseRef: env.BASE_REF,
    labels: env.PR_LABELS,
    draft: env.PR_DRAFT,
    mergify: () => readFileSync(`${cwd}/.mergify.yml`, 'utf8'),
    diff: () => diffProblems(git.entries(), git),
  };
  if (argv[0] === '--decide') {
    const d = decideReleaseLane(input);
    if (d.warning) console.log(`::warning::${d.warning}`);
    console.log(`[ci-release-lane] lane=${d.lane} mode=${d.mode}: ${d.reason}`);
    if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set; refusing to decide into nowhere');
    appendFileSync(env.GITHUB_OUTPUT, `lane=${d.lane}\n`);
    return 0;
  }
  if (argv[0] === '--verify') {
    const v = verifyReleaseLane({ ...input, lane: env.LANE, needs: env.NEEDS, runChecks: () => runLeanChecks(cwd) });
    for (const l of v.lines) console.log(l);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${v.lines.join('\n')}\n`);
    return v.ok ? 0 : 1;
  }
  throw new Error('one of --decide or --verify is required');
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[ci-release-lane] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
