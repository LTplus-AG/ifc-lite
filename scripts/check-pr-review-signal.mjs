#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Guard: a PR may not read as reviewed and tested over lanes that never ran
 * and reviews that never happened (issue #3312).
 *
 * Two questions, both about ABSENCE. See scripts/lib/pr-review-signal.mjs for
 * the measured evidence behind each; this file is the I/O half.
 *
 *   PART 1 -- REQUIRED LANE PRESENCE, BY NAME.
 *     The expected check names are DERIVED from `.github/workflows/test.yml`
 *     rather than pinned as a count. A count floor rots and, worse, survives
 *     losing the exact lane that mattered: a floor of 15 is satisfied by 15
 *     Vercel deploys. Names are not: `Node tests` either published a check run
 *     for this SHA or it did not.
 *
 *     Presence, not status. A skipped lane still publishes a check run, so this
 *     asks only "did the workflow fire", and #3294's retarget -- opened against
 *     a feature branch, retargeted to main, `test.yml` never fired and never
 *     re-fires retroactively -- is exactly a total absence.
 *
 *     THE RACE, AND WHY A SINGLE READ IS NOT ENOUGH. On `opened`/`synchronize`
 *     this job starts alongside the lanes it counts, and a DOWNSTREAM job
 *     publishes no check run at all until its `needs` complete -- measured
 *     mid-run on PR #3305: 15 of the 16 derived names present, the aggregate
 *     absent purely because the census was still going. So it polls until
 *     either every required name has appeared, or the rollup has SETTLED
 *     (every lane that has appeared is now terminal), or `--timeout-seconds`
 *     runs out. The settle rule is what separates "has not appeared yet" from
 *     "will never appear", and it is why the #3294 shape fails in seconds
 *     rather than burning the whole budget. A timeout is a FAILURE, never a
 *     pass.
 *
 *     CHICKEN AND EGG. This job lives in a different workflow file from the one
 *     it derives names from, so it can never require itself. Asserted in
 *     scripts/check-pr-review-signal.test.mjs rather than merely intended.
 *
 *     FORKS. A fork PR legitimately publishes a handful of checks, so the lane
 *     half is ADVISORY there (`forkLanesAreAdvisory`) and prints what is missing
 *     without failing. The review half still applies.
 *
 *   PART 2 -- A REVIEW THAT REPORTS `pass` MUST HAVE PRODUCED A VERDICT.
 *     Reads the free-text description of each configured reviewer context and
 *     fails on the known no-verdict phrases. `neutral`/`failure` are left alone:
 *     they already say "no verdict". Only `success` claims otherwise.
 *
 *     THIS HALF ALONE IS SEVERITY-CONFIGURABLE, and the reason is a standing
 *     ruling in this repo rather than squeamishness: check-coderabbit-review.mjs
 *     and check-pr-green.mjs are both `@unwired-by-design` because "a required
 *     check built on transient GitHub state fails for reasons unrelated to the
 *     diff under test". A rate limit IS that. A missing `Node tests` lane is
 *     NOT -- it is a fact about this diff -- so part 1 has no knob and cannot
 *     be downgraded. `reviewVerdictSeverity` ships as `fail`, per #3312.
 *
 * FAIL-CLOSED, EVERY PATH. `gh` missing, `gh` erroring, unparseable JSON, an
 * empty rollup, a head SHA that will not resolve, a reviewer that passed with no
 * description, a job name this parser cannot expand -- each exits non-zero with
 * its own named reason. There is no branch that prints a success line over
 * something it did not read.
 *
 * Run from `.github/workflows/pr-review-signal.yml`, which carries no `paths:`
 * filter so neither this script nor its config can be edited without the job
 * that runs them firing. Its own regression harness is
 * scripts/check-pr-review-signal.test.mjs, run by the `scripts/*.test.mjs`
 * catch-all in the Node tests job.
 *
 * Usage:
 *   node scripts/check-pr-review-signal.mjs --pr 3312 --repo LTplus-AG/ifc-lite
 *   node scripts/check-pr-review-signal.mjs --pr 3312 --timeout-seconds 300
 *   node scripts/check-pr-review-signal.mjs --state-file <path>   # offline, for tests
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ReviewSignalError,
  expandJobNames,
  missingLanes,
  noVerdictReviews,
  rollupSettled,
} from './lib/pr-review-signal.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

