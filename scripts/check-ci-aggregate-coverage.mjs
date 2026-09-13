#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Ratchet: every job the aggregate gate DEPENDS ON must appear in the map it
 * JUDGES.
 *
 * THE DEFECT CLASS. `test.yml`'s `test` job is the required context that guards
 * `main`. It runs `if: always()` and decides pass/fail by walking a hand-written
 * `results` map of `needs.<job>.result`. `needs:` and that map are two lists of
 * the same thing, written in two places, and nothing kept them in step. A job
 * present in `needs:` but absent from the map is UNJUDGED: its failure cannot
 * raise `fail`, so the aggregate exits 0.
 *
 * That is worse than an unwatched job, because of how `needs:` propagates. When
 * a dependency fails, every job that needs it is SKIPPED, and `skipped` counts
 * as a pass here (`case "$r" in success|skipped)`) for the good reason that path
 * filters skip most lanes on most PRs. So an unjudged job failing does not just
 * hide its own result: it skips its dependents, every skip reads as success, the
 * fail count is zero, and a required context reports green having run almost
 * nothing.
 *
 * THE INSTANCE THIS WAS WRITTEN FOR. `changes` (Detect changes) was in `needs:`
 * and not in the map. It is the path-filter job every other lane depends on, so
 * it is the single worst job to leave unjudged: if it fails, all thirteen lanes
 * skip, the map reads all-skipped, and `Build + WASM + Rust + Node` goes green.
 *
 * NEVER OBSERVED, AND SAID PLAINLY. Sampling 24 recent `test.yml` runs,
 * `Detect changes` came back 19 success, 3 cancelled, 2 queued and zero
 * failures, and in the cancelled runs the aggregate correctly reported
 * `failure` -- workflow-level cancellation from a force-push cancels the
 * aggregate too, and `if: always()` does not rescue a job from that. So this
 * closes a latent path, not an incident. The live routes to it are a step
 * FAILURE (a paths-filter API error, a checkout failure) and a job-level
 * TIMEOUT, which does not cancel the run. `changes` carried no
 * `timeout-minutes` and inherited the six-hour default; that is fixed in the
 * same commit.
 *
 * WHY A SCRIPT AND NOT A COMMENT. The pairing is the kind that drifts silently:
 * adding a lane means editing `needs:` and the map, and forgetting the second
 * costs nothing at author time and everything later. `scripts/check-ci-path-coverage.mjs`
 * exists for the neighbouring class ("a gate may not read a path that cannot
 * trigger it") and its header already names this one in passing -- "the
 * aggregate `test` gate reports success because a skipped job counts as
 * success". This makes that observation enforceable.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github/workflows/test.yml');

/**
 * Pull the aggregate job's `needs:` list and the job names its `results` map
 * judges.
 *
 * Deliberately regex over the raw text rather than a YAML parse: the map lives
 * inside a `run:` block-scalar, so a YAML parser hands back one opaque string
 * and the keys still need extracting by regex. Parsing the whole file to then
 * regex a string buys nothing and adds a dependency.
 */
export function readAggregate(text, jobName = 'test') {
  // `(?![\\s\\S])` and not `$`: under the `m` flag `$` matches at the end of EVERY
  // line, so a lazy body stops at the first newline and the job reads as empty.
  // That produced a "needs: []" verdict on a job with fourteen of them.
  const job = new RegExp(`^  ${jobName}:\\n([\\s\\S]*?)(?=\\n  \\S|(?![\\s\\S]))`, 'm').exec(text);
  if (!job) return null;
  const body = job[1];

  const needsLine = /^\s*needs:\s*\[([^\]]*)\]/m.exec(body);
  const needs = needsLine
    ? needsLine[1].split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // BOTH halves of `[job]="${{ needs.job.result }}"`, and they must agree. The
  // bracket key is what the bash loop iterates and what gets reported; the
  // interpolation is what is actually READ. Checking only the key misses the
  // likeliest way to add a lane wrong: copy the row above, edit the bracket,
  // forget the right-hand side. That yields `[new]="${{ needs.build.result }}"`,
  // which judges `build` twice and leaves `new` unjudged while this gate reports
  // full coverage — the same fail-open one level in.
  //
  // Either quote: `[job]='${{ ... }}'` is valid bash and valid interpolation, and
  // requiring `"` made a legal map parse as zero entries. Fail-closed, but the
  // remedy text sent you hunting a coverage hole that was not there.
  const rows = [...body.matchAll(
    /^\s*\[([A-Za-z0-9_-]+)\]=["']\$\{\{\s*needs\.([A-Za-z0-9_-]+)\.result/gm
  )].map((m) => ({ key: m[1], reads: m[2] }));

  const judged = rows.map((r) => r.key);
  const mismatched = rows.filter((r) => r.key !== r.reads);
  const seen = new Set();
  const duplicated = judged.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));

  return { needs, judged: [...new Set(judged)], mismatched, duplicated };
}

