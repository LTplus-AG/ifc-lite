#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Guard: a PR may not read as reviewed and tested over lanes that never ran,
 * reviews that never happened, and reviews of a commit that is not this one
 * (issue #3312).
 *
 * Three questions, all about ABSENCE. See scripts/lib/pr-review-signal.mjs for
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
 *     2067 s, 33 of the 68 past even the then-current 900 s budget -- a gate
 *     printing "the workflow never fired" over half of every green PR.
 *     `excludeJobKeys: ["test"]` ties the wait to how fast GitHub creates check
 *     runs (161-845 s over the same runs, 0 of 68 past 900 s) instead of to
 *     suite runtime, and nothing is lost: branch protection blocks on the
 *     aggregate anyway, it being one of only two contexts in main's ruleset.
 *     The budget WAS 900 s because 420 still false-failed 8 of those 68 even
 *     with the aggregate out. It is 2400 s now, re-measured on 2026-08-31, and
 *     the number is overwhelmingly RUNNER QUEUE rather than build -- so it has
 *     no ceiling and will breach again; the remedy then is a re-run, because
 *     nothing failed.
 *
 *     THE 2026-08-31 FIGURES ARE DELIBERATELY NOT REPEATED HERE -- not the
 *     population, not the breach count, not the margin, and not the queue share.
 *     They live once, in the budget tests in scripts/lib/pr-review-signal.test.mjs.
 *     A copy of a measurement in a file that cannot assert it is a copy that
 *     goes stale, and this one did, twice. The 2026-08-25/26 figures above are
 *     restated and stay: a closed historical finding cannot go stale.
 *     Full measurement in scripts/lib/pr-review-signal.test.mjs, which asserts it.
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
 *   PART 3 -- A REVIEW OF AN OLDER COMMIT HAS NOT REVIEWED THIS PR.
 *     louistrue, #3312: "A review whose `commit_id` is not the PR head has not
 *     reviewed the PR." His example is #3276: head `1305f778`, `CodeRabbit ::
 *     success / Review completed` sitting on it, and CodeRabbit's newest review
 *     event pointing at `c26e453d` — three commits back, the last of which
 *     ("stop writing an express-id index as a sparse array") is real code
 *     nothing reviewed. Parts 1 and 2 both pass on that PR: the lanes ran, and
 *     "Review completed" matches no no-verdict phrase. Nothing in the free text
 *     of a status links back to a review EVENT, so this needs the one API that
 *     carries the linkage — `repos/{o}/{r}/pulls/{N}/reviews`, paginated.
 *
 *     WHICH REVIEWS COUNT IS A POLICY CALL AND IS DELIBERATELY NOT SETTLED HERE.
 *     It is `staleReviewPolicy` in the config, validated like
 *     `reviewVerdictSeverity` — an unrecognised value is `BAD_CONFIG`, never a
 *     silent downgrade. `claimed-verdict` is the narrowest rule that still
 *     catches #3276. The lib documents the measurements that rule out the two
 *     obvious alternatives, both of which are wrong against this repository's
 *     data: dropping `COMMENTED` makes the check a no-op, and treating "no
 *     review at the head" as staleness fires on PRs where the reviewer never
 *     submitted a review object at all.
 *
 *     AND THE SHIPPED DEFAULT IS `off`, BECAUSE THE PREMISE IS FALSE FOR THIS
 *     REPO'S PRIMARY REVIEWER. CodeRabbit submits NO REVIEW EVENT when a run
 *     finds nothing actionable, so "no review object naming the head" is not
 *     "the head was not reviewed": #3276 and #3288 each show a real 155 s /
 *     181 s review cycle ON THE HEAD and a walkthrough naming the head, and
 *     they are false fires; #3227 and #2952 are genuine ("Reviews paused"). No
 *     structured field separates the two pairs — see the lib and the config for
 *     the measurements and for why the obvious narrowing deletes the rule
 *     instead. So it ships OFF, it NEVER prints a pass while off, and the knob
 *     opts back in. #3227 and #2952 stay catchable for whoever sets it.
 *
 *     SEVERITY `warn`, same `@unwired-by-design` ruling as part 2: whether a bot
 *     has re-reviewed the newest push is transient GitHub state, not a fact
 *     about the diff.
 *
 * FAIL-CLOSED, EVERY PATH. `gh` missing, `gh` erroring, unparseable JSON, an
 * empty rollup, a head SHA that will not resolve, a reviewer that passed with no
 * description, a job name this parser cannot expand, a reviews walk that did not
 * complete, a review whose `commit_id` is unreadable -- each exits non-zero with
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
  flattenReviewPages,
  missingLanes,
  wholesaleSkippedTemplates,
  matrixSkipAliases,
  flattenCheckRunPages,
  noVerdictReviews,
  pollForLanes,
  staleReviews,
  STALE_REVIEW_POLICIES,
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
 * own job timeout killed it, printing nothing at all. That is the exact
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
  if (!STALE_REVIEW_POLICIES.has(cfg.staleReviewPolicy)) {
    throw new ReviewSignalError(
      'BAD_CONFIG',
      `\`staleReviewPolicy\` in \`${path}\` must be one of ` +
        `${[...STALE_REVIEW_POLICIES].map((p) => `"${p}"`).join(', ')}; found ` +
        `${JSON.stringify(cfg.staleReviewPolicy)}. Like \`reviewVerdictSeverity\` it is not ` +
        'defaulted on purpose: an unrecognised value quietly selecting the narrowest rule is a ' +
        'downgrade nobody would notice, and part 3 is the half whose scoping is still a policy ' +
        'call.',
    );
  }
  if (cfg.staleReviewSeverity !== 'fail' && cfg.staleReviewSeverity !== 'warn') {
    throw new ReviewSignalError(
      'BAD_CONFIG',
      `\`staleReviewSeverity\` in \`${path}\` must be "fail" or "warn"; found ` +
        `${JSON.stringify(cfg.staleReviewSeverity)}.`,
    );
  }
  if (!Array.isArray(cfg.reviewAuthors) || cfg.reviewAuthors.length === 0) {
    throw new ReviewSignalError(
      'EMPTY_REVIEW_AUTHORS',
      `\`reviewAuthors\` in \`${path}\` must be a non-empty array. Every policy except ` +
        '"all-authors" scopes staleness to it, and an empty identity list examines nothing and ' +
        'reports success.',
    );
  }
  for (const a of cfg.reviewAuthors) {
    // BOTH halves are required, and `context` is required even under the
    // policies that do not read it: a `reviewAuthors` entry that is silently
    // inert under `claimed-verdict` is how the default rule quietly stops
    // covering a reviewer somebody thought they had configured.
    if (typeof a?.login !== 'string' || a.login.trim() === '') {
      throw new ReviewSignalError(
        'BAD_CONFIG',
        `Every \`reviewAuthors\` entry needs a non-empty \`login\`; found ${JSON.stringify(a)}.`,
      );
    }
    if (typeof a?.context !== 'string' || a.context.trim() === '') {
      throw new ReviewSignalError(
        'BAD_CONFIG',
        `\`reviewAuthors\` entry \`${a.login}\` needs a non-empty \`context\`: the review author ` +
          'login and the check context are different identity spaces (`coderabbitai[bot]` vs ' +
          '`CodeRabbit`), and the default policy needs both.',
      );
    }
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
      'headRefOid,isCrossRepository,statusCheckRollup,baseRefName',
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
    baseRefName: typeof data.baseRefName === 'string' ? data.baseRefName : undefined,
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
  // `--paginate --slurp`, for the same reason as the reviews walk and one that
  // is worse here: a truncated check-run read drops a reviewer CONTEXT, and a
  // dropped context is adjudicated by silence, not by a failure. `--jq` is not
  // available alongside `--slurp`, so the `.check_runs` projection moves into
  // `flattenCheckRunPages`, where the partial-walk refusal is testable.
  const pages = gh(
    [
      'api',
      '--paginate',
      '--slurp',
      `repos/${opts.repo}/commits/${opts.sha}/check-runs?per_page=100`,
    ],
    `check runs for ${opts.sha}`,
  );
  const data = flattenCheckRunPages(pages, `check runs for ${opts.sha}`);
  return data.map((c) => ({
    name: c.name ?? '',
    state: String(c.conclusion ?? '').toLowerCase(),
    description: c.output?.title ?? null,
  }));
}