const DEFAULT_WORKFLOW = join(REPO_ROOT, '.github/workflows/test.yml');
const DEFAULT_CONFIG = join(SCRIPTS_DIR, 'pr-review-signal.config.json');

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = {
    pr: null,
    repo: null,
    workflow: DEFAULT_WORKFLOW,
    config: DEFAULT_CONFIG,
    timeoutSeconds: 300,
    pollSeconds: 15,
    stateFile: null,
    selfName: process.env.PR_REVIEW_SIGNAL_SELF_NAME ?? null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === '--pr') out.pr = next();
    else if (a === '--repo') out.repo = next();
    else if (a === '--workflow') out.workflow = next();
    else if (a === '--config') out.config = next();
    else if (a === '--timeout-seconds') out.timeoutSeconds = Number(next());
    else if (a === '--poll-seconds') out.pollSeconds = Number(next());
    else if (a === '--state-file') out.stateFile = next();
    else if (a === '--self-name') out.selfName = next();
    else if (a.startsWith('--')) {
      throw new ReviewSignalError('BAD_ARGS', `Unknown flag \`${a}\`.`);
    }
  }
  return out;
}

/** @param {string} path */
function readConfig(path) {
  if (!existsSync(path)) {
    throw new ReviewSignalError(
      'NO_CONFIG',
      `Config \`${path}\` is missing. A missing phrase list is NOT an empty phrase list: an ` +
        'empty list would pass over every rollup, which is the shape this gate rejects.',
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ReviewSignalError('BAD_CONFIG', `Config \`${path}\` is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(cfg.reviewers) || cfg.reviewers.length === 0) {
    throw new ReviewSignalError(
      'BAD_CONFIG',
      `\`reviewers\` in \`${path}\` must be a non-empty array. With no reviewers, part 2 examines ` +
        'nothing and reports success.',
    );
  }
  if (!Array.isArray(cfg.phrases) || cfg.phrases.length === 0) {
    throw new ReviewSignalError(
      'BAD_CONFIG',
      `\`phrases\` in \`${path}\` must be a non-empty array. With no phrases, part 2 examines ` +
        'nothing and reports success.',
    );
  }
  if (cfg.reviewVerdictSeverity !== 'fail' && cfg.reviewVerdictSeverity !== 'warn') {
    throw new ReviewSignalError(
      'BAD_CONFIG',
      `\`reviewVerdictSeverity\` in \`${path}\` must be "fail" or "warn"; found ` +
        `${JSON.stringify(cfg.reviewVerdictSeverity)}. It is not defaulted on purpose: a typo ` +
        'silently downgrading a gate to advisory is the failure this whole file is about.',
    );
  }
  for (const p of cfg.phrases) {
    if (typeof p?.startsWith !== 'string' || p.startsWith.trim() === '') {
      throw new ReviewSignalError(
        'BAD_CONFIG',
        `Every phrase needs a non-empty \`startsWith\`; found ${JSON.stringify(p)}.`,
      );
    }
    if (typeof p?.means !== 'string' || p.means.trim() === '') {
      throw new ReviewSignalError(
        'BAD_CONFIG',
        `Phrase \`${p.startsWith}\` has no \`means\`. A phrase that fails a PR has to say what it ` +
          'means, or the failure is unactionable.',
      );
    }
  }
  return cfg;
}

/**
 * `gh` with fail-closed error handling. Anything other than a clean exit and
 * parseable JSON is an error with its own reason, never an empty result.
 *
 * @param {string[]} args
 * @param {string} what - what was being fetched, for the error text.
 */
function gh(args, what) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    throw new ReviewSignalError(
      'GH_UNAVAILABLE',
      `Could not spawn \`gh\` to fetch ${what}: ${r.error.message}. Without it this gate cannot ` +
        'see the rollup, and an unseen rollup is not a clean one.',
    );
  }
  if (r.status !== 0) {
    throw new ReviewSignalError(
      'GH_ERROR',
      `\`gh ${args.join(' ')}\` exited ${r.status} while fetching ${what}: ` +
        `${(r.stderr || '').trim() || '(no stderr)'}. A permissions failure and a clean PR are ` +
        'indistinguishable from the exit code alone, so this fails.',
    );
  }
  try {
    return JSON.parse(r.stdout);
  } catch (err) {
    throw new ReviewSignalError(
      'GH_BAD_JSON',
      `\`gh ${args.join(' ')}\` returned unparseable output while fetching ${what}: ${err.message}`,
    );
  }
}

/**
 * The PR's head SHA, fork flag, and rollup lane names.
 *
 * @param {{ pr: string, repo: string | null }} opts
 */
function fetchPrState(opts) {
  const base = ['pr', 'view', opts.pr, '--json', 'headRefOid,isCrossRepository,statusCheckRollup'];
  if (opts.repo) base.push('--repo', opts.repo);
  const data = gh(base, `PR #${opts.pr}`);

  const sha = data.headRefOid;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new ReviewSignalError(
      'NO_HEAD_SHA',
      `PR #${opts.pr} returned no usable head SHA (\`${sha}\`). Every check below is keyed to that ` +
        'commit; without it nothing here means anything.',
    );
  }

  const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
  return {
    sha,
    isFork: data.isCrossRepository === true,
    // This job's own lane is dropped. It is `in_progress` for as long as it is
    // asking the question, so leaving it in would make `rollupSettled` false
    // forever and turn every run into a full-budget wait ending in a timeout.
    lanes: rollup
      .map((c) => ({
        name: c.name ?? c.context ?? '',
        state: String(c.conclusion ?? c.state ?? c.status ?? '').toLowerCase(),
      }))
      .filter((c) => c.name !== opts.selfName),
  };
}

