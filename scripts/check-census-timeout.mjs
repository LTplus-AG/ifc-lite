#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Gate: the heavy census lane's two-level timeout must actually be two levels.
 *
 * `.github/workflows/geometry-census-heavy.yml` wraps its `cargo test` in
 * coreutils `timeout` so a hang ends as a step FAILURE rather than a job
 * GitHub cancels. A cancelled job is not a failed job and reports to nobody,
 * which is #4127. That only holds while the in-step deadline is strictly
 * inside the job's `timeout-minutes`, so the relationship is an invariant to
 * CHECK rather than a sentence to assert in a log line.
 *
 * This was ~60 lines of inline `run:` shell (#4156). It turned two strings and
 * a file path into a verdict, it was the most branch-heavy thing in that
 * workflow, and it had no test: two separate review rounds each reconstructed
 * its accept/reject table by hand. `scripts/check-census-timeout.test.mjs`
 * checks that table in, one assertion per row, and every reject asserts the
 * REASON rather than merely "it failed" -- so deleting one check cannot be
 * covered for by a different check firing on the same input.
 *
 * WHAT IT REFUSES, and why each one is not obvious:
 *
 *   - ZERO IS A DISABLE SWITCH, NOT A TIGHT BOUND. In coreutils a DURATION of
 *     0 means "no time limit": `timeout 0 sleep 4` sleeps the whole 4 s and
 *     exits 0 (measured on coreutils 9.11). So `0`, `0s` and `0m` sail through
 *     any upper-bound check, REMOVE the deadline, hand the job back to
 *     `timeout-minutes` and restore the exact `cancelled` outcome the wrapper
 *     exists to prevent -- while the success line claims the constraint holds.
 *     Sub-second values truncate to 0 here and go with them, which costs
 *     nothing for a sweep measured in minutes.
 *
 *   - THE JOB BUDGET IS READ, NOT COPIED. `timeout-minutes` cannot read the
 *     `env` context, so the workflow carries a hand copy in
 *     `CENSUS_JOB_TIMEOUT_MINUTES`. A copy nobody checks goes stale in
 *     silence: lower `timeout-minutes` to 30 and the default `50m` still
 *     validates against a 3300 s budget, then GitHub cancels at 30 minutes.
 *     So the budget comes out of the workflow file this job checked out, and
 *     the copy is cross-checked against it rather than believed.
 *
 *   - MORE THAN ONE `timeout-minutes:` LINE IS AMBIGUOUS, NOT A DEFAULT. If a
 *     second job appears in that file this check cannot tell which line bounds
 *     the census, so it says so instead of taking the first. Zero matches is
 *     the same answer for the same reason.
 *
 *   - AN ABSURD VALUE FAILS CLOSED. `99999999999999999999d` is a finite
 *     `Number` (8.64e24) and a longer one is `Infinity`; both are `> budget`
 *     and both are refused by the budget comparison. The shell this replaces
 *     reached the same verdict by a different route -- awk's `%d` clamped it to
 *     LLONG_MAX -- so the printed seconds differ and the verdict does not.
 *
 * NEGATIVES HAVE NO CHECK OF THEIR OWN, deliberately: `-5m` and `-1` carry a
 * sign the DURATION pattern does not admit, so they are refused as malformed
 * before any arithmetic runs. Measured on the shell this replaces, not
 * inferred. Adding a redundant `< 0` branch would be a check no input can
 * reach, which is the shape this repo keeps finding in its own tests.
 *
 * Inputs come from the environment (`CENSUS_TIMEOUT`,
 * `CENSUS_JOB_TIMEOUT_MINUTES`) exactly as the shell took them, so
 * dispatch-supplied text still reaches this as DATA and is never spliced into
 * a command line through `${{ }}`. An unset variable is a distinct, loud
 * failure rather than an empty string, which is what `set -u` bought before.
 *
 * Run: `node scripts/check-census-timeout.mjs [workflow-file]`
 * (the census step of .github/workflows/geometry-census-heavy.yml).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainEntry } from './lib/is-main-entry.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The workflow whose `timeout-minutes` bounds the census job. */
export const CENSUS_WORKFLOW = '.github/workflows/geometry-census-heavy.yml';

/**
 * Seconds of the job budget reserved for what the `timeout` wrapper does not
 * cover: checkout, the toolchain, the filter assertion and the fixture fetch.
 *
 * The 47-66 s those steps have measured is a WARM-CACHE figure and does not
 * cover this job's worst case: the filter assertion runs `cargo test --list`,
 * minutes rather than seconds on a cold crate graph, and a fixture-cache miss
 * downloads 223 MiB. Kept at 300 rather than widened because no cold run of
 * this lane has been timed, and a larger invented number is the same unproven
 * justification further out. When it is wrong the cost is bounded and still
 * reported: the job ends `cancelled` instead of `failure`, and the lane's
 * report step fires on `job.status != 'success'` for exactly that case. Time a
 * cold run, then widen this and `timeout-minutes` together.
 */
export const HEADROOM_SECONDS = 300;

/**
 * A coreutils DURATION: a positive decimal with an optional s/m/h/d suffix.
 * Anchored, no sign, no internal space, no exponent -- so ` 50m`, `50 m`,
 * `+50m`, `50M`, `50min` and `1e3` are all malformed rather than reinterpreted.
 */
const DURATION_RE = /^([0-9]+(?:\.[0-9]+)?)([smhd]?)$/;