/** Jobs that are depended on but never judged. */
export function unjudged({ needs, judged }) {
  const seen = new Set(judged);
  return needs.filter((n) => !seen.has(n));
}

/** Jobs judged but not depended on: the map would read an empty result forever. */
export function unreachable({ needs, judged }) {
  const seen = new Set(needs);
  return judged.filter((j) => !seen.has(j));
}

/**
 * Jobs that run on a `pull_request` yet are deliberately NOT judged by the
 * aggregate. Each needs a reason, because the default has to be "blocking" for
 * the gate to mean anything, and an exemption is a decision rather than an
 * oversight.
 *
 * Keep this list SHORT and ratchet it down. An entry here is a lane whose
 * failure cannot stop a merge.
 */
export const UNJUDGED_BY_DESIGN = {
  // Empty since the CI redesign (step 5): `csg-accept-gates`, the one entry,
  // moved off the PR lane into the merge queue and INTO the aggregate's
  // `needs:` there, where a moved pin dequeues the batch. Keep this list empty
  // unless a lane genuinely must not block; the default has to be "blocking"
  // for the aggregate to mean anything.
};

/**
 * Every job in the `jobs:` block that a `pull_request` can reach.
 *
 * Scoped to the `jobs:` section on purpose: a naive `^  name:$` sweep of the
 * whole file also matches `push:` and `pull_request:` under the top-level `on:`
 * trigger, which is how an earlier ad-hoc probe reported a job that does not
 * exist.
 */