/**
 * Commit statuses WITH their descriptions. `gh pr view --json statusCheckRollup`
 * does not expose `description` for a `StatusContext`, which is exactly the
 * field the whole of part 2 turns on -- so this reads the commit-status API
 * directly rather than inferring a verdict from the state it does expose.
 *
 * @param {{ repo: string, sha: string }} opts
 */
function fetchStatusDescriptions(opts) {
  const data = gh(
    ['api', `repos/${opts.repo}/commits/${opts.sha}/status`, '--jq', '.statuses'],
    `commit statuses for ${opts.sha}`,
  );
  if (!Array.isArray(data)) {
    throw new ReviewSignalError(
      'NO_STATUSES',
      `The commit-status API returned a non-array for ${opts.sha}. Refusing to read that as ` +
        '"no reviewer said anything".',
    );
  }
  return data.map((s) => ({
    name: s.context ?? '',
    state: String(s.state ?? '').toLowerCase(),
    description: s.description ?? null,
  }));
}

/**
 * Check runs WITH their output titles -- the reviewers that publish as a check
 * run rather than a commit status. Same fail-closed contract.
 *
 * @param {{ repo: string, sha: string }} opts
 */
function fetchCheckRunDescriptions(opts) {
  const data = gh(
    [
      'api',
      `repos/${opts.repo}/commits/${opts.sha}/check-runs?per_page=100`,
      '--jq',
      '.check_runs',
    ],
    `check runs for ${opts.sha}`,
  );
  if (!Array.isArray(data)) {
    throw new ReviewSignalError(
      'NO_CHECK_RUNS',
      `The check-runs API returned a non-array for ${opts.sha}. Refusing to read that as ` +
        '"no reviewer said anything".',
    );
  }
  return data.map((c) => ({
    name: c.name ?? '',
    state: String(c.conclusion ?? '').toLowerCase(),
    description: c.output?.title ?? null,
  }));
}

