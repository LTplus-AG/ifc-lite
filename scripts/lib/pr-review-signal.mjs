/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Pure classification for `scripts/check-pr-review-signal.mjs` (issue #3312).
 *
 * The gate answers three questions that no existing signal on a PR can answer,
 * and all three are questions about ABSENCE rather than about failure. Question
 * 3 -- review staleness -- is at the foot of this file, under PART 3:
 *
 *   1. Did the lanes that compile and test this code actually RUN? A lane that
 *      never fired contributes no failing check, so `fail=0` is literally true
 *      over a region nothing examined. #3294 merged with 8 checks -- three
 *      Vercel deploys, Vercel Agent Review, CodeRabbit, Preview Comments and a
 *      parity job -- and not one of them compiles the code. It left `main`'s
 *      module-size gate red.
 *
 *      The MECHANISM there was not a dropped webhook: the PR was opened against
 *      a FEATURE BRANCH, `test.yml` filters `pull_request` on `branches: [main]`,
 *      and retargeting a PR to main does not fire workflows retroactively. It is
 *      deterministic and reproducible, which is why a detector is worth building
 *      rather than waiting for the flake to stop.
 *
 *   2. Did the review checks that report `pass` actually review anything?
 *      Measured 2026-08-26 across nine open PRs, verbatim from
 *      `repos/{o}/{r}/commits/{sha}/status`:
 *
 *        [success] CodeRabbit :: Review rate limited
 *        [success] CodeRabbit :: Review skipped: reviews are disabled for this base branch
 *
 *      `neutral` and `failure` both communicate "no verdict" and are left alone
 *      here on purpose -- `success` is the only state that communicates
 *      "verdict: fine", and it is the only one this rejects. That is also why
 *      `Cursor Bugbot :: Error` at `neutral` is NOT a finding: it is already
 *      saying it did not run.
 *
 * EVERYTHING HERE FAILS CLOSED. A gate against vacuous gates that returns a
 * success line over something it could not read would be the defect it exists
 * to catch, so every route to "nothing to report" is a distinct named reason:
 * `NO_WORKFLOW_TEXT`, `NO_WORKFLOW_JOBS`, `UNRESOLVED_JOB_NAME`,
 * `EMPTY_REQUIRED_SET`, `NO_ROLLUP`, `UNREADABLE_DESCRIPTION`, `NO_HEAD_SHA`,
 * `NO_REVIEWS`, `REVIEWS_TRUNCATED`, `EMPTY_REVIEW_AUTHORS`,
 * `UNREADABLE_COMMIT_ID`, `UNREADABLE_REVIEW_ID`. None of them is reachable by a
 * code path that prints OK.
 */

/** Thrown for every fail-closed condition; `reason` is the machine-readable tag. */
export class ReviewSignalError extends Error {
  /**
   * @param {string} reason - one of the named tags documented in the header.
   * @param {string} message - human-facing text, always naming the remedy.
   */
  constructor(reason, message) {
    super(message);
    this.name = 'ReviewSignalError';
    this.reason = reason;
  }
}

/**
 * Top-level `jobs:` keys and their `name:` / `strategy.matrix:` from a workflow.
 *
 * Deliberately lexical, and deliberately NOT a YAML parse: adding a YAML
 * dependency to a gate whose whole purpose is to run when nothing else does is
 * a way for the gate to stop running. The shapes it must handle are the ones
 * `.github/workflows/test.yml` actually uses, and anything it cannot resolve is
 * an error rather than a silent omission (see `expandJobNames`).
 *
 * @param {string} text - the workflow file's contents.
 * @returns {Array<{ key: string, name: string | null, matrix: Record<string, string[]> }>}
 */
export function parseWorkflowJobs(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new ReviewSignalError(
      'NO_WORKFLOW_TEXT',
      'The workflow file used to derive the required lane set was empty or unreadable. ' +
        'The gate cannot know what should have run, so it refuses to report a verdict.',
    );
  }

  const jobsAt = text.search(/^jobs:[ \t]*$/m);
  if (jobsAt === -1) {
    throw new ReviewSignalError(
      'NO_WORKFLOW_JOBS',
      'No top-level `jobs:` block found in the workflow file. The scan root has moved; ' +
        'fix this parser rather than letting it derive an empty required set.',
    );
  }

  const body = text.slice(jobsAt);
  const jobs = [];
  // Job keys sit at exactly two spaces of indent under `jobs:`; the lookahead
  // requires a deeper-indented line after them so a bare `key:` inside a
  // comment block or a string cannot be mistaken for a job.
  const jobRe = /\n {2}([A-Za-z0-9_-]+):[ \t]*(?:#[^\n]*)?\n(?= {4}\S)/g;
  const starts = [];
  for (let m = jobRe.exec(body); m !== null; m = jobRe.exec(body)) {
    starts.push({ key: m[1], at: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < starts.length; i += 1) {
    const stop = i + 1 < starts.length ? starts[i + 1].at : body.length;
    const block = body.slice(starts[i].end, stop);
    const nameMatch = /^ {4}name:[ \t]*(.+?)[ \t]*$/m.exec(block);
    let name = nameMatch ? nameMatch[1] : null;
    if (name !== null) {
      const quoted = /^(['"])(.*)\1$/.exec(name);
      if (quoted) name = quoted[2];
    }
    jobs.push({ key: starts[i].key, name, matrix: parseMatrix(block) });
  }

  if (jobs.length === 0) {
    throw new ReviewSignalError(
      'NO_WORKFLOW_JOBS',
      'The `jobs:` block parsed to zero jobs. Refusing to derive an empty required lane set.',
    );
  }
  return jobs;
}

/**
 * `strategy.matrix.<key>: [a, b, c]` inline lists only -- the one form
 * `test.yml` uses (`shard: [0, 1, 2, 3]`). A matrix key whose value is not an
 * inline list is simply not returned; `expandJobNames` then fails closed on the
 * unresolved `${{ matrix.<key> }}` rather than guessing.
 *
 * @param {string} block - one job's body.
 * @returns {Record<string, string[]>}
 */
function parseMatrix(block) {
  const out = {};
  const at = /^ {6}matrix:[ \t]*$/m.exec(block);
  if (!at) return out;
  const rest = block.slice(at.index + at[0].length);
  const lineRe = /^ {8}([A-Za-z0-9_-]+):[ \t]*\[(.*?)\][ \t]*$/gm;
  for (let m = lineRe.exec(rest); m !== null; m = lineRe.exec(rest)) {
    // Stop at the first line that leaves the matrix block.
    const before = rest.slice(0, m.index);
    if (/^ {0,7}\S/m.test(before)) break;
    out[m[1]] = m[2]
      .split(',')
      .map((v) => v.trim().replace(/^(['"])(.*)\1$/, '$2'))
      .filter((v) => v !== '');
  }
  return out;
}

/**
 * One job's check names, and the TEMPLATE they came from.
 *
 * Split out of `expandJobNames` so that `matrixSkipAliases` derives its mapping
 * from the very same expansion rather than from a second copy of the rules. Two
 * copies held together only by a comment drift, and drift here is silent: the
 * alias map would stop covering a lane and the gate would fail a PR that is fine.
 *
 * @param {{ key: string, name: string | null, matrix: Record<string, string[]> }} job
 * @returns {{ template: string, names: string[] }} `template` equals the single
 *   name for a non-matrix job, and carries `${{ matrix.* }}` verbatim otherwise.
 */
function jobCheckNames(job) {
  const template = job.name ?? job.key;
  const keys = [...template.matchAll(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g)].map(
    (m) => m[1],
  );

  if (keys.length === 0) {
    if (template.includes('${{')) {
      throw new ReviewSignalError(
        'UNRESOLVED_JOB_NAME',
        `Job \`${job.key}\` has name \`${template}\`, which contains a GitHub Actions ` +
          'expression this gate cannot resolve. Its check name is therefore unknown, and a ' +
          'lane whose expected name is unknown cannot be checked for presence. Either give ' +
          'the job a literal name or teach this function that expression.',
      );
    }
    return { template, names: [template] };
  }

  let combos = [template];
  for (const key of keys) {
    const values = job.matrix[key];
    if (!values || values.length === 0) {
      throw new ReviewSignalError(
        'UNRESOLVED_JOB_NAME',
        `Job \`${job.key}\` names \`matrix.${key}\` in its check name but no inline ` +
          `\`${key}: [...]\` list was found under \`strategy.matrix\`. The set of check ` +
          'names it publishes is unknown; refusing to guess.',
      );
    }
    combos = combos.flatMap((c) =>
      values.map((v) =>
        c.replaceAll(new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, 'g'), v),
      ),
    );
  }
  for (const c of combos) {
    if (c.includes('${{')) {
      throw new ReviewSignalError(
        'UNRESOLVED_JOB_NAME',
        `Job \`${job.key}\` still carries an unresolved expression after matrix expansion: ` +
          `\`${c}\`.`,
      );
    }
  }
  return { template, names: combos };
}

/**
 * The check-run names a fired run of this workflow is expected to publish.
 *
 * A job with no `name:` publishes under its key; a job with a matrix publishes
 * one check per combination. Path filters and `if:` conditions do NOT remove a
 * job from this set: GitHub publishes a skipped job as a check run with
 * conclusion `skipped`, so PRESENCE is exactly the "did the workflow fire"
 * question, independent of what any filter decided. Verified against PR #3305's
 * rollup, which carries `Docs checks (docs-only PRs)` at `SKIPPED`.
 *
 * THAT PREMISE HAS ONE EXCEPTION, AND THE EVIDENCE ABOVE COULD NOT SHOW IT.
 * `Docs checks (docs-only PRs)` is a PLAIN job, so its skipped check run carries
 * the same name a run one would. A job skipped by `if:` BEFORE its matrix
 * expands publishes ONE check run under the UNEXPANDED template, verbatim
 * braces and all. Measured on PR #3581, a `.coderabbit.yaml`-only change, whose
 * rollup carries:
 *
 *   Viewer tests (shard ${{ matrix.shard }})   COMPLETED/SKIPPED
 *
 * and no `Viewer tests (shard 0..3)` at all. So the four names this function
 * derives are unsatisfiable on any PR that touches neither `frontend` nor
 * `rust` paths, and the gate called that MISSING_LANES with a remedy -- "re-run
 * the workflow" -- that cannot work, because nothing failed to spawn.
 *
 * `matrixSkipAliases` below carries the mapping needed to close that, and
 * `missingLanes` accepts it. This function's own output is unchanged: the four
 * expansions are still what a job that DOES run must publish.
 *
 * THE HOLE THIS LEAVES, STATED. A wholesale skip is accepted without judging
 * WHY the job was skipped, because nothing in the rollup says why. `if:` is one
 * reason; an unsatisfied `needs:` is another, so a failed `build` also skips
 * `viewer-tests` before expansion and its four shards then read present.
 *
 * MEASURED, not assumed. With every lane present, `Build packages + WASM` at
 * `failure` and the viewer template at `skipped`, this gate exits 0 and prints
 * "All 16 required lane(s) ... are present": it does NOT read lane state for the
 * presence verdict, so a failed dependency is simply present. What keeps such a
 * PR red is BRANCH PROTECTION -- `Build + WASM + Rust + Node` is a required
 * check in main's ruleset -- and not anything this gate does. An earlier draft
 * of this paragraph credited that protection to the rollup reading here; it was
 * wrong, and reproducing it is what showed it. The skip is printed by name
 * either way, rather than absorbed into a tick.
 *
 * @param {string} text - workflow file contents.
 * @param {{ exclude?: Iterable<string> }} [opts] - job KEYS to leave out.
 * @returns {string[]} sorted check names.
 */
export function expandJobNames(text, opts = {}) {
  const exclude = new Set(opts.exclude ?? []);
  const names = new Set();

  for (const job of parseWorkflowJobs(text)) {
    if (exclude.has(job.key)) continue;
    for (const n of jobCheckNames(job).names) names.add(n);
  }

  if (names.size === 0) {
    throw new ReviewSignalError(
      'EMPTY_REQUIRED_SET',
      'The required lane set derived from the workflow is empty. A presence check against an ' +
        'empty set passes over every possible rollup, which is the vacuity this gate exists to ' +
        'reject.',
    );
  }
  return [...names].sort();
}

/**
 * Expanded check name -> the unexpanded template its job publishes when the
 * WHOLE job is skipped before the matrix expands.
 *
 * Only matrix jobs appear here. A plain job's skipped check run already carries
 * the name `expandJobNames` derives, so it needs no alias and gets none: adding
 * one would let a plain lane be satisfied by something other than itself.
 *
 * @param {string} text - workflow file contents.
 * @param {{ exclude?: Iterable<string> }} [opts] - job KEYS to leave out.
 * @returns {Map<string, string>}
 */
export function matrixSkipAliases(text, opts = {}) {
  const exclude = new Set(opts.exclude ?? []);
  const aliases = new Map();
  for (const job of parseWorkflowJobs(text)) {
    if (exclude.has(job.key)) continue;
    const { template, names } = jobCheckNames(job);
    if (names.length === 1 && names[0] === template) continue; // not a matrix job
    for (const n of names) aliases.set(n, template);
  }
  return aliases;
}

/**
 * Templates present in the rollup with conclusion `skipped` -- GitHub saying it
 * decided the whole job before expanding it.
 *
 * `skipped` AND NOTHING ELSE. The template name appearing at `success` would
 * mean a job really is publishing under a literal `${{ ... }}` name, which is a
 * broken workflow, not a skip; at `queued` it would mean the decision is not
 * made yet, and treating that as covered would let the poll stop early on a
 * matrix that is still about to fan out.
 *
 * @param {Array<{ name: string, state?: string }>} rollup
 * @param {Map<string, string>} aliases
 * @returns {Set<string>}
 */
export function wholesaleSkippedTemplates(rollup, aliases) {
  const templates = new Set(aliases.values());
  const out = new Set();
  // NO `Array.isArray` GUARD. Every caller reaches here past `missingLanes`,
  // which throws NO_ROLLUP on a non-array first, so the guard could not fire --
  // and if it ever did, returning an empty set would be this file's own doctrine
  // inverted: an unreadable rollup reported as "nothing was skipped". Iterating a
  // non-array throws, which is the loud answer.
  for (const c of rollup) {
    if (templates.has(c.name) && String(c.state ?? '').toLowerCase() === 'skipped') {
      out.add(c.name);
    }
  }
  return out;
}

/**
 * Which required lanes are absent from the rollup.
 *
 * "Present" means the name appears AT ALL -- queued, in progress, skipped or
 * finished. The question is whether the workflow fired, and a lane that is
 * still spawning has fired. This is what keeps the check from false-failing on
 * the `opened`/`synchronize` race, where the caller polls until this returns
 * empty or the budget runs out.
 *
 * A required name is ALSO present when its job was skipped wholesale before the
 * matrix expanded -- see `matrixSkipAliases`. That is not a weakening of the
 * presence rule, it is the same rule read off the check run GitHub actually
 * published: a skipped plain job satisfies its own name, and this lets a skipped
 * matrix job satisfy the names it would have published. Absence with NO check
 * run of either kind still fails, which is the case the gate exists for.
 *
 * @param {string[]} required
 * @param {Array<{ name: string, state?: string }>} rollup
 * @param {Map<string, string>} [aliases] - from `matrixSkipAliases`; empty means
 *   the strict name-for-name rule, which is what every caller had before.
 * @returns {string[]} sorted missing names.
 */
export function missingLanes(required, rollup, aliases = new Map()) {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    throw new ReviewSignalError(
      'NO_ROLLUP',
      'The status-check rollup for this commit came back empty. That is indistinguishable from ' +
        '"every lane is missing" and must never be read as "nothing to check": the API may have ' +
        'failed, the token may lack `checks: read`, or the head SHA may be wrong.',
    );
  }
  const present = new Set(rollup.map((c) => c.name));
  const skipped = wholesaleSkippedTemplates(rollup, aliases);
  return required.filter((n) => !present.has(n) && !skipped.has(aliases.get(n))).sort();
}

/**
 * Review checks reporting SUCCESS while their own description says they did not
 * review anything.
 *
 * Scope is deliberately narrow: only contexts named in `reviewers`, and only
 * `success`. Everything else on a PR carries free text this gate has no business
 * adjudicating -- `Vercel - ifc-lite :: Canceled by Ignored Build Step` is a
 * true statement about a deploy, not a claim about the code.
 *
 * A named reviewer that reports `success` with NO readable description fails
 * closed (`UNREADABLE_DESCRIPTION`): "I could not read the verdict" and "the
 * verdict was fine" are the two answers this whole gate exists to separate.
 *
 * @param {Array<{ name: string, state: string, description?: string | null }>} checks
 * @param {{ reviewers: string[], phrases: Array<{ startsWith: string, means: string }> }} cfg
 * @returns {Array<{ name: string, description: string | null, reason: string, means: string }>}
 */
export function noVerdictReviews(checks, cfg) {
  const reviewers = new Set(cfg.reviewers);
  const findings = [];

  for (const check of checks) {
    if (!reviewers.has(check.name)) continue;
    if (String(check.state).toLowerCase() !== 'success') continue;

    const desc = typeof check.description === 'string' ? check.description.trim() : '';
    if (desc === '') {
      findings.push({
        name: check.name,
        description: null,
        reason: 'UNREADABLE_DESCRIPTION',
        means:
          'reported a passing state with no description at all, so nothing distinguishes a real ' +
          'review from a skipped one',
      });
      continue;
    }

    // Prefix match, not substring: the observed phrases are all sentence
    // openers, and a substring test over vendor free text is how a phrase list
    // starts matching things it was never aimed at.
    const hit = cfg.phrases.find((p) =>
      desc.toLowerCase().startsWith(String(p.startsWith).toLowerCase()),
    );
    if (hit) {
      findings.push({
        name: check.name,
        description: desc,
        reason: 'NO_VERDICT',
        means: hit.means,
      });
    }
  }
  return findings;
}

/**
 * Terminal conclusions for a rollup entry. GitHub publishes a downstream job's
 * check run only once its `needs` have completed, so the aggregate lane
 * (`Build + WASM + Rust + Node`) is legitimately ABSENT while anything upstream
 * is still running. Measured on PR #3305 mid-run: 15 of the 16 derived names
 * present, the aggregate missing purely because the census was `IN_PROGRESS`.
 *
 * That is why presence alone cannot decide the question. The settle rule is:
 * while any lane that HAS appeared is still moving, more lanes may yet appear,
 * so absence proves nothing.
 *
 * BUT "EVERY PRESENT LANE IS TERMINAL" IS NOT, ON ITS OWN, PROOF OF ABSENCE,
 * AND THAT WAS A REAL DEFECT IN THIS FILE. A downstream job's check run is
 * created only when its `needs` complete, so at EVERY fan-out boundary there is
 * an instant where every published lane is terminal and more are still coming.
 * Replaying all 71 completed `test.yml` PR runs of 2026-08-25/26 at one-second
 * resolution, 31 of them contain such an instant -- 36 windows in total, EVERY
 * ONE EXACTLY 1 s WIDE. Run 32930088375 (green) has three, at t=266/415/1386 s
 * from run creation; a single read at t=266 s sees `Detect changes` alone,
 * terminal, and the un-held rule reads that as "13 of the 14 required lanes
 * will never appear" on a run that went on to pass everything.
 *
 * SO THE VERDICT MUST HOLD, NOT MERELY OCCUR: see `SETTLE_HOLD_SECONDS`.
 */
const TERMINAL = new Set([
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
  'neutral',
  'action_required',
  'stale',
  'startup_failure',
  'error',
]);

/**
 * Whether the rollup has stopped moving, i.e. whether an absence is now proof.
 *
 * @param {Array<{ state: string }>} lanes
 * @returns {boolean}
 */
export function rollupSettled(lanes) {
  if (!Array.isArray(lanes) || lanes.length === 0) return false;
  return lanes.every((l) => TERMINAL.has(String(l.state ?? '').toLowerCase()));
}

/**
 * How long a settled-but-incomplete rollup must STAY settled, unchanged, before
 * its absence is accepted as proof.
 *
 * WHY AN ELAPSED INTERVAL AND NOT "TWO CONSECUTIVE READS". Two reads is really
 * "one `--poll-seconds`", so the guarantee it buys is whatever that flag
 * happens to be -- `--poll-seconds 1` silently shrinks it back to the width of
 * the race, and `--poll-seconds 0` deletes it. An interval in seconds is
 * denominated in the same unit as the thing being raced, so it stays a fixed
 * guarantee no matter how the poll cadence is tuned; the cadence then only
 * decides how many reads land inside it.
 *
 * THE ASSUMPTION IT RESTS ON, STATED RATHER THAN LEFT IMPLICIT: the gap between
 * the last already-published lane of a `test.yml` run reaching a terminal state
 * and GitHub creating the check run for the next fan-out wave never exceeds
 * SETTLE_HOLD_SECONDS. Measured maximum over the 36 windows found in those 71
 * runs: 1 s. 60 s is a 60x margin on that maximum.
 *
 * WHAT HAPPENS IF THE ASSUMPTION IS EVER VIOLATED. The window becomes visible
 * again and the gate false-FAILS with the missing-lane remedy -- exactly what it
 * does today, only 60x rarer. There is no configuration of this rule under which
 * a violation turns into a false PASS, because the hold only ever DELAYS the
 * "absent for good" verdict; it never manufactures one.
 *
 * WHY NOT RELY ON THE MASKING. In practice unrelated in-flight workflows in the
 * same rollup (`Viewer benchmark (advisory)`, the Vercel deploys) usually keep
 * one lane non-terminal across the window. That safety is INCIDENTAL -- it rests
 * on an advisory benchmark being slow, and nothing pins it -- so it is not a
 * reason to leave the rule un-held.
 *
 * COST. 60 s off the poll budget, paid only on the genuine-absence path (#3294's
 * shape), which otherwise decides on the first read. The lane-presence path is
 * unaffected: it returns the moment the last required name appears.
 */
export const SETTLE_HOLD_SECONDS = 60;

/**
 * Identity of a rollup for hold purposes: any lane appearing, disappearing or
 * changing state restarts the hold, because each of those is the rollup moving.
 *
 * @param {Array<{ name?: string, state?: string }>} lanes
 * @returns {string}
 */
function laneSignature(lanes) {
  return lanes
    .map((l) => `${String(l.name ?? '')} ${String(l.state ?? '').toLowerCase()}`)
    .sort()
    .join('');
}

/**
 * The poll loop, as a pure function over injected time and I/O.
 *
 * WHY THIS IS NOT INLINE IN `main()`. It used to be, and that made it the one
 * branch of this gate with no test: `--state-file` mode hardcodes
 * `timedOut: false` and jumps straight to `evaluate`, so the harness drove the
 * verdict and never the wait. The wait is where the budget defect lived -- the
 * 420 s default could not cover a `Build + WASM + Rust + Node` that APPEARED
 * (`created_at`, from its own run's creation -- NOT `started_at`, which is not
 * what a presence poll waits for) 509 to 2067 s in, across 68 runs -- so the
 * untested branch was the broken one. The clock, the sleep and the re-read are
 * all parameters, so the harness drives the timeout path in microseconds, and
 * the fan-out race below is replayed from a real run's timestamps rather than
 * argued about.
 *
 * The three stopping conditions, in the order they are checked:
 *   1. every required lane has appeared -- the question is answered `yes`;
 *   2. the rollup has SETTLED AND STAYED SETTLED, unchanged, for
 *      `settleHoldSeconds` -- every lane that has appeared is terminal and no
 *      new one arrived in that window, so a name still absent is absent for
 *      good -- answered `no`, fast. The HOLD is what keeps a 1 s fan-out window
 *      from being read as proof; see `SETTLE_HOLD_SECONDS`;
 *   3. the deadline passed -- answered `unknown`, which the caller renders as a
 *      FAILURE. A timeout is never a pass.
 *
 * @param {object} opts
 * @param {string[]} opts.required - lane names that must appear.
 * @param {{ lanes: Array<{ name: string, state: string }>, sha: string }} opts.initialState
 * @param {() => { lanes: Array<{ name: string, state: string }>, sha: string }} opts.fetchState
 * @param {number} opts.deadline - epoch ms after which the wait is over.
 * @param {number} opts.pollSeconds - seconds between re-reads.
 * @param {number} [opts.settleHoldSeconds] - how long a settled rollup must stay
 *   settled and unchanged before absence counts as proof.
 * @param {() => number} [opts.now] - injected clock.
 * @param {(ms: number) => void} opts.sleep - injected wait.
 * @param {(line: string) => void} [opts.log]
 * @returns {{ state: object, timedOut: boolean }}
 */
export function pollForLanes({
  required,
  aliases,
  initialState,
  fetchState,
  deadline,
  pollSeconds,
  settleHoldSeconds = SETTLE_HOLD_SECONDS,
  now = Date.now,
  sleep,
  log = () => {},
}) {
  // NOT DEFAULTED, for the same reason `mode` is not defaulted in the config: a
  // missing value here is a refusal. `aliases = new Map()` reads as harmless and
  // is not -- it silently restores the pre-#3581 rule, failing every config-only
  // PR with an unactionable remedy, and no test of this function can notice
  // because every test builds its own map. Caught in review: the tests added
  // with the alias map pinned the OFFLINE call site and left both LIVE ones
  // deletable while the whole suite stayed green.
  if (!(aliases instanceof Map)) {
    throw new ReviewSignalError(
      'MISSING_ALIASES',
      'pollForLanes was called without a matrix alias Map. Pass the map from ' +
        '`matrixSkipAliases` over the same workflow text `required` came from; pass an empty ' +
        'Map only to mean "this workflow has no matrix jobs", and mean it.',
    );
  }
  let state = initialState;
  // A non-finite hold falls back to the shipped default rather than to the
  // weaker rule: an unreadable guard must never be a disabled guard.
  const hold = Number.isFinite(settleHoldSeconds) ? settleHoldSeconds : SETTLE_HOLD_SECONDS;
  /** When the current unchanged settled rollup was first seen, or null. */
  let settledSince = null;
  let settledSignature = null;
  for (;;) {
    let stillMissing;
    try {
      stillMissing = missingLanes(required, state.lanes, aliases);
    } catch {
      stillMissing = required; // NO_ROLLUP: treat as "nothing has appeared yet".
    }
    if (stillMissing.length === 0) return { state, timedOut: false };

    if (rollupSettled(state.lanes)) {
      // `hold <= 0` is the PRE-FIX rule: accept the first settled read as proof.
      // It exists only so the regression test can drive the old behaviour and
      // show it getting run 32930088375 wrong; nothing ships it.
      if (hold <= 0) return { state, timedOut: false };
      const signature = laneSignature(state.lanes);
      if (settledSince === null || signature !== settledSignature) {
        // First sighting, or the rollup moved under us: restart the hold.
        settledSince = now();
        settledSignature = signature;
        log(
          `… every one of the ${state.lanes.length} published lane(s) is terminal but ` +
            `${stillMissing.length}/${required.length} required lane(s) are still absent; ` +
            `confirming across ${hold}s before calling that absence final.`,
        );
      } else if (now() - settledSince >= hold * 1000) {
        return { state, timedOut: false };
      }
    } else {
      settledSince = null;
      settledSignature = null;
    }

    if (now() >= deadline) return { state, timedOut: true };
    log(
      `… ${stillMissing.length}/${required.length} required lane(s) not yet published for ` +
        `${state.sha}; re-reading in ${pollSeconds}s ` +
        `(${Math.round((deadline - now()) / 1000)}s of budget left).`,
    );
    sleep(pollSeconds * 1000);
    state = fetchState();
  }
}

/**
 * PART 3 -- A REVIEW OF AN OLDER COMMIT HAS NOT REVIEWED THIS PR.
 *
 * louistrue, #3312: "A review whose `commit_id` is not the PR head has not
 * reviewed the PR." His example is #3276, and it is reproduced verbatim in the
 * tests: head `1305f778`, `CodeRabbit :: success / Review completed` sitting on
 * that head, and CodeRabbit's newest review event pointing at `c26e453d` --
 * three commits back, the last of which ("stop writing an express-id index as a
 * sparse array") is real code nothing reviewed.
 *
 * WHICH REVIEWS COUNT IS A POLICY QUESTION, AND IT IS CONFIGURABLE ON PURPOSE
 * (`staleReviewPolicy`). It is NOT settled here, because the obvious answers
 * are wrong against this repository's data:
 *
 *   "IGNORE `COMMENTED`" WOULD MAKE THIS A NO-OP. Measured 2026-08-26 over the
 *   review events on #3276, #3288 and #3227: every single one is `COMMENTED` --
 *   CodeRabbit's, cursor[bot]'s, greptile's, chatgpt-codex-connector's and the
 *   humans'. Not one `APPROVED` or `CHANGES_REQUESTED` among them. Dropping
 *   `COMMENTED` would drop #3276, the example the issue is written around.
 *
 *   "AN AUTHOR WITH NO REVIEW AT HEAD IS STALE" WOULD NAG CONSTANTLY. #3316,
 *   #3205 and #3290 carry ZERO review events of any kind, and #3316 and #3205
 *   nonetheless carry `CodeRabbit :: success / Review completed` on their heads:
 *   the reviewer reports a verdict without ever submitting a review object.
 *   Absence of a review is therefore NOT evidence of staleness here, and this
 *   function never reports it. THAT IS A STATED HOLE, not an oversight -- a
 *   reviewer that reviews without leaving a review event is invisible to a
 *   `commit_id` comparison, and no amount of scoping fixes that.
 *
 * SO THE SHIPPED DEFAULT IS THE NARROWEST RULE THAT STILL CATCHES #3276:
 * `claimed-verdict`. A finding requires all three of
 *   (a) the author is a configured reviewer identity (`reviewAuthors`),
 *   (b) that identity's check context reports `success` AT THE HEAD SHA -- i.e.
 *       something on this commit is actively claiming "reviewed, fine",
 *   (c) its newest review event names a different commit.
 * (b) is what keeps this off a reviewer that is merely still working: a bot
 * mid-review has a `pending` context, so a stale `commit_id` under it is a
 * race, not a defect. Measured over the 12 open PRs of 2026-08-26 this fires on
 * #3288, #3227 and #2952 and stays silent on #3315, #3309 and #2931, whose
 * newest CodeRabbit review names the head exactly.
 *
 * The looser policies exist so the choice is louistrue's rather than this
 * file's: `configured-authors` drops (b), and `all-authors` drops (a) too --
 * the latter is the one that would flag a human `APPROVED` predating a rebase.
 *
 * AND THE SHIPPED DEFAULT IS `off`, BECAUSE THE PREMISE IS FALSE FOR THIS
 * REPOSITORY'S PRIMARY REVIEWER. Measured live 2026-08-26 on all four PRs the
 * paragraph above claims as fires. CodeRabbit submits NO REVIEW EVENT AT ALL
 * when a run finds nothing actionable, so "no review object at the head" does
 * not mean "not reviewed":
 *
 *   #3276, head `1305f778`: `Review queued 14:09:52 -> in progress 14:09:55 ->
 *   success/Review completed 14:12:27`. A real 155 s cycle ON THE HEAD, and the
 *   walkthrough comment updated 14:12:25Z reads "No actionable comments were
 *   generated in the recent review" over "changes between c26e453d and
 *   1305f778" -- the head, including the commit this gate called unreviewed.
 *   #3288 is the same shape (181 s cycle, head named). BOTH ARE FALSE FIRES.
 *
 *   #3227 (14 s) and #2952 (9 s) are genuine: their walkthrough comments read
 *   "Reviews paused ... this branch is under active development", and CodeRabbit
 *   published `success / Review completed` anyway.
 *
 * SO 2 OF THE 4 FIRES ARE WRONG, AND NOTHING IN THE STRUCTURED DATA SEPARATES
 * THEM. The status text is byte-identical across all four (`success` /
 * `Review completed`); CodeRabbit publishes no CHECK RUN at all on any of these
 * heads, so there is no `conclusion` or `output.title` to read; and the
 * narrowing "a completed review cycle on this head counts as review" deletes
 * the rule rather than narrowing it -- clause (b) already requires `success` on
 * the head, and a `success` on the head IS a completed cycle on the head, so it
 * silences #3227 and #2952 too. The only signal that separates them is cycle
 * DURATION (155/181 s against 14/9 s), which is an unversioned timing heuristic
 * on a third party -- the same "transient GitHub state" input this repo already
 * ruled out for gating -- and the only other one is the reviewer's PROSE, which
 * the config note rules out on purpose.
 *
 * A gate cannot be shipped on a premise that is wrong half the time, and this
 * one cannot be repaired without a discriminator that does not exist. So the
 * machinery, the three scopings and the four worked examples all ship, and the
 * default is `off`: the rule is not adjudicated unless a maintainer opts in,
 * and `off` NEVER prints a pass -- see the caller. #3227 and #2952 remain
 * catchable by anyone who sets it.
 *
 * @type {ReadonlySet<string>}
 */
export const STALE_REVIEW_POLICIES = new Set([
  'off',
  'claimed-verdict',
  'configured-authors',
  'all-authors',
]);

/** Review states that are not a submitted verdict on a commit. */
const NON_VERDICT_REVIEW_STATES = new Set(['dismissed', 'pending']);

/**
 * Reviews whose `commit_id` is not the PR head, under the configured policy.
 *
 * THE ASSUMPTION THIS RESTS ON, STATED RATHER THAN LEFT IMPLICIT: for one
 * author, a review with a larger `id` is the later review. `id` is GitHub's
 * globally increasing review id, it is present on every review event, and this
 * function refuses a review without one (`UNREADABLE_REVIEW_ID`), so the order
 * is total on exactly the rows it compares.
 *
 * IT USED TO BE `(submitted_at, id)`, AND THAT WAS STRICTLY WORSE. The primary
 * key was the one field that can be absent: a review with no `submitted_at`
 * sorted to `''` and lost to EVERY dated review, so a review AT THE HEAD with a
 * missing timestamp would be masked by an older dated one and this would report
 * a current PR as stale -- the one direction the paragraph below promises is
 * impossible. `id` alone removes that class outright rather than bounding it,
 * and it costs nothing: the composite key's only extra information was that
 * missing field. `submitted_at` is still carried into the finding, where it is
 * printed rather than compared.
 *
 * The bound on the remaining assumption: if id order ever disagreed with real
 * order, this compares the WRONG review's `commit_id` against the head, which
 * can only mis-rank reviews an author left on the same PR -- it cannot invent a
 * finding on a PR whose every review names the head, because then every
 * candidate compares equal.
 *
 * FAIL-CLOSED, like everything else in this file: `NO_HEAD_SHA`, `NO_REVIEWS`,
 * `REVIEWS_TRUNCATED`, `EMPTY_REVIEW_AUTHORS`, `UNREADABLE_COMMIT_ID` and
 * `UNREADABLE_REVIEW_ID` are each a distinct refusal, and none of them is
 * reachable by a path that prints OK.
 *
 * @param {Array<{ id?: number, commit_id?: string, submitted_at?: string,
 *                 state?: string, user?: { login?: string } }>} reviews
 * @param {object} cfg
 * @param {string} cfg.headSha - the PR head, 40 hex.
 * @param {string} cfg.policy - one of `STALE_REVIEW_POLICIES`.
 * @param {Array<{ login: string, context: string }>} cfg.authors
 * @param {Array<{ name: string, state: string }>} [cfg.checks] - head-SHA rollup,
 *   for the `claimed-verdict` clause (b).
 * @param {Iterable<string>} [cfg.alreadyFlagged] - contexts part 2 already
 *   reported. The remedy is identical (re-run the reviewer) and the part 2
 *   finding quotes the reviewer verbatim, so saying it twice is pure noise.
 *
 * A DEDUPED FINDING IS RETURNED WITH `suppressedBy` SET, NOT DROPPED. Dropping
 * it made the returned list mean two different things -- "clean" and "found,
 * but not worth repeating" -- and the caller could only see the length, so it
 * printed the part 3 pass line over a finding it had made, and the
 * `staleReviewSeverity` knob became inoperative on exactly the PRs where both
 * halves fired. A gate printing a tick it did not earn is the defect class this
 * whole file exists to remove; the caller now suppresses the SENTENCE and keeps
 * the VERDICT.
 *
 * @returns {Array<{ login: string, context: string | null, reviewedSha: string,
 *                   submittedAt: string | null, suppressedBy: string | null }>}
 */
export function staleReviews(reviews, cfg) {
  const { headSha, policy, authors, checks = [], alreadyFlagged = [] } = cfg ?? {};

  if (!STALE_REVIEW_POLICIES.has(policy)) {
    throw new ReviewSignalError(
      'BAD_CONFIG',
      `\`staleReviewPolicy\` must be one of ${[...STALE_REVIEW_POLICIES].join(', ')}; found ` +
        `${JSON.stringify(policy)}. It is not defaulted on purpose: an unrecognised value ` +
        'silently selecting a rule nobody chose is a change nobody would notice.',
    );
  }
  // `off` ADJUDICATES NOTHING, so it refuses nothing either. The fail-closed
  // guards below all exist to stop a bad read printing a pass; under `off`
  // there is no pass to print -- the caller renders "not adjudicated" -- so
  // taking the gate down over reviews this policy never reads would be noise.
  // Validated FIRST, above the head check, so that is true of every input.
  if (policy === 'off') return [];

  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new ReviewSignalError(
      'NO_HEAD_SHA',
      `Staleness is defined against the PR head, and the head came back as ` +
        `${JSON.stringify(headSha)}. Every review would compare unequal to an unreadable head, ` +
        'so this refuses rather than reporting every review stale.',
    );
  }
  if (!Array.isArray(reviews)) {
    throw new ReviewSignalError(
      'NO_REVIEWS',
      'The reviews endpoint returned no readable array. "I could not read the reviews" and ' +
        '"every review is current" are the two answers this check exists to separate, so an ' +
        'unreadable read is a refusal, never an empty finding list.',
    );
  }
  const scopedAuthors = new Map((authors ?? []).map((a) => [a.login, a.context]));
  if (policy !== 'all-authors' && scopedAuthors.size === 0) {
    throw new ReviewSignalError(
      'EMPTY_REVIEW_AUTHORS',
      `Policy \`${policy}\` scopes staleness to \`reviewAuthors\`, and that list is empty. An ` +
        'empty identity list examines nothing and reports success, which is the vacuity this ' +
        'whole gate rejects.',
    );
  }

  // Scope FIRST, then validate: a malformed review by someone this policy does
  // not count must not take the gate down, but a malformed review it DOES count
  // must, because skipping it would silently promote an older review to
  // "newest" and compare the wrong commit.
  const scoped = [];
  for (const r of reviews) {
    if (NON_VERDICT_REVIEW_STATES.has(String(r?.state ?? '').toLowerCase())) continue;
    const login = r?.user?.login;
    if (typeof login !== 'string' || login === '') continue;
    if (policy !== 'all-authors' && !scopedAuthors.has(login)) continue;
    scoped.push({ ...r, login });
  }

  const passing = new Set(
    checks
      .filter((c) => String(c?.state ?? '').toLowerCase() === 'success')
      .map((c) => String(c?.name ?? '')),
  );
  const flagged = new Set(alreadyFlagged);

  /** @type {Map<string, { id: number, sha: string, at: string | null }>} */
  const newest = new Map();
  for (const r of scoped) {
    if (typeof r.commit_id !== 'string' || !/^[0-9a-f]{40}$/.test(r.commit_id)) {
      throw new ReviewSignalError(
        'UNREADABLE_COMMIT_ID',
        `Review ${JSON.stringify(r.id)} by \`${r.login}\` has \`commit_id\` ` +
          `${JSON.stringify(r.commit_id)}, which is not a commit SHA. The one field this check ` +
          'turns on is unreadable, and dropping the review would promote an older one to ' +
          '"newest" and compare the wrong commit.',
      );
    }
    if (!Number.isFinite(r.id)) {
      throw new ReviewSignalError(
        'UNREADABLE_REVIEW_ID',
        `Review by \`${r.login}\` on ${r.commit_id.slice(0, 8)} has id ${JSON.stringify(r.id)}. ` +
          'Ids order the reviews; without one there is no defensible "newest".',
      );
    }
    const at = typeof r.submitted_at === 'string' ? r.submitted_at : null;
    const prev = newest.get(r.login);
    if (!prev || r.id > prev.id) newest.set(r.login, { id: r.id, sha: r.commit_id, at });
  }

  const findings = [];
  for (const [login, review] of newest) {
    const context = scopedAuthors.get(login) ?? null;
    let suppressedBy = null;
    if (policy === 'claimed-verdict') {
      // (b): only when something ON THIS HEAD claims the code is reviewed.
      if (context === null || !passing.has(context)) continue;
      // NOT `continue`. See the `alreadyFlagged` note: the sentence is
      // redundant, the finding is not.
      if (flagged.has(context)) suppressedBy = context;
    }
    if (review.sha === headSha) continue;
    findings.push({
      login,
      context,
      reviewedSha: review.sha,
      submittedAt: review.at,
      suppressedBy,
    });
  }
  return findings.sort((a, b) => a.login.localeCompare(b.login));
}

/**
 * Flatten `gh api --paginate --slurp` pages into one review list.
 *
 * SEPARATE FROM THE FETCH SO IT CAN BE TESTED. The truncation branch is the one
 * that only fires against a busy PR and a flaky network, i.e. exactly the branch
 * that would otherwise ship unexercised — and this file's last defect was an
 * unexercised branch. `--slurp` keeps the page boundaries, so a walk that ended
 * early is visible here rather than indistinguishable from a short last page.
 *
 * WHY TRUNCATION MUST REFUSE RATHER THAN USE WHAT ARRIVED. Part 3 compares the
 * NEWEST review, and the newest review is on the LAST page. A partial walk
 * therefore does not merely lose information: it compares an older review's
 * `commit_id` and reports a PR as stale when its newest review names the head.
 * That is a false finding, in the one direction a gate must never fail.
 *
 * @param {unknown} pages - the `--slurp` result.
 * @param {string} where - what was being read, for the error text.
 * @returns {Array<object>}
 */
export function flattenReviewPages(pages, where) {
  if (!Array.isArray(pages)) {
    throw new ReviewSignalError(
      'NO_REVIEWS',
      `${where} returned no readable array of pages. Refusing to read that as "every review is ` +
        'current".',
    );
  }
  const out = [];
  for (const page of pages) {
    if (!Array.isArray(page)) {
      throw new ReviewSignalError(
        'REVIEWS_TRUNCATED',
        `One page of ${where} was not an array, so the pagination walk did not complete. A ` +
          'partial walk can miss the NEWEST review, which is the only one part 3 compares — and ' +
          'missing it manufactures a stale finding on a PR that is current.',
      );
    }
    out.push(...page);
  }
  return out;
}

/**
 * Flatten `gh api --paginate --slurp` check-run pages into one list.
 *
 * WHY IT IS NOT ENOUGH TO ASK FOR `per_page=100`. This read feeds part 2, and
 * part 2's default under `claimed-verdict` is SILENCE: a reviewer context that
 * is not in the list is simply not adjudicated. So a walk that stopped after
 * one page does not fail loudly, it drops the finding -- a silent false
 * negative, and the one failure mode a gate must never have. It was not live
 * (the largest head measured 2026-08-26 carried 21 check runs against a 100
 * page size), and it was one commit away from being live.
 *
 * The check-runs endpoint pages an OBJECT rather than a bare array, so each
 * `--slurp` page is `{ total_count, check_runs: [...] }` and the shape check is
 * on `check_runs`. Same refusal as the reviews walk, same reason: a partial
 * read is not a short read.
 *
 * @param {unknown} pages - the `--slurp` result.
 * @param {string} where - what was being read, for the error text.
 * @returns {Array<object>}
 */
export function flattenCheckRunPages(pages, where) {
  if (!Array.isArray(pages)) {
    throw new ReviewSignalError(
      'NO_CHECK_RUNS',
      `${where} returned no readable array of pages. Refusing to read that as "no reviewer said ` +
        'anything".',
    );
  }
  const out = [];
  for (const page of pages) {
    const runs = page?.check_runs;
    if (!Array.isArray(runs)) {
      throw new ReviewSignalError(
        'NO_CHECK_RUNS',
        `One page of ${where} carried no \`check_runs\` array, so the pagination walk did not ` +
          'complete. A partial walk drops reviewer contexts, and a dropped context is silence, ' +
          'not a failure.',
      );
    }
    out.push(...runs);
  }
  return out;
}

// -------------------------------------------------- workflow trigger parsing

/**
 * Which base-branch filter keys, if any, sit on a workflow's `pull_request`
 * trigger -- `branches`, `branches-ignore`, or neither. Located structurally,
 * by indentation depth, rather than matched against one hard-coded spelling
 * of the value.
 *
 * #3433 caught the previous version of this check reading `branches: [main]`
 * (a flow sequence on one line) but not the equivalent block form:
 *
 *   branches:
 *     - main
 *
 * GitHub Actions treats both identically, so a regex that only recognises one
 * spelling can be defeated just by reformatting. This function never inspects
 * the VALUE of `branches` / `branches-ignore` at all, so every spelling GitHub
 * Actions accepts for it -- flow sequence, block sequence, a single
 * unbracketed scalar, a quoted string, an alias -- is covered the same way:
 * by finding the KEY at the right nesting depth under `on.pull_request` and
 * not caring what comes after its colon.
 *
 * This is not a general YAML parser -- deliberately: the workflow that runs
 * this file's own tests (`pr-review-signal.yml`) has NO `pnpm install` step,
 * on purpose, so that a gate whose job is to notice when other jobs did not
 * run depends on as little as possible. A `js-yaml` version of this function
 * shipped once and broke exactly that job (`ERR_MODULE_NOT_FOUND` -- no
 * install means no third-party import resolves). Node builtins only.
 *
 * @param {string} workflowYaml - a workflow file's full text.
 * @returns {string[]} - `[]`, `['branches']`, `['branches-ignore']`, or (an
 *   invalid but not this function's place to reject) both.
 */
export function pullRequestBranchFilterKeys(workflowYaml) {
  const lines = workflowYaml.split(/\r?\n/);
  const indentOf = (line) => /^[ ]*/.exec(line)[0].length;
  const isBlankOrComment = (line) => {
    const trimmed = line.trim();
    return trimmed === '' || trimmed.startsWith('#');
  };

  // The top-level `on:` key -- column 0, so no leading whitespace.
  const onIdx = lines.findIndex((line) => /^(?:on|'on'|"on"):/.test(line));
  if (onIdx === -1) return [];

  // Its block runs until the next column-0 key (a sibling of `on:`), or EOF.
  let onEnd = lines.length;
  for (let i = onIdx + 1; i < lines.length; i++) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentOf(lines[i]) === 0) {
      onEnd = i;
      break;
    }
  }

  // `pull_request:` somewhere inside the `on:` block.
  let pullRequestIdx = -1;
  let pullRequestIndent = -1;
  for (let i = onIdx + 1; i < onEnd; i++) {
    if (isBlankOrComment(lines[i])) continue;
    const match = /^([ ]*)pull_request:/.exec(lines[i]);
    if (match) {
      pullRequestIdx = i;
      pullRequestIndent = match[1].length;
      break;
    }
  }
  if (pullRequestIdx === -1) return [];

  // Its body: every following line indented deeper than it, until one that
  // is not (a sibling of `pull_request:`, e.g. `push:`), or the end of the
  // `on:` block.
  let bodyEnd = onEnd;
  for (let i = pullRequestIdx + 1; i < onEnd; i++) {
    if (isBlankOrComment(lines[i])) continue;
    if (indentOf(lines[i]) <= pullRequestIndent) {
      bodyEnd = i;
      break;
    }
  }

  // Direct children of `pull_request:` all share ONE indentation depth --
  // the first body line's. Anything deeper belongs to a key's own value (a
  // block sequence item, a nested flow collection continued on its own
  // line, ...), not to a sibling key, so it is never mistaken for one.
  let childIndent = -1;
  const keys = [];
  for (let i = pullRequestIdx + 1; i < bodyEnd; i++) {
    if (isBlankOrComment(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (childIndent === -1) childIndent = indent;
    if (indent !== childIndent) continue;
    const match = /^[ ]*([A-Za-z0-9_-]+):/.exec(lines[i]);
    if (match) keys.push(match[1]);
  }

  return ['branches', 'branches-ignore'].filter((key) => keys.includes(key));
}
