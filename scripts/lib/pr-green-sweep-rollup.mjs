// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Turns a raw `statusCheckRollup` (GitHub's per-PR list of CheckRun and
 * StatusContext rows) into pass/fail/pending counts, deduping the stale
 * duplicate rows a cancelled-and-superseded workflow run leaves behind
 * (#3792, #3797). Split out of `pr-green-sweep.mjs` as its own coherent unit
 * -- rollup counting is a distinct concern from sweep orchestration -- so
 * it's independently readable and testable.
 */

/**
 * Classify a single rollup row the way `countRollup` counts it, without
 * accumulating -- shared by `countRollup` and `dedupeByName`'s tie-break so
 * the two can never disagree about what "failing" means.
 * @returns {'pending' | 'pass' | 'fail'}
 */
function classifyCheck(check) {
  const status = String(check?.status ?? '').toUpperCase();
  if (status && status !== 'COMPLETED') return 'pending';
  const verdict = String(check?.conclusion ?? check?.state ?? '').toUpperCase();
  if (verdict === 'SUCCESS' || verdict === 'NEUTRAL' || verdict === 'SKIPPED') return 'pass';
  if (verdict === '' || verdict === 'PENDING' || verdict === 'EXPECTED') return 'pending';
  return 'fail';
}

/**
 * Drop a stale duplicate check row before counting.
 *
 * GitHub does not remove the check runs of a cancelled workflow run: when a
 * push (or a superseding `pull_request` event under `concurrency`) cancels an
 * in-flight run, that run's check runs stay attached to the head commit
 * alongside the fresh ones under the same lane name. `statusCheckRollup` then
 * carries two rows for one lane, and counting both charges the PR with the
 * cancelled one even though every live lane is green (#3792).
 *
 * Only rows that share an identifying name are deduped -- a row with neither
 * `name` nor `context` (the CheckRun/StatusContext key fields) is never
 * merged with anything, so an ungrouped duplicate cannot be silently dropped
 * by a key that does not actually identify the lane. `name` and `context` are
 * different namespaces (a CheckRun and a legacy StatusContext can share the
 * same string with no relation to each other), so the key is prefixed with
 * which field produced it -- an unrelated same-named row in the other
 * namespace can never collide with it (#3797).
 *
 * Among rows sharing a key, the newest `startedAt` wins, matching how
 * GitHub's own required-status-check evaluation resolves duplicates -- but
 * only when supersession is actually established (both timestamps parse and
 * differ). GitHub emits `startedAt: null` for a job cancelled while still
 * queued, and same-second timestamps make an exact tie plausible; in either
 * case there is no basis to call one row "newer". Treating an unknown or
 * tied timestamp as "definitely older" (as `!Number.isFinite` did) lets a
 * live, currently-failing row be silently overwritten by an unrelated stale
 * success. Under-counting a failure is the dangerous direction here -- a
 * false "FAILING" just wastes a look, a false "GREEN" ships a broken PR --
 * so when supersession can't be established, the failing row wins (#3797).
 */
function dedupeByName(rollup) {
  const named = [];
  const unnamed = [];
  const newestByName = new Map();
  for (const check of rollup) {
    const key =
      check?.name != null ? `name:${check.name}` : check?.context != null ? `context:${check.context}` : null;
    if (key == null) {
      unnamed.push(check);
      continue;
    }
    const startedAt = typeof check?.startedAt === 'string' ? Date.parse(check.startedAt) : NaN;
    const prior = newestByName.get(key);
    if (!prior) {
      newestByName.set(key, { check, startedAt });
      continue;
    }
    const bothDated = Number.isFinite(startedAt) && Number.isFinite(prior.startedAt);
    if (bothDated && startedAt !== prior.startedAt) {
      // Supersession is established: strictly newer wins outright, whatever
      // its verdict (this is what lets a fresh SUCCESS retire a stale
      // CANCELLED, and what lets a fresh CANCELLED still count as failing).
      if (startedAt > prior.startedAt) newestByName.set(key, { check, startedAt });
      continue;
    }
    // Inconclusive: an unparseable/missing timestamp on either side, or an
    // exact tie. Don't let it hide a failure -- keep whichever row is
    // failing; if neither or both are failing, the count comes out the same
    // either way, so keep the one already recorded (order-independent).
    if (classifyCheck(check) === 'fail' && classifyCheck(prior.check) !== 'fail') {
      newestByName.set(key, { check, startedAt });
    }
  }
  for (const { check } of newestByName.values()) named.push(check);
  return [...named, ...unnamed];
}

/**
 * Count a `statusCheckRollup` into pass/fail/pending.
 *
 * An EMPTY rollup counts to all zeros, which is why the caller must never read
 * `fail === 0` as green on its own -- `runCount` is the signal that separates
 * "nothing failed" from "nothing ran".
 */
export function countRollup(rollup) {
  let fail = 0;
  let pending = 0;
  let pass = 0;
  for (const check of dedupeByName(rollup ?? [])) {
    const verdict = classifyCheck(check);
    if (verdict === 'pending') pending += 1;
    else if (verdict === 'pass') pass += 1;
    else fail += 1;
  }
  return { fail, pending, pass };
}
