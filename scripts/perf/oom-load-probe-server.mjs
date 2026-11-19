/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pre-read refusal (#10353): "This IFC file exceeds this tab's local processing memory budget ...". */
export const REFUSAL_MESSAGE = /local processing memory budget/i;

/** Title of a pre-load memory warning that lets the user continue or cancel (#10353). */
export const MEMORY_WARNING = /may exceed available memory/i;

/**
 * Order of events in one load, relative to the file pick (#10353 server proof).
 * `timeline` entries are `{ ms, event, ... }`: 'request' | 'requestfailed' | 'response'
 * (network to the watched origin), 'dialog' (a dialog appeared, with its text),
 * 'notice' (an alert/status/toast appeared or changed text), 'store-error' (the viewer's
 * load error: stamped by a store subscription, or seen by the 2 s poll with `windowMs`), and
 * from the source tracker
 * 'source-read' (with `large`), 'unattributed-read' and 'worker-post' (with `source`).
 *
 * Every derived flag is three-valued: `true`, `false` only when the instrument
 * that would have seen the event was installed and reported (network listener
 * for attempts, the source tracker for reads and posts), `null` otherwise.
 * `tracker` is `trackerSummary(...)`; `reported: false` there makes every
 * read/post flag null.
 */
export function serverAttemptSummary(timeline, { watching, tracker }) {
  const first = (pred) => timeline.filter(pred).sort((a, b) => a.ms - b.ms)[0] ?? null;
  const decision = first((e) => (e.event === 'dialog' && (MEMORY_WARNING.test(e.text ?? '') || REFUSAL_MESSAGE.test(e.text ?? '')))
    || ((e.event === 'notice' || e.event === 'store-error') && REFUSAL_MESSAGE.test(e.text ?? '')));
  const firstDecisionMs = decision?.ms ?? null;
  // A decision seen only by a periodic poll happened at some point in (ms - windowMs, ms].
  const windowMs = decision?.windowMs ?? 0;
  /** true / false / null for "observed event at `ms` happened before the decision". */
  // Orders need the page's own pick stamp: every page-side time is relative to it, on one clock.
  const pickKnown = tracker?.reported === true && tracker.pickKnown === true;
  const before = (ms, observed) => {
    if (!observed || !pickKnown || firstDecisionMs === null) return null;
    if (ms === null || ms === undefined || ms >= firstDecisionMs) return false;
    return ms <= firstDecisionMs - windowMs ? true : null;
  };
  const trackerReported = tracker?.reported === true;
  const facts = trackerReported ? tracker.facts : null;
  // Request counts and the attempt come from the tracker's uncapped counters and kept facts
  // (page clock, relative to the page's own pick), never from the bounded event log, so many
  // startup requests cannot push the real attempt out of view. Driver-side network events are
  // on another clock and only supply the browser's error code.
  const tr = trackerReported ? tracker : null;
  const firstAttemptMs = watching && tr ? (tr.facts?.firstRequestAfterPick?.ms ?? null) : null;
  const pageSawRequests = tr ? (tr.requestsBeforePick ?? 0) + (tr.requestsAfterPick ?? 0) > 0 : false;
  const driverOnly = watching && tr !== null && !pageSawRequests && timeline.some((e) => e.event === 'driver-request');
  const unknown = {};
  if (watching && !pickKnown) unknown.order = 'the page never stamped the file pick (source not marked), so no order is established';
  if (driverOnly) unknown.attemptBeforeDecision = 'requests were seen only by the driver (from a worker or the browser), not on the page clock';
  /** Identity-dependent flag: null when the source was never marked, or when an unattributed
   *  event of at least the threshold size happened before the decision (it might be the source). */
  const identity = (name, ms, other, otherWhat) => {
    const v = before(ms, trackerReported);
    if (v === null || v === true) return v;
    if (!tracker.sourceMarked) { unknown[name] = 'the picked file was never marked (no file-input change event)'; return null; }
    const scan = facts?.firstIncompleteScan;
    if (name === 'sourcePostBeforeDecision' && before(scan?.ms ?? null, true) !== false) {
      unknown[name] = `a message to ${scan.worker} at ${Math.round(scan.ms)} ms was too large to scan for the source`;
      return null;
    }
    const objectUrl = facts?.firstSourceObjectUrl;
    if (name === 'sourcePostBeforeDecision' && before(objectUrl?.ms ?? null, true) !== false) {
      unknown[name] = `a blob: URL of the source was created at ${Math.round(objectUrl.ms)} ms; a worker could fetch it unseen`;
      return null;
    }
    if (before(other?.ms ?? null, true) !== false) {
      unknown[name] = `${otherWhat} of ${other.bytes} bytes at ${Math.round(other.ms)} ms before the decision may be the source`;
      return null;
    }
    return false;
  };
  const result = {
    watched: Boolean(watching),
    trackerReported,
    sourceMarked: trackerReported ? tracker.sourceMarked : null,
    pickKnown,
    attempts: watching && tr ? tr.requestsAfterPick ?? null : null,
    failures: watching && tr ? tr.failuresAfterPick ?? null : null,
    failureCode: watching ? (timeline.find((e) => e.event === 'driver-requestfailed')?.failure ?? null) : null,
    startupRequests: watching && tr ? { count: tr.requestsBeforePick ?? 0, ms: (tr.facts?.startupRequests ?? []).map((e) => e.ms) } : null,
    firstAttemptMs,
    firstDecisionMs,
    decisionWindowMs: decision ? windowMs : null,
    attemptBeforeDecision: driverOnly ? null : before(firstAttemptMs, watching),
    // From the tracker's kept facts (uncapped), never from its possibly truncated event log.
    readBeforeDecision: identity('readBeforeDecision', facts?.firstLargeSourceRead?.ms ?? null, facts?.firstUnattributedRead, 'an unattributed read'),
    unattributedReadBeforeDecision: before(facts?.firstUnattributedRead?.ms ?? null, trackerReported),
    sourcePostBeforeDecision: identity('sourcePostBeforeDecision', facts?.firstSourcePost?.ms ?? null, facts?.firstOtherPost, 'a worker post of another Blob'),
    logTruncated: trackerReported ? tracker.truncated : null,
    // A false source-post verdict means: every channel listed as instrumented reported none.
    channels: trackerReported ? tracker.channels ?? null : null,
  };
  if (Object.keys(unknown).length) result.unknownBecause = unknown;
  return result;
}

/**
 * Strict check of derived flags: passes only when every wanted flag has exactly the
 * wanted boolean. `null` (not observed) fails, whatever was wanted.
 */
export function expectFlags(summary, wanted) {
  const misses = Object.entries(wanted).filter(([k, v]) => summary?.[k] !== v)
    .map(([k, v]) => `${k}=${summary?.[k] === null || summary?.[k] === undefined ? 'unknown' : summary[k]} (wanted ${v})`);
  return { pass: misses.length === 0, message: misses.length ? `FAIL: ${misses.join(', ')}` : 'PASS (server tried first, no large source read or source post before the decision)' };
}

/** What `--expect-server-first` requires. */
export const SERVER_FIRST = Object.freeze({ attemptBeforeDecision: true, readBeforeDecision: false, sourcePostBeforeDecision: false });