/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The whole check, over data already fetched. Split out so the regression
 * harness can drive every branch -- including every fail-closed one -- without
 * a network, a token, or a real PR.
 *
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function evaluate({ required, lanes, reviewChecks, isFork, cfg, timedOut }) {
  const lines = [];
  let ok = true;

  const missing = missingLanes(required, lanes);
  if (missing.length === 0) {
    lines.push(`✅ All ${required.length} required lane(s) from test.yml are present in the rollup.`);
  } else if (isFork && cfg.forkLanesAreAdvisory) {
    lines.push(
      `ℹ️  Fork PR: ${missing.length} of ${required.length} required lane(s) absent, which is ` +
        'normal for a fork and is reported without failing:',
    );
    for (const n of missing) lines.push(`      - ${n}`);
  } else {
    ok = false;
    lines.push(
      `❌ MISSING_LANES: ${missing.length} of ${required.length} lane(s) that test.yml publishes ` +
        `never appeared for this commit${timedOut ? ' within the poll budget' : ''}:`,
    );
    for (const n of missing) lines.push(`      - ${n}`);
    lines.push(
      '   A lane that never ran contributes no failing check, so `fail=0` is true over code ' +
        'nothing examined.',
      '   The usual cause is that the workflow never fired for this head: a PR opened against a ' +
        'feature branch and',
      '   retargeted to main does NOT fire test.yml retroactively (#3294). Push an empty commit, ' +
        'or close and reopen the PR.',
    );
  }

  const findings = noVerdictReviews(reviewChecks, cfg);
  if (findings.length === 0) {
    lines.push(
      `✅ ${cfg.reviewers.length} configured reviewer context(s) examined; none reports a passing ` +
        'state over a review it did not perform.',
    );
  } else {
    // Severity is a config decision, not a code one. See the config's own note:
    // this repo already ruled that a REQUIRED check resting on transient review
    // state fails for reasons unrelated to the diff, and a rate limit is
    // exactly that. The lane half is never downgradeable, because a missing
    // test lane is a fact about this diff.
    const fatal = cfg.reviewVerdictSeverity === 'fail';
    if (fatal) ok = false;
    const mark = fatal ? '❌' : '⚠️ ';
    for (const f of findings) {
      lines.push(
        `${mark} ${f.reason}: \`${f.name}\` reports a PASSING state, but its description says ` +
          `${f.description === null ? '(nothing)' : `"${f.description}"`} — ${f.means}.`,
      );
    }
    lines.push(
      '   `pass` communicates "verdict: fine". A rate-limited, skipped or quota-exhausted review ' +
        'has no verdict to',
      '   communicate, and merging on it means merging unreviewed. Re-run the reviewer, or read ' +
        'the diff yourself and say so.',
    );
  }

  return { ok, lines };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = readConfig(args.config);

  if (!existsSync(args.workflow)) {
    throw new ReviewSignalError(
      'NO_WORKFLOW_TEXT',
      `Workflow \`${args.workflow}\` does not exist, so the required lane set cannot be derived.`,
    );
  }
  const required = expandJobNames(readFileSync(args.workflow, 'utf8'), {
    exclude: cfg.excludeJobKeys ?? [],
  });

  // Offline mode for the regression harness: a JSON blob standing in for the
  // three API reads, driving the identical `evaluate`.
  if (args.stateFile) {
    const state = JSON.parse(readFileSync(args.stateFile, 'utf8'));
    const { ok, lines } = evaluate({
      required: state.required ?? required,
      lanes: state.lanes,
      reviewChecks: state.reviewChecks ?? [],
      isFork: state.isFork === true,
      cfg,
      timedOut: false,
    });
    for (const l of lines) console.log(l);
    process.exit(ok ? 0 : 1);
  }

  if (!args.pr) {
    throw new ReviewSignalError('BAD_ARGS', 'Pass `--pr <number>` (or `--state-file` for tests).');
  }
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new ReviewSignalError(
      'NO_REPO',
      'Pass `--repo owner/name` or set GITHUB_REPOSITORY. The commit-status API needs it, and ' +
        'guessing it would mean reporting on a repository this gate never confirmed.',
    );
  }

  if (!args.selfName) {
    throw new ReviewSignalError(
      'NO_SELF_NAME',
      'Pass `--self-name <this job\'s check name>`. Without it this job\'s own always-running ' +
        'lane sits in the rollup as `in_progress` forever, the settle rule can never hold, and ' +
        'the poll degrades to "wait the whole budget then fail" on every PR.',
    );
  }
  if (required.includes(args.selfName)) {
    throw new ReviewSignalError(
      'SELF_REQUIRED',
      `\`${args.selfName}\` is in the required lane set derived from ${args.workflow}. This gate ` +
        'would then be waiting on itself to finish before it could finish. Move it out of that ' +
        'workflow, or rename it.',
    );
  }

  const deadline = Date.now() + args.timeoutSeconds * 1000;
  let state = fetchPrState({ pr: args.pr, repo: args.repo, selfName: args.selfName });
  let timedOut = false;

  // Poll while an absence could still be a race rather than a fact.
  //
  // Two stopping conditions, and the second is the one that matters: a
  // downstream job publishes no check run until its `needs` complete, so the
  // aggregate lane is legitimately missing mid-run. Waiting for the rollup to
  // SETTLE — every lane that has appeared now terminal — is what separates
  // "has not appeared yet" from "will never appear", and it is why this cannot
  // false-fail on the `opened`/`synchronize` spawn race.
  //
  // Self-exclusion is structural: the required set is derived from test.yml and
  // this job lives in a different workflow file, so it never waits on itself.
  for (;;) {
    let stillMissing;
    try {
      stillMissing = missingLanes(required, state.lanes);
    } catch {
      stillMissing = required; // NO_ROLLUP: treat as "nothing has appeared yet".
    }
    if (stillMissing.length === 0) break;
    if (rollupSettled(state.lanes)) break;
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    console.log(
      `… ${stillMissing.length}/${required.length} required lane(s) not yet published for ` +
        `${state.sha}; re-reading in ${args.pollSeconds}s ` +
        `(${Math.round((deadline - Date.now()) / 1000)}s of budget left).`,
    );
    sleepSync(args.pollSeconds * 1000);
    state = fetchPrState({ pr: args.pr, repo: args.repo, selfName: args.selfName });
  }

  const reviewChecks = [
    ...fetchStatusDescriptions({ repo, sha: state.sha }),
    ...fetchCheckRunDescriptions({ repo, sha: state.sha }),
  ];

  console.log(`PR #${args.pr} @ ${state.sha}${state.isFork ? ' (fork)' : ''}`);
  console.log(`Required lanes derived from ${args.workflow}: ${required.length}`);
  console.log(`Rollup lanes seen: ${state.lanes.length}`);
  console.log('');

  const { ok, lines } = evaluate({
    required,
    lanes: state.lanes,
    reviewChecks,
    isFork: state.isFork,
    cfg,
    timedOut,
  });
  for (const l of lines) console.log(l);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('check-pr-review-signal.mjs')) {
  try {
    main();
  } catch (err) {
    if (err instanceof ReviewSignalError) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
