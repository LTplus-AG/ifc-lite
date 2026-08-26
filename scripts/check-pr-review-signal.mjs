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
 *     either every required name has appeared, or the rollup has SETTLED AND
 *     STAYED SETTLED for `SETTLE_HOLD_SECONDS`, or `--timeout-seconds` runs
 *     out. The settle rule is what separates "has not appeared yet" from "will
 *     never appear", and it is why the #3294 shape fails in a minute rather
 *     than burning the whole budget. A timeout is a FAILURE, never a pass.
 *
 *     THE HOLD IS NOT DECORATION. Because a downstream job's check run is
 *     created only when its `needs` complete, EVERY fan-out boundary has an
 *     instant where every published lane is terminal and more are still
 *     coming. Replaying all 71 completed `test.yml` PR runs of 2026-08-25/26
 *     second by second, 31 contain such an instant -- 36 windows, every one
 *     exactly 1 s wide. Unheld, a read landing in one calls a green run
 *     permanently missing its lanes; see `SETTLE_HOLD_SECONDS` in the lib for
 *     the rule and the assumption it rests on.
 *
 *     AND THAT IS WHY THE AGGREGATE IS EXCLUDED. Waiting for a job that
 *     `needs:` twelve others makes the budget cover the whole matrix: over the
 *     68 completed `test.yml` PR runs of 2026-08-25/26 that published it, the
 *     aggregate APPEARED (`created_at`, from each run's own creation) at 509 to
 *     2067 s, 33 of the 68 past even the current 900 s budget -- a gate
 *     printing "the workflow never fired" over half of every green PR.
 *     `excludeJobKeys: ["test"]` ties the wait to how fast GitHub creates check
 *     runs (161-845 s over the same runs, 0 of 68 past 900 s) instead of to
 *     suite runtime, and nothing is lost: branch protection blocks on the
 *     aggregate anyway, it being one of only two contexts in main's ruleset.
 *     The budget is 900 s because 420 still false-failed 8 of those 68 even
 *     with the aggregate out; the tail margin is 900/845 = 1.07x.
 *     Full measurement in .github/workflows/pr-review-signal.yml.
 *
 *     THE LOOP ITSELF IS `pollForLanes`, in the lib, over an injected clock and
 *     sleep. Inline in `main()` it was the one branch with no test --
 *     `--state-file` mode hardcodes `timedOut: false` and jumps to `evaluate` --
 *     and the untested branch was the broken one.
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
 *     be downgraded.
 *
 *     SO IT SHIPS AS `warn`, AND THE DOCBLOCK FOLLOWS THE RULING IT QUOTES.
 *     The first revision of this file quoted `@unwired-by-design` and then
 *     shipped `fail` anyway. What settles it is that a rate-limited status
 *     NEVER SELF-HEALS: the complete history on such a SHA is `queued -> in
 *     progress -> success/Review rate limited` and then nothing, forever
 *     (`repos/{o}/{r}/statuses/{sha}`, verbatim, on #3296's head). The quota
 *     recovers; the status on that commit does not. `fail` would therefore mean
 *     red until a human pushes or triggers an on-demand review -- measured on 8
 *     of 19 open PRs on 2026-08-26. The finding is still PRINTED and still
 *     quotes the reviewer verbatim; it just does not hold the PR red on a quota.
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
  pollForLanes,
} from './lib/pr-review-signal.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

const DEFAULT_WORKFLOW = join(REPO_ROOT, '.github/workflows/test.yml');
const DEFAULT_CONFIG = join(SCRIPTS_DIR, 'pr-review-signal.config.json');

/**
 * A duration flag, or a named failure.
 *
 * `Number(undefined)` and `Number('soon')` are both `NaN`, and a NaN deadline
 * makes `now() >= deadline` false forever: the poll would spin until the job's
 * own 20-minute timeout killed it, printing nothing at all. That is the exact
 * "no output, no verdict" shape this gate exists to reject, so an unreadable
 * duration is an error rather than a silently infinite one. Zero and negatives
 * go the same way: a zero budget is a gate that never waits, and a zero poll
 * interval is a busy loop against the API.
 *
 * @param {string} flag
 * @param {string | undefined} raw
 * @returns {number}
 */
function positiveSeconds(flag, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ReviewSignalError(
      'BAD_DURATION',
      `\`${flag}\` needs a positive finite number of seconds; got ${JSON.stringify(raw)}. ` +
        'Refusing to run with an unreadable budget: a NaN deadline never expires, so the poll ' +
        'would spin until the job timeout and the PR would get no verdict at all.',
    );
  }
  return n;
}

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
    else if (a === '--timeout-seconds') out.timeoutSeconds = positiveSeconds(a, next());
    else if (a === '--poll-seconds') out.pollSeconds = positiveSeconds(a, next());
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
 * `repo` is REQUIRED, and is the same resolved value the commit-status reads
 * use. Leaving it optional is what let this read fall back to `gh`'s cwd remote
 * while the status reads used `--repo`: two reads, two repositories, one
 * verdict. There is no caller that legitimately wants that, so there is no
 * longer a way to ask for it.
 *
 * @param {{ pr: string, repo: string, selfName: string }} opts
 */
function fetchPrState(opts) {
  const data = gh(
    [
      'pr',
      'view',
      opts.pr,
      '--json',
      'headRefOid,isCrossRepository,statusCheckRollup',
      '--repo',
      opts.repo,
    ],
    `PR #${opts.pr}`,
  );

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
    );
    // TWO CAUSES, AND THE REMEDIES ARE OPPOSITES. Telling a stale-base PR to
    // push an empty commit is advice that cannot work: re-firing test.yml at
    // the same head re-runs the same, older workflow file and the lane is
    // absent again. Measured on #3301, where `Rust crate semver` was named
    // missing because #3298 added it to test.yml AFTER that head — not a
    // retarget at all. The discriminator is whether test.yml fired here AT ALL:
    // the #3294 retarget shape is TOTAL absence, because the workflow never ran.
    if (missing.length === required.length) {
      lines.push(
        '   NOT ONE lane from test.yml appeared, so the workflow never fired for this head. A PR ' +
          'opened against a',
        '   feature branch and retargeted to main does NOT fire test.yml retroactively (#3294). ' +
          'Push an empty commit,',
        '   or close and reopen the PR.',
      );
    } else {
      lines.push(
        `   test.yml DID fire for this head — ${required.length - missing.length} of ` +
          `${required.length} lanes are present — so this is NOT the #3294 retarget, and pushing ` +
          'an empty',
        '   commit would re-run the same workflow file to the same result. The required set is ' +
          'derived from the',
        '   test.yml in THIS checkout, which can be NEWER than your PR head: a lane added to ' +
          'test.yml after your',
        '   head is required here and cannot exist there. Rebase onto main to pick it up. If the ' +
          'lane does exist',
        '   at your head, it failed to spawn — re-run the workflow.',
      );
    }
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

  // Poll while an absence could still be a race rather than a fact. The loop
  // itself lives in the lib, over an injected clock and sleep, so the harness
  // can drive its timeout path — see `pollForLanes` for the stopping rules.
  //
  // Self-exclusion is structural: the required set is derived from test.yml and
  // this job lives in a different workflow file, so it never waits on itself.
  const readState = () => fetchPrState({ pr: args.pr, repo, selfName: args.selfName });
  const { state, timedOut } = pollForLanes({
    required,
    initialState: readState(),
    fetchState: readState,
    deadline: Date.now() + args.timeoutSeconds * 1000,
    pollSeconds: args.pollSeconds,
    sleep: sleepSync,
    log: (l) => console.log(l),
  });

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
