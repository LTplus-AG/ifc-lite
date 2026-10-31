/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The no-op `edited` replay (CI redesign, step 2).
 *
 * THE WASTE. test.yml fires on `pull_request: edited` because a retarget --
 * changing a PR's base branch -- fires `edited` and nothing else (#3772), and
 * a PR moved onto `main` with no run at all reads identically to a green one.
 * But `edited` also fires on every title and body edit, and the changesets
 * release PR rewrites its own body after every merge: measured over 400 PR
 * runs in 38 h, 158 (40%) re-tested a head SHA that already had a verdict.
 *
 * WHY NOT SKIP THE LANES. A skipped job still publishes a `skipped` check run,
 * `skipped` counts as a pass both in the aggregate at the foot of test.yml and
 * in GitHub's required-check evaluation, and that evaluation takes the LATEST
 * run per check name -- so a body edit on a red PR would turn the required
 * check green. That is the absence-reads-as-success class this repository's
 * gates exist to close, and it is why the trigger was widened without a
 * `changes.base` gate in the first place.
 *
 * WHAT THIS DOES INSTEAD. Two pure decisions, driven by the dispatcher in
 * scripts/ci-verdict-replay.mjs:
 *
 *   1. `isNoopEdit(event)`: the event is a `pull_request` `edited` whose
 *      `changes` carries no `base` -- a title/body edit, never a retarget.
 *   2. `selectReplayVerdict(checkRuns, ...)`: among the check runs GitHub holds
 *      for the head SHA, the LATEST COMPLETED aggregate (`Build + WASM + Rust +
 *      Node`) that is not this run's own. Its conclusion is the verdict this
 *      run REPLAYS: success stays success, anything else (failure, cancelled,
 *      timed_out, ...) is a failure. No completed aggregate at all is "nothing
 *      to replay", and the caller must then run the full lane set rather than
 *      guess.
 *
 * The `changes` job PROBES (decision 1 + "does a verdict exist") and emits
 * `noop=true` only when both hold; every lane then skips because no path
 * filter output is `true`, and the aggregate job replays the recorded verdict
 * instead of judging the (all-skipped) lanes. A retarget still gets the full
 * run it always did. The lanes' own check runs from the earlier run stay on
 * the SHA, which is what `PR review signal` reads.
 *
 * A LANE THAT READS THE EDIT ITSELF (the silent-revert guard). Its input is the
 * PR's title, body and labels, which is exactly what a no-op edit changes, so
 * replaying its old verdict is wrong in both directions: a PR that passed under
 * a `revert(...)` title and is retitled `feat(...)` would replay green, and a PR
 * that failed and then adds `Reverts #N` would replay red forever. Such a lane
 * runs on every `edited` event and the aggregate judges its FRESH result in a
 * step of its own (JUDGE_STEP_NAME). What may then be replayed is the recorded
 * verdict MINUS that lane: `onlyFailedLane` says whether the recorded failure
 * was that lane's alone. It reads the recorded run's jobs, so a failure of any
 * other lane still replays red, and "unknown" is never an excuse.
 *
 * FAILS CLOSED. An unreadable event, an API error, or a probe that found a
 * verdict which the replay then cannot find again all refuse loudly; none of
 * them is a pass.
 */

export const AGGREGATE_CHECK_NAME = 'Build + WASM + Rust + Node';

/** Step names in test.yml's aggregate job; the wiring test pins them to the YAML. */
export const REPLAY_STEP_NAME = 'Replay the verdict this head already has';
export const JUDGE_STEP_NAME = 'Judge the fresh silent-revert result';

/**
 * A `pull_request` `edited` event that changed neither the base branch nor
 * anything a test could see: the title, the body, or nothing at all.
 *
 * `changes.base` is the retarget marker GitHub sets when the base moved; the
 * workflow's own comment on the `edited` trigger documents why a retarget MUST
 * get a full run. `changes.title` / `changes.body` are the no-op shapes; an
 * `edited` with an empty `changes` object (observed on some API-driven edits)
 * is treated as no-op too, since nothing in it could be a base move.
 *
 * @param {object|null|undefined} event the parsed `$GITHUB_EVENT_PATH` payload
 * @param {string} [eventName] `$GITHUB_EVENT_NAME`; defaults to reading the
 *   payload's shape (a `pull_request` key)
 */
