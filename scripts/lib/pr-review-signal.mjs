/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Pure classification for `scripts/check-pr-review-signal.mjs` (issue #3312).
 *
 * The gate answers two questions that no existing signal on a PR can answer,
 * and both are questions about ABSENCE rather than about failure:
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
 * `EMPTY_REQUIRED_SET`, `NO_ROLLUP`, `UNREADABLE_DESCRIPTION`. None of them is
 * reachable by a code path that prints OK.
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
 * The check-run names a fired run of this workflow is expected to publish.
 *
 * A job with no `name:` publishes under its key; a job with a matrix publishes
 * one check per combination. Path filters and `if:` conditions do NOT remove a
 * job from this set: GitHub publishes a skipped job as a check run with
 * conclusion `skipped`, so PRESENCE is exactly the "did the workflow fire"
 * question, independent of what any filter decided. Verified against PR #3305's
 * rollup, which carries `Docs checks (docs-only PRs)` at `SKIPPED`.
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
      names.add(template);
      continue;
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
      names.add(c);
    }
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
 * Which required lanes are absent from the rollup.
 *
 * "Present" means the name appears AT ALL -- queued, in progress, skipped or
 * finished. The question is whether the workflow fired, and a lane that is
 * still spawning has fired. This is what keeps the check from false-failing on
 * the `opened`/`synchronize` race, where the caller polls until this returns
 * empty or the budget runs out.
 *
 * @param {string[]} required
 * @param {Array<{ name: string }>} rollup
 * @returns {string[]} sorted missing names.
 */
export function missingLanes(required, rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    throw new ReviewSignalError(
      'NO_ROLLUP',
      'The status-check rollup for this commit came back empty. That is indistinguishable from ' +
        '"every lane is missing" and must never be read as "nothing to check": the API may have ' +
        'failed, the token may lack `checks: read`, or the head SHA may be wrong.',
    );
  }
  const present = new Set(rollup.map((c) => c.name));
  return required.filter((n) => !present.has(n)).sort();
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
 * COST. 60 s off a 900 s budget, paid only on the genuine-absence path (#3294's
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
  initialState,
  fetchState,
  deadline,
  pollSeconds,
  settleHoldSeconds = SETTLE_HOLD_SECONDS,
  now = Date.now,
  sleep,
  log = () => {},
}) {
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
      stillMissing = missingLanes(required, state.lanes);
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
