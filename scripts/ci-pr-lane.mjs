#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The switchable fast PR lane: which `Test` lanes a `pull_request` run skips.
 *
 * WHY. A full `Test` run is ~45 jobs and ~330 job-minutes, over half of it the
 * sixteen viewer shards, and it ran on every push to every PR while hosted
 * capacity was 13-36 concurrent jobs. The merge queue already runs every lane
 * once per merge (`merge_group`), so a PR push only needs the checks that fail
 * most often for the least compute; the queue is the full gate.
 *
 * THE SWITCH is the repo variable `CI_PR_LANE`:
 *   unset / `full`  today's behaviour. Every condition below evaluates exactly
 *                   as it did before this file existed.
 *   `shadow`        full lanes still run; the aggregate's summary says what the
 *                   fast lane would have skipped and whether that would have
 *                   hidden a failure. For measuring before switching.
 *   `fast`          `pull_request` runs skip FAST_SKIPPED_JOBS and the test leg
 *                   of `rust-tests`. A PR labelled `ci:full` gets the full run.
 * Any other value is a typo and selects `full`. `merge_group` and `push` are
 * `full` in every mode, and so is a Mergify batch PR (`mergify/merge-queue/*`):
 * it arrives as `pull_request` but is the queue's full gate.
 *
 * FAIL CLOSED, BY POLARITY. Every skipped lane in test.yml is gated on
 * `needs.changes.outputs.lane != 'fast'`, never on `== 'full'`, so an absent,
 * empty or garbled decision (this script crashed, the step was deleted, the
 * output was renamed) runs the full lanes. Only the exact string `fast` skips
 * anything. The aggregate then re-derives the decision from the same inputs
 * (`--verify`) and fails when a `fast` lane cannot be justified, because the
 * aggregate counts `skipped` as a pass and a skip nobody asked for must not.
 *
 * THE LABEL is read when the run is CREATED (test.yml has no `labeled`
 * trigger, see its header), so adding `ci:full` takes effect on the next push
 * or a close-and-reopen.
 *
 *   node scripts/ci-pr-lane.mjs --decide   `changes` job; writes lane/mode outputs
 *   node scripts/ci-pr-lane.mjs --verify   aggregate job; exit 1 on an unjustified `fast`
 *
 * Inputs: GITHUB_EVENT_NAME, CI_PR_LANE, HEAD_REF, PR_LABELS (JSON array of names),
 * and for --verify LANE (the `changes` output) and NEEDS (`toJSON(needs)`).
 */

import { appendFileSync } from 'node:fs';

import { isMainEntry } from './lib/is-main-entry.mjs';

export const FULL_LABEL = 'ci:full';
export const MODES = ['full', 'shadow', 'fast'];
export const BATCH_BRANCH_PREFIX = 'mergify/merge-queue/';

/** A Mergify batch PR is the merge queue's full gate, whatever the switch says. */
export const isBatchBranch = (headRef) => String(headRef ?? '').startsWith(BATCH_BRANCH_PREFIX);

/**
 * Jobs a fast `pull_request` run skips whole. Measured mean job-minutes per
 * green PR run (30 runs, 2026-10-31): viewer-tests 16 x 12.2, viewer-e2e
 * 8 x 5.1, node-tests 4 x 5.7, rust-retained 21.9, provenance-tests 3.0.
 * viewer-e2e is otherwise PR-only, so in fast mode it moves to `merge_group`.
 */
export const FAST_SKIPPED_JOBS = ['viewer-tests', 'viewer-e2e', 'node-tests', 'provenance-tests', 'rust-retained'];

/** Jobs that still run in fast mode with their heavy steps skipped. */
export const FAST_REDUCED_JOBS = {
  'rust-tests': 'clippy, cargo machete and the Cargo.lock check run; nextest, the C4-0 report and doctests skip',
};

function parseLabels(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'null') return [];
  const v = JSON.parse(raw);
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error('PR_LABELS is not a JSON array of strings');
  return v;
}

/**
 * Pure decision.
 *
 * @param {{ event?: string, mode?: string, labels?: string }} input  raw env values
 * @returns {{ lane: 'full'|'fast', mode: 'full'|'shadow'|'fast', wouldBeFast: boolean, reason: string, warning?: string }}
 */
export function decideLane({ event, mode, labels, headRef }) {
  // Lowercased because Actions' `==` is case-insensitive and test.yml compares
  // `vars.CI_PR_LANE == 'fast'` directly; NOT trimmed, for the same reason.
  const raw = String(mode ?? '').toLowerCase();
  const m = raw === '' ? 'full' : raw;
  if (!MODES.includes(m)) {
    return { lane: 'full', mode: 'full', wouldBeFast: false, reason: `unknown CI_PR_LANE value, full lanes`, warning: `CI_PR_LANE=${JSON.stringify(String(mode))} is not one of ${MODES.join(', ')}; running the full lanes` };
  }
  if (event !== 'pull_request') return { lane: 'full', mode: m, wouldBeFast: false, reason: `${event || 'unknown event'} always runs the full lanes` };
  if (isBatchBranch(headRef)) return { lane: 'full', mode: m, wouldBeFast: false, reason: 'a Mergify batch PR always runs the full lanes' };
  if (m === 'full') return { lane: 'full', mode: m, wouldBeFast: false, reason: 'CI_PR_LANE is unset or full' };
  let names;
  try {
    names = parseLabels(labels);
  } catch (err) {
    return { lane: 'full', mode: m, wouldBeFast: false, reason: 'PR labels unreadable, full lanes', warning: `could not read PR labels (${err.message}); running the full lanes` };
  }
  if (names.includes(FULL_LABEL)) return { lane: 'full', mode: m, wouldBeFast: false, reason: `the PR carries \`${FULL_LABEL}\`` };
  if (m === 'shadow') return { lane: 'full', mode: m, wouldBeFast: true, reason: 'shadow mode: full lanes run, fast lane reported' };
  return { lane: 'fast', mode: m, wouldBeFast: true, reason: 'CI_PR_LANE=fast on a pull_request' };
}