export function isNoopEdit(event, eventName = event?.pull_request ? 'pull_request' : undefined) {
  if (!event || typeof event !== 'object') return false;
  if (eventName !== 'pull_request') return false;
  if (event.action !== 'edited') return false;
  const changes = event.changes;
  if (changes && typeof changes === 'object' && Object.prototype.hasOwnProperty.call(changes, 'base')) return false;
  return true;
}

/** The Actions run id a check run belongs to, read off its details_url. */
export function runIdOf(checkRun) {
  const m = /\/actions\/runs\/(\d+)(?:\/|$)/.exec(checkRun?.details_url ?? '');
  return m ? m[1] : null;
}

/**
 * @param {Array<object>} checkRuns the `check_runs` array of
 *   `GET /repos/{owner}/{repo}/commits/{sha}/check-runs?filter=all`
 * @param {{sha: string, checkName?: string, excludeRunId?: string|number|null}} opts
 * @returns {{found: true, conclusion: string, success: boolean, url: string, runId: string|null, completedAt: string}
 *   | {found: false, reason: string}}
 */
export function selectReplayVerdict(checkRuns, { sha, checkName = AGGREGATE_CHECK_NAME, excludeRunId = null } = {}) {
  if (!Array.isArray(checkRuns)) return { found: false, reason: 'check_runs is not an array' };
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return { found: false, reason: `not a full SHA: ${JSON.stringify(sha)}` };
  const exclude = excludeRunId == null ? null : String(excludeRunId);
  const candidates = checkRuns.filter(
    (r) =>
      r &&
      r.name === checkName &&
      r.head_sha === sha &&
      r.status === 'completed' &&
      typeof r.completed_at === 'string' &&
      (exclude === null || runIdOf(r) !== exclude),
  );
  if (candidates.length === 0) {
    return { found: false, reason: `no completed "${checkName}" check run for ${sha.slice(0, 9)} other than this run's` };
  }
  candidates.sort((a, b) => (a.completed_at < b.completed_at ? 1 : a.completed_at > b.completed_at ? -1 : 0));
  const latest = candidates[0];
  const conclusion = typeof latest.conclusion === 'string' ? latest.conclusion : 'unknown';
  return {
    found: true,
    conclusion,
    // ONLY `success` replays as a pass. `skipped` cannot occur for the
    // aggregate (it runs `if: always()`), and `neutral`, `cancelled`,
    // `timed_out`, `action_required`, `stale` and `failure` all mean "no
    // green verdict was reached for this head".
    success: conclusion === 'success',
    url: latest.html_url ?? latest.details_url ?? '',
    runId: runIdOf(latest),
    completedAt: latest.completed_at,
  };
}

/**
 * Was the failure of a recorded aggregate run caused by `lane` alone?
 *
 * @param {Array<object>} jobs the recorded run's jobs (`name`, `conclusion`, `steps`)
 * @param {{lane: string, aggregate?: string}} opts
 *
 * A FULL run: the lane's job failed and every other job succeeded or skipped.
 * A NO-OP run (its aggregate ran the replay step): it failed on its fresh
 * judgement, i.e. the replay step succeeded and the judge step failed. Its
 * other lanes are all skipped, so job conclusions say nothing there; asking
 * "did every other job succeed" would excuse a replayed typecheck failure.
 */
export function onlyFailedLane(jobs, { lane, aggregate = AGGREGATE_CHECK_NAME }) {
  if (!Array.isArray(jobs)) return false;
  const agg = jobs.find((j) => j?.name === aggregate);
  if (!agg) return false;
  const step = (name) => (agg.steps ?? []).find((s) => s?.name === name);
  const replay = step(REPLAY_STEP_NAME);
  if (replay && replay.conclusion !== 'skipped') {
    return replay.conclusion === 'success' && step(JUDGE_STEP_NAME)?.conclusion === 'failure';
  }
  const guard = jobs.find((j) => j?.name === lane);
  if (guard?.conclusion !== 'failure') return false;
  return jobs.every((j) => j === agg || j === guard || j?.conclusion === 'success' || j?.conclusion === 'skipped');
}