export function prJobs(text) {
  const jobsAt = text.indexOf('\njobs:\n');
  if (jobsAt < 0) return [];
  const section = text.slice(jobsAt);
  const names = [...section.matchAll(/^  ([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]);
  return names.filter((n) => {
    const body = new RegExp(`^  ${n}:\\n([\\s\\S]*?)(?=\\n  \\S|(?![\\s\\S]))`, 'm').exec(section);
    if (!body) return false;
    // A job gated to a non-PR event cannot block a PR, so it is not in scope.
    return !/if:.*github\.event_name\s*(!=\s*'pull_request'|==\s*'push')/.test(body[1]);
  });
}

/** PR-reachable jobs the aggregate neither depends on nor exempts. */
export function unwatched(text, { needs }) {
  const judged = new Set(needs);
  return prJobs(text).filter(
    (j) => j !== 'test' && !judged.has(j) && !(j in UNJUDGED_BY_DESIGN)
  );
}

function main() {
  const text = readFileSync(WORKFLOW, 'utf8');
  const agg = readAggregate(text);

  if (!agg) {
    console.error(
      '❌ AGGREGATE_JOB_NOT_FOUND: no `test:` job in .github/workflows/test.yml.\n' +
        '   This gate reads that job by name. If it was renamed, rename it here too —\n' +
        '   a gate that cannot find its subject must fail, not pass quietly.'
    );
    process.exit(1);
  }
  if (agg.needs.length === 0) {
    console.error(
      '❌ AGGREGATE_NEEDS_EMPTY: the `test:` job declares no `needs:` list.\n' +
        '   Either the job changed shape or this parser broke. Failing rather than\n' +
        '   reporting "0 unjudged of 0", which is the vacuous pass this file exists to stop.'
    );
    process.exit(1);
  }

  const missing = unjudged(agg);
  const extra = unreachable(agg);
  const loose = unwatched(text, agg);
  const { mismatched = [], duplicated = [] } = agg;

  console.log(`aggregate \`test\`: ${agg.needs.length} needs, ${agg.judged.length} judged`);

  if (mismatched.length > 0) {
    console.error(
      `\n❌ MAP_KEY_MISMATCH: ${mismatched.length} row(s) judge a different job than they name:\n` +
        mismatched.map((m) => `      - [${m.key}] reads needs.${m.reads}.result`).join('\n') +
        '\n   The bash loop reports the bracket key, so this reads as coverage while the\n' +
        '   named lane is never judged and another is judged twice.\n' +
        '   REMEDY: make both halves the same job name.'
    );
  }
  if (duplicated.length > 0) {
    console.error(
      `\n❌ DUPLICATE_MAP_KEY: ${duplicated.length} job(s) appear twice in the map:\n` +
        duplicated.map((m) => `      - ${m}`).join('\n') +
        '\n   bash keeps the LAST assignment, so the earlier row is dead and the count\n' +
        '   above overstates coverage.\n' +
        '   REMEDY: delete the duplicate row.'
    );
  }
  if (loose.length > 0) {
    console.error(
      `\n❌ UNWATCHED_JOB: ${loose.length} job(s) run on a pull_request but the aggregate ` +
        'neither depends on them nor exempts them:\n' +
        loose.map((m) => `      - ${m}`).join('\n') +
        '\n   Their failure cannot stop a merge, and unlike an unjudged dependency this\n' +
        '   one is invisible from the `needs:` list alone.\n' +
        '   REMEDY: add the job to `needs:` AND to the results map to make it blocking,\n' +
        '   or add it to UNJUDGED_BY_DESIGN in this file with the reason it is advisory.'
    );
  }
  if (missing.length === 0 && extra.length === 0 && mismatched.length === 0 && duplicated.length === 0 && loose.length === 0) {
    console.log('✔ every dependency of the aggregate gate is judged by it');
    return;
  }

  if (missing.length > 0) {
    console.error(
      `\n❌ UNJUDGED_DEPENDENCY: ${missing.length} job(s) the aggregate depends on are ` +
        'absent from its `results` map, so their failure cannot fail the gate:\n' +
        missing.map((m) => `      - ${m}`).join('\n') +
        '\n   A failed job also SKIPS everything that needs it, and `skipped` counts as a\n' +
        '   pass here, so an unjudged failure can take the whole matrix green.\n' +
        // A literal GitHub Actions expression for the user to paste, not JS
        // interpolation.
        // eslint-disable-next-line no-template-curly-in-string
        '   REMEDY: add `[<job>]="${{ needs.<job>.result }}"` to the map in test.yml.'
    );
  }
  if (extra.length > 0) {
    console.error(
      `\n❌ UNREACHABLE_JUDGEMENT: ${extra.length} entr(y|ies) in the \`results\` map name a ` +
        'job the aggregate does not depend on:\n' +
        extra.map((m) => `      - ${m}`).join('\n') +
        '\n   `needs.<absent>.result` interpolates to the empty string, which is neither\n' +
        '   `success` nor `skipped`, so this fails the gate on every run — or, if the\n' +
        '   case arms change, silently stops meaning anything.\n' +
        '   REMEDY: add the job to `needs:`, or drop the map entry.'
    );
  }
  process.exit(1);
}

// `pathToFileURL`, not `file://${argv[1]}`: `import.meta.url` percent-encodes a
// space, `#`, `?` or any non-ASCII byte in the path and `process.argv[1]` does
// not, so the string compare is false and `main()` never runs. The CI step then
// exits 0 having read nothing -- a gate that cannot find its subject passing
// quietly, which is the thing this file refuses to do everywhere else.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