/** How test.yml reads the `lane` output: only the exact string `fast` skips. */
export function laneFromOutput(raw) {
  return raw === 'fast' ? 'fast' : 'full';
}

/**
 * The aggregate's check. A `fast` lane must re-derive as `fast` from the same
 * inputs, and the skipped jobs must exist in `needs` (a renamed job would
 * leave this list naming nothing and the rename would run full forever,
 * which is safe but silent). A non-`fast` lane ran everything and passes here.
 *
 * @param {{ event?: string, mode?: string, labels?: string, lane?: string, needs?: string }} input
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function verifyLane({ event, mode, labels, headRef, lane, needs }) {
  const d = decideLane({ event, mode, labels, headRef });
  const lines = [];
  let results;
  try {
    results = JSON.parse(needs ?? '');
  } catch {
    return { ok: false, lines: ['❌ NEEDS is not readable JSON; cannot tell which lanes ran.'] };
  }
  const expected = [...FAST_SKIPPED_JOBS, ...Object.keys(FAST_REDUCED_JOBS)];
  const unknown = expected.filter((j) => !(j in results));
  if (unknown.length > 0) {
    return { ok: false, lines: [`❌ ci-pr-lane.mjs names job(s) the aggregate does not need: ${unknown.join(', ')}. Update FAST_SKIPPED_JOBS.`] };
  }
  const resultOf = (j) => results[j]?.result ?? 'absent';
  if (laneFromOutput(lane) === 'fast') {
    if (d.lane !== 'fast') {
      return { ok: false, lines: [`❌ UNJUSTIFIED_FAST_LANE: \`changes\` chose the fast lane but this run re-derives \`${d.lane}\` (${d.reason}). Skipped lanes are not a pass here.`] };
    }
    lines.push('## Fast PR lane (`CI_PR_LANE=fast`)', '', 'These lanes were skipped on purpose; the merge queue runs them.', '');
    for (const j of FAST_SKIPPED_JOBS) lines.push(`- \`${j}\`: ${resultOf(j)}`);
    for (const [j, what] of Object.entries(FAST_REDUCED_JOBS)) lines.push(`- \`${j}\` (reduced: ${what}): ${resultOf(j)}`);
    lines.push('', `Label the PR \`${FULL_LABEL}\` and push (or close and reopen) for the full lanes.`);
    return { ok: true, lines };
  }
  if (d.mode === 'shadow' && d.wouldBeFast) {
    const missed = expected.filter((j) => resultOf(j) === 'failure');
    lines.push('## Fast PR lane, shadow mode (`CI_PR_LANE=shadow`)', '', 'The full lanes ran. In fast mode these would have been skipped or reduced:', '');
    for (const j of FAST_SKIPPED_JOBS) lines.push(`- \`${j}\`: ${resultOf(j)}`);
    for (const [j, what] of Object.entries(FAST_REDUCED_JOBS)) lines.push(`- \`${j}\` (reduced: ${what}): ${resultOf(j)}`);
    lines.push('', missed.length > 0 ? `⚠️ The fast lane would have deferred a failure to the merge queue: ${missed.join(', ')}.` : 'No failure in those lanes; the fast lane would have reached the same verdict on them.');
    return { ok: true, lines };
  }
  lines.push(`Full PR lanes: ${d.reason}.`);
  if (d.lane === 'fast') lines.push('⚠️ The decision re-derives as fast, but `changes` published no fast lane (the decision step failed or is missing), so the full lanes ran.');
  return { ok: true, lines };
}

function summary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) appendFileSync(f, `${lines.join('\n')}\n`);
}

export function run(argv, env = process.env) {
  const cmd = argv[0];
  const input = { event: env.GITHUB_EVENT_NAME, mode: env.CI_PR_LANE, labels: env.PR_LABELS, headRef: env.HEAD_REF };
  if (cmd === '--decide') {
    const d = decideLane(input);
    if (d.warning) console.log(`::warning::${d.warning}`);
    console.log(`[ci-pr-lane] lane=${d.lane} mode=${d.mode}: ${d.reason}`);
    const out = env.GITHUB_OUTPUT;
    if (!out) throw new Error('GITHUB_OUTPUT is not set; refusing to decide into nowhere');
    appendFileSync(out, `lane=${d.lane}\nmode=${d.mode}\nbatch=${isBatchBranch(input.headRef)}\n`);
    return 0;
  }
  if (cmd === '--verify') {
    const v = verifyLane({ ...input, lane: env.LANE, needs: env.NEEDS });
    for (const l of v.lines) console.log(l);
    summary(v.lines);
    return v.ok ? 0 : 1;
  }
  throw new Error('one of --decide or --verify is required');
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    console.error(`[ci-pr-lane] ERROR: ${err.message}`);
    process.exitCode = 1;
  }
}