const UNIT_SECONDS = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/**
 * A JOB-level `timeout-minutes`: indented, bare integer, nothing else on the
 * line. `[^\S\n]` is `[[:space:]]` minus the newline, matching the `sed -nE`
 * this replaces line for line, including the trailing `\r` of a CRLF checkout.
 */
const TIMEOUT_MINUTES_RE = /^[^\S\n]+timeout-minutes:[^\S\n]*([0-9]+)[^\S\n]*$/gm;

/**
 * Seconds for a coreutils DURATION, or `null` when the text is not one.
 *
 * Truncates toward zero, as awk's `%d` did: `3299.9` is 3299 and `0.9` is 0.
 * The 0 is not swallowed here -- `checkCensusTimeout` refuses it, with the
 * reason that makes the coreutils no-limit hole legible.
 */
export function parseDurationSeconds(text) {
  const match = DURATION_RE.exec(text);
  if (match === null) return null;
  return Math.trunc(Number(match[1]) * UNIT_SECONDS[match[2]]);
}

/** Every job-level `timeout-minutes` value in a workflow, in file order. */
export function jobTimeoutMinutes(workflowText) {
  return [...workflowText.matchAll(TIMEOUT_MINUTES_RE)].map((m) => Number(m[1]));
}

function reject(reason, messages) {
  return { ok: false, reason, messages };
}

/**
 * @param {object} input
 * @param {string} input.timeout           the coreutils DURATION to validate
 * @param {number} input.declaredJobMinutes the workflow's hand copy of `timeout-minutes`
 * @param {string} input.workflowPath      the workflow file to read the real budget from
 * @returns {{ok: true, seconds: number, jobMinutes: number, budgetSeconds: number, summary: string}
 *          | {ok: false, reason: string, messages: string[]}}
 */
export function checkCensusTimeout({ timeout, declaredJobMinutes, workflowPath }) {
  const seconds = parseDurationSeconds(timeout);
  if (seconds === null) {
    return reject('malformed', [
      `census timeout '${timeout}' is not a coreutils interval.`,
      'Use a positive number with an optional s, m, h or d suffix, such as 10s or 50m.',
    ]);
  }

  if (!(seconds > 0)) {
    return reject('nonPositive', [
      `census timeout '${timeout}' resolves to ${seconds}s.`,
      'coreutils reads a duration of 0 as NO limit, so this REMOVES the deadline',
      'instead of tightening it, and GitHub would cancel the job. A cancelled job',
      'reports to nobody, which is #4127. Pass a positive interval such as 10s.',
    ]);
  }

  let workflowText;
  try {
    workflowText = readFileSync(workflowPath, 'utf8');
  } catch (error) {
    return reject('unreadable', [
      `cannot read ${workflowPath}, so the job's real timeout-minutes is unknown`,
      `and the two-level timeout cannot be checked (#4127): ${error.message}`,
    ]);
  }

  const declared = jobTimeoutMinutes(workflowText);
  if (declared.length !== 1) {
    return reject('ambiguousBudget', [
      `found ${declared.length} timeout-minutes lines in ${workflowPath}, expected exactly 1.`,
      'This check reads the job budget out of that file; it cannot pick between several.',
    ]);
  }

  const jobMinutes = declared[0];
  if (jobMinutes !== declaredJobMinutes) {
    return reject('staleCopy', [
      `CENSUS_JOB_TIMEOUT_MINUTES is ${declaredJobMinutes}, but ${workflowPath}`,
      `declares timeout-minutes: ${jobMinutes}. The copy has gone stale, and a`,
      'stale copy validates this census against a budget the job does not have (#4127).',
      'Change both together.',
    ]);
  }

  const budgetSeconds = jobMinutes * 60 - HEADROOM_SECONDS;
  if (seconds > budgetSeconds) {
    return reject('overBudget', [
      `census timeout '${timeout}' is ${seconds}s, over the ${budgetSeconds}s`,
      `left by the job's ${jobMinutes}-minute timeout-minutes.`,
      'GitHub would cancel the job first, and a cancelled job reports to nobody (#4127).',
      'Raise timeout-minutes and CENSUS_JOB_TIMEOUT_MINUTES together, or lower this value.',
    ]);
  }

  return {
    ok: true,
    seconds,
    jobMinutes,
    budgetSeconds,
    summary:
      `census timeout: ${timeout} (${seconds}s), within the ${budgetSeconds}s ` +
      `left by timeout-minutes: ${jobMinutes}`,
  };
}

/** An env var that is ABSENT is a wiring defect, and says so rather than reading as ''. */
function requireEnv(env, name) {
  const value = env[name];
  if (value === undefined) {
    console.error(`::error::${name} is not set. The census step must pass it through \`env:\`.`);
    return null;
  }
  return value;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const workflowPath = argv[0] ?? join(REPO_ROOT, CENSUS_WORKFLOW);

  const timeout = requireEnv(env, 'CENSUS_TIMEOUT');
  const rawMinutes = requireEnv(env, 'CENSUS_JOB_TIMEOUT_MINUTES');
  if (timeout === null || rawMinutes === null) return 1;

  if (!/^[0-9]+$/.test(rawMinutes)) {
    console.error(
      `::error::CENSUS_JOB_TIMEOUT_MINUTES is '${rawMinutes}', which is not a whole number of minutes.`,
    );
    return 1;
  }

  const result = checkCensusTimeout({
    timeout,
    declaredJobMinutes: Number(rawMinutes),
    workflowPath,
  });

  if (!result.ok) {
    for (const line of result.messages) console.error(`::error::${line}`);
    return 1;
  }

  console.log(result.summary);
  return 0;
}

if (isMainEntry(import.meta.url)) {
  process.exit(main());
}