/**
 * Every review EVENT on the PR, across every page.
 *
 * PAGINATION IS NOT OPTIONAL HERE and is not left to a `per_page` guess. Part 3
 * asks which review is NEWEST, and the newest review is on the LAST page: a
 * single unpaginated read of a busy PR returns the oldest 30 and would compare
 * a stale `commit_id` on a PR whose newest review names the head exactly --
 * a false finding, in the one direction a gate must never fail. `--paginate`
 * follows the Link headers; `--slurp` keeps the page boundaries visible so a
 * short page cannot be mistaken for the end of a truncated walk.
 *
 * @param {{ repo: string, pr: string }} opts
 * @returns {Array<object>}
 */
function fetchReviews(opts) {
  const pages = gh(
    [
      'api',
      '--paginate',
      '--slurp',
      `repos/${opts.repo}/pulls/${opts.pr}/reviews?per_page=100`,
    ],
    `reviews for PR #${opts.pr}`,
  );
  return flattenReviewPages(pages, `\`repos/${opts.repo}/pulls/${opts.pr}/reviews\``);
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
 * @param {string} [baseRefName] - the PR's base branch, if known. Distinguishes
 *   a stacked PR (base is not `main`, so test.yml's OWN `branches: [main]`
 *   filter means every required lane is legitimately absent right now, and
 *   will stay absent until retargeted) from the #3294 retarget shape (base IS
 *   `main`, workflow fired for nobody, and pushing an empty commit or
 *   reopening genuinely helps). Optional and defaults to the retarget message
 *   when the caller has not fetched it (`--state-file` offline mode).
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function evaluate({
  required,
  aliases,
  lanes,
  reviewChecks,
  reviews,
  headSha,
  isFork,
  cfg,
  timedOut,
  baseRefName,
}) {
  // NOT DEFAULTED -- see the identical refusal in `pollForLanes`. A default here
  // is the difference between a wire-up that is forgotten loudly and one that is
  // forgotten silently, and this function has exactly one live caller.
  if (!(aliases instanceof Map)) {
    throw new ReviewSignalError(
      'MISSING_ALIASES',
      'evaluate was called without a matrix alias Map. Pass the map from `matrixSkipAliases` ' +
        'over the same workflow text `required` came from.',
    );
  }
  const lines = [];
  let ok = true;

  const missing = missingLanes(required, lanes, aliases);
  // NAMED, NOT SILENT. A wholesale skip is the one way a required lane passes
  // this gate without a check run of its own, so it is reported every time. If
  // the path filter that skipped the job is itself wrong, this line is where
  // that shows up -- the gate cannot adjudicate the filter, and says so rather
  // than absorbing the skip into a tick.
  const skippedWholesale = [...wholesaleSkippedTemplates(lanes, aliases)].sort();
  for (const t of skippedWholesale) {
    const covered = required.filter((n) => aliases.get(n) === t);
    lines.push(
      `➖ \`${t}\` was SKIPPED as a whole job, before its matrix expanded, so its ` +
        `${covered.length} lane(s) published no check run of their own and are not ` +
        'counted missing. Whether the `if:` that skipped it was RIGHT is not something ' +
        'this gate can answer.',
    );
  }
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
    if (missing.length === required.length && baseRefName && baseRefName !== 'main') {
      // #3429: a PR stacked on another PR's branch. test.yml's OWN
      // `branches: [main]` filter is why nothing appeared -- there was no
      // retarget to fail to retroactively fire, and no push here changes
      // that, because test.yml still would not fire against this base.
      lines.push(
        `   NOT ONE lane from test.yml appeared, and this PR's base is \`${baseRefName}\`, not ` +
          '`main` --',
        '   test.yml carries the same `branches: [main]` filter this gate does not, so every ' +
          'lane is',
        '   genuinely absent for as long as the PR is stacked (#3429). An empty commit will not ' +
          'fire it;',
        '   retargeting this PR to `main` will.',
      );
    } else if (missing.length === required.length) {
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

  // PART 3 -- a review of an older commit has not reviewed this PR (#3312).
  // The scoping rule lives in the config (`staleReviewPolicy`) and is a policy
  // call for the maintainer; see the lib for the data that rules out the two
  // obvious answers.
  const stale = staleReviews(reviews, {
    headSha,
    policy: cfg.staleReviewPolicy,
    authors: cfg.reviewAuthors,
    checks: reviewChecks,
    // The default policy fires on "a context claims a verdict on this head".
    // Part 2 fires on "a context claims a verdict it did not produce". When
    // both hit the same context the remedy is identical — re-run the reviewer —
    // and part 2's finding quotes the reviewer verbatim, so it is the more
    // specific of the two. Saying it twice is noise, not diligence.
    alreadyFlagged: findings.map((f) => f.name),
  });
  // THREE STATES, NOT TWO. `clean`, `found`, and `not adjudicated` -- and only
  // the first of them may print a tick. An empty finding list used to mean both
  // "nobody is stale" and "the finding was deduped away", so a suppressed
  // finding rendered as a pass the gate had not earned. That is the exact
  // defect class this file exists to remove, so a suppressed finding now prints
  // its own line and still moves the exit code.
  const reported = stale.filter((f) => f.suppressedBy === null);
  const suppressed = stale.filter((f) => f.suppressedBy !== null);
  if (cfg.staleReviewPolicy === 'off') {
    // NOT a tick. `off` means this question was not asked; saying "no reviewer
    // claims a verdict from an older review" would be an answer nobody
    // computed. See the config for why `off` is the shipped default.
    lines.push(
      '➖ STALE_REVIEW not adjudicated: `staleReviewPolicy` is "off", so this gate does NOT ' +
        'tell you whether a',
      '   review of an older commit is standing in for a review of the head. That is a hole, ' +
        'stated rather than',
      '   papered over with a tick — see the config for the measured premise defect that turned ' +
        'it off, and the',
      '   knob that opts back in.',
    );
  } else if (stale.length === 0) {
    lines.push(
      `✅ No reviewer claims a verdict on ${headSha.slice(0, 8)} from a review of an older commit ` +
        `(policy: ${cfg.staleReviewPolicy}).`,
    );
  } else {
    const fatal = cfg.staleReviewSeverity === 'fail';
    if (fatal) ok = false;
    const mark = fatal ? '❌' : '⚠️ ';
    for (const f of reported) {
      lines.push(
        `${mark} STALE_REVIEW: \`${f.context ?? f.login}\` reads as having reviewed this PR, but ` +
          `${f.login}'s newest review is of ${f.reviewedSha.slice(0, 8)}` +
          `${f.submittedAt ? ` (${f.submittedAt})` : ''}, not of the head ` +
          `${headSha.slice(0, 8)}.`,
      );
    }
    // The SENTENCE is the duplicate, not the finding. Part 2 has already
    // quoted this reviewer verbatim and the remedy is identical, so this says
    // so in one line rather than repeating the whole paragraph — and the
    // severity knob above has already been applied to it.
    for (const f of suppressed) {
      lines.push(
        `${mark} STALE_REVIEW: \`${f.context ?? f.login}\` is ALSO stale — its newest review is ` +
          `of ${f.reviewedSha.slice(0, 8)}, not ${headSha.slice(0, 8)} — reported above as ` +
          `\`${f.suppressedBy}\`; same remedy, so it is not restated.`,
      );
    }
    if (reported.length === 0) {
      lines.push(
        '   Re-run the reviewer on the head. Everything pushed since that commit is unreviewed ' +
          'code under a passing signal.',
      );
    }
  }
  if (reported.length > 0) {
    lines.push(
      '   A review whose `commit_id` is not the PR head has not reviewed the PR (#3312). ' +
        'Everything pushed since',
      '   that commit is unreviewed code sitting under a passing review signal. Re-run the ' +
        'reviewer on the head.',
      // WHICH reviews were even considered is a config decision, so the finding
      // names it. Reading a staleness warning without knowing the scoping rule
      // that produced it is how a policy nobody chose becomes a policy nobody
      // can argue with.
      `   Scoping policy: \`${cfg.staleReviewPolicy}\` (staleReviewPolicy). ` +
        'Which reviews count is a policy call — see the config.',
    );
  }

  return { ok, lines };
}

/**
 * A `--state-file` fixture's own alias map, refused rather than coerced.
 *
 * `Object.entries` accepts a string, a number and an array without complaint and
 * yields keys no lane name can match, so a malformed value would quietly become
 * "no aliases" -- safe in direction, wrong in explanation, and three lines from
 * a comment saying `reviews` refuses a non-array loudly. Same doctrine here.
 *
 * @param {unknown} raw
 * @returns {Map<string, string>}
 */
function fixtureAliases(raw) {
  if (raw === undefined) return new Map();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReviewSignalError(
      'BAD_STATE_FILE',
      `\`aliases\` in the state file must be an object mapping an expanded lane name to its ` +
        `matrix template; got ${Array.isArray(raw) ? 'an array' : typeof raw}.`,
    );
  }
  const out = new Map();
  for (const [lane, template] of Object.entries(raw)) {
    // A NON-STRING TEMPLATE IS THE SAME BUG ONE LEVEL IN. `{"Viewer tests (shard
    // 0)": null}` survives `Object.entries`, `skipped.has(null)` is false, and
    // the fixture then fails as MISSING_LANES -- a true verdict with a false
    // explanation, which is exactly what refusing the malformed OUTER value was
    // meant to prevent. Raised by CodeRabbit on PR #3584 and reproduced before
    // fixing: the run printed MISSING_LANES, not BAD_STATE_FILE.
    //
    // The KEY is not checked: `Object.entries` only ever yields strings, so a
    // `typeof lane !== 'string'` clause here would be dead code pretending to
    // guard something. An empty key is reachable (`{"": "x"}` is valid JSON) and
    // is rejected.
    if (lane === '' || typeof template !== 'string' || template === '') {
      // `typeof []` is 'object', which tells a fixture author nothing. Named the
      // way the outer refusal names it, so the two messages read alike.
      const what =
        template === ''
          ? 'an empty string'
          : Array.isArray(template)
            ? 'an array'
            : template === null
              ? 'null'
              : typeof template;
      throw new ReviewSignalError(
        'BAD_STATE_FILE',
        `\`aliases\` maps \`${lane}\` to ${what}; every lane name and every matrix ` +
          'template must be a non-empty string.',
      );
    }
    out.set(lane, template);
  }
  return out;
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
  const workflowText = readFileSync(args.workflow, 'utf8');
  const required = expandJobNames(workflowText, { exclude: cfg.excludeJobKeys ?? [] });
  const aliases = matrixSkipAliases(workflowText, { exclude: cfg.excludeJobKeys ?? [] });

  // Offline mode for the regression harness: a JSON blob standing in for the
  // three API reads, driving the identical `evaluate`.
  if (args.stateFile) {
    const state = JSON.parse(readFileSync(args.stateFile, 'utf8'));
    const { ok, lines } = evaluate({
      required: state.required ?? required,
      // PAIRED WITH `required`, deliberately. A fixture that overrides the lane
      // set but inherits the REAL alias map is a fixture whose two halves
      // describe different workflows: a case asserting MISSING_LANES on a real
      // viewer-shard name would pass for the wrong reason if its rollup carried
      // the real template at `skipped`. Overriding one without the other is
      // therefore possible but never silent -- `aliases` follows `required`.
      aliases: state.required === undefined ? aliases : fixtureAliases(state.aliases),
      lanes: state.lanes,
      reviewChecks: state.reviewChecks ?? [],
      // NOT `?? []`. A state file that omits `reviews` has told this gate
      // nothing about staleness, and defaulting that to "no reviews" would
      // print the part 3 success line over a question nobody answered — the
      // exact vacuity the rest of this file rejects. `staleReviews` refuses a
      // non-array with `NO_REVIEWS`, and `headSha` likewise with `NO_HEAD_SHA`.
      reviews: state.reviews,
      headSha: state.headSha,
      isFork: state.isFork === true,
      baseRefName: typeof state.baseRefName === 'string' ? state.baseRefName : undefined,
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
    aliases,
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
  // `off` READS NOTHING. The policy adjudicates nothing, so paying for a
  // paginated walk — and, worse, letting its REVIEWS_TRUNCATED refusal take the
  // gate down — over a question this run does not ask would be noise. Parts 1
  // and 2 are untouched.
  const reviews = cfg.staleReviewPolicy === 'off' ? [] : fetchReviews({ repo, pr: args.pr });

  console.log(
    `PR #${args.pr} @ ${state.sha}${state.isFork ? ' (fork)' : ''} -> base \`${state.baseRefName ?? '(unknown)'}\``,
  );
  console.log(`Required lanes derived from ${args.workflow}: ${required.length}`);
  console.log(`Rollup lanes seen: ${state.lanes.length}`);
  console.log(
    cfg.staleReviewPolicy === 'off'
      ? 'Review events read: none (staleReviewPolicy is "off")'
      : `Review events read: ${reviews.length}`,
  );
  console.log('');

  const { ok, lines } = evaluate({
    required,
    aliases,
    lanes: state.lanes,
    reviewChecks,
    reviews,
    headSha: state.sha,
    isFork: state.isFork,
    baseRefName: state.baseRefName,
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
