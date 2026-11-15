/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure parts of `oom-load-probe.mjs` (#10264): turning what one capped load
 * observed into an outcome, and deciding whether that outcome is the expected
 * one. Kept free of browser and cgroup access so the verdict logic is tested.
 *
 * Outcomes:
 *   loaded   the viewer reached full interactivity. Checked first, so text
 *            elsewhere on the page can never turn a finished load into
 *            anything else.
 *   refused  the viewer showed its explicit pre-read refusal (REFUSAL_MESSAGE,
 *            in the store's load error or a dialog/toast) and the tab survived.
 *            Nothing else is `refused`: the probe cannot see worker-side reads,
 *            so "no read observed" is never taken to mean "never started".
 *   awaiting-decision  the viewer showed a "may exceed available memory"
 *            warning (Continue loading / Cancel) and the load had not started;
 *            the probe was told to leave it there (--on-memory-dialog wait).
 *   cancelled the probe clicked Cancel on that warning (--on-memory-dialog cancel).
 *   killed   the tab died, with no warning accepted: the renderer or browser
 *            was OOM-killed inside the cap (seen vanishing at the kill), the
 *            page crashed, or the browser exited. An OOM kill of only a GPU or
 *            utility process is not a tab death: the probe keeps watching and
 *            classifies what the load then did (loaded with a note, killed if
 *            the renderer dies later, timeout). An OOM kill whose victim the
 *            probe could not identify, with the page still alive, is `error`:
 *            never `killed`, never a pass.
 *   killed-after-continue  the same, after the probe clicked Continue loading
 *            (--on-memory-dialog continue): the user was warned. Reported on
 *            its own, never folded into a pass or into plain `killed`.
 *   error    any other load error, including main's "Ran out of memory while
 *            processing" (always: the message exists only once processing ran,
 *            e.g. an entity pre-pass before any triangle streams) and the
 *            worker/runtime crash messages that leave the tab alive.
 *   timeout  none of the above within the time limit.
 *
 * The warning and refusal strings below match draft PR #10353's wording and
 * main's apps/viewer/src/lib/load-error-message.ts; they can drift, so keep
 * them in sync with the viewer.
 */

export const OUTCOMES = Object.freeze(['loaded', 'refused', 'awaiting-decision', 'cancelled', 'killed', 'killed-after-continue', 'error', 'timeout']);

/** Pre-read refusal (#10353): "This IFC file exceeds this tab's local processing memory budget ...". */
export const REFUSAL_MESSAGE = /local processing memory budget/i;

/** Main's out_of_memory explanation (load-error-message.ts): a failure after processing started. */
export const OOM_FAILURE_MESSAGE = /ran out of memory while processing/i;

/** Title of a pre-load memory warning that lets the user continue or cancel (#10353). */
export const MEMORY_WARNING = /may exceed available memory/i;

/** Accessible names of that warning's buttons (#10353). */
export const DIALOG_BUTTONS = Object.freeze({ cancel: /^cancel$/i, continue: /^continue loading$/i });

/** Chrome process types whose death is the tab dying. A GPU or utility process can be restarted. */
const TAB_PROCESSES = new Set(['renderer', 'browser']);

/**
 * @param {object} o
 * @param {number} [o.oomKills]        memory.events oom_kill of the cap's cgroup.
 * @param {string[]} [o.killedTypes]   Chrome process types that vanished at an OOM kill
 *                                     ('renderer', 'browser', 'gpu-process', 'utility', ...); empty if unknown.
 * @param {boolean} [o.pageCrashed]    Playwright page 'crash'.
 * @param {boolean} [o.browserGone]    Playwright context 'close' before the verdict.
 * @param {boolean} [o.interactive]    openAndWaitInteractive resolved.
 * @param {string|null} [o.storeError] the viewer store's load error.
 * @param {string[]} [o.notices]       text of dialogs, alerts and toasts at the end (not the whole page).
 * @param {boolean} [o.timedOut]
 * @param {boolean} [o.warningShown]   a MEMORY_WARNING dialog appeared before the load started.
 * @param {'none'|'continue'|'cancel'} [o.decision] what the probe clicked on it.
 * @returns {{ outcome: string, reason: string }}
 */
export function classify(o) {
  const killed = o.decision === 'continue' ? 'killed-after-continue' : 'killed';
  const types = o.killedTypes ?? [];
  const kills = o.oomKills ?? 0;
  const tabTypes = types.filter((t) => TAB_PROCESSES.has(t));
  const evidence = [...tabTypes.map((t) => `${t} OOM-killed`), o.pageCrashed && 'page crashed', o.browserGone && 'browser exited'].filter(Boolean);
  if (evidence.length) return { outcome: killed, reason: `${evidence.join(', ')}${kills ? ` (cgroup oom_kill=${kills})` : ''}` };
  if (kills > 0 && !types.length) return { outcome: 'error', reason: `cgroup oom_kill=${kills} but the probe could not tell which process died; the page stayed alive` };
  // Only GPU/utility processes died (or none): classify by what the surviving tab did.
  const note = kills > 0 ? `; note: cgroup OOM-killed ${types.join('+')} (not the tab)` : '';
  const r = classifyAlive(o);
  return note ? { outcome: r.outcome, reason: `${r.reason}${note}` } : r;
}

/** Outcome of a load whose tab is still alive. */
function classifyAlive(o) {
  if (o.interactive) return { outcome: 'loaded', reason: 'interactive' };
  if (o.warningShown && o.decision === 'cancel') return { outcome: 'cancelled', reason: 'memory warning, probe clicked Cancel' };
  if (o.warningShown && (o.decision ?? 'none') === 'none') return { outcome: 'awaiting-decision', reason: 'memory warning shown, load not started' };
  const texts = [o.storeError, ...(o.notices ?? [])].filter(Boolean).map(String);
  const refusal = texts.find((t) => REFUSAL_MESSAGE.test(t));
  if (refusal) return { outcome: 'refused', reason: refusal.trim().slice(0, 300) };
  const oom = texts.find((t) => OOM_FAILURE_MESSAGE.test(t));
  if (oom) return { outcome: 'error', reason: `out of memory during processing: ${oom.trim().slice(0, 260)}` };
  if (o.storeError) return { outcome: 'error', reason: String(o.storeError).slice(0, 300) };
  if (o.timedOut) return { outcome: 'timeout', reason: 'time limit' };
  return { outcome: 'error', reason: 'no verdict observed' };
}

/** Accepted values of `--expect`. */
export const EXPECTATIONS = Object.freeze({
  // Known-issue mode: today the minimal case is killed. A run that no longer
  // gets killed FAILS too, so the fix landing forces the flag to be flipped
  // instead of the repro silently going green.
  killed: ['killed'],
  // Acceptance mode (#10264 acceptance): the tab is never killed.
  'not-killed': ['loaded', 'refused', 'awaiting-decision', 'cancelled'],
  // Weaker acceptance: never killed WITHOUT a warning the user accepted.
  // killed-after-continue passes here but is named in the verdict.
  warned: ['loaded', 'refused', 'awaiting-decision', 'cancelled', 'killed-after-continue'],
  loaded: ['loaded'],
  refused: ['refused'],
});

/**
 * @returns {{ pass: boolean, message: string }} `error` and `timeout` never pass.
 */
export function verdict(outcome, expect) {
  const accepted = Object.hasOwn(EXPECTATIONS, expect) ? EXPECTATIONS[expect] : null;
  if (!accepted) throw new Error(`--expect must be one of ${Object.keys(EXPECTATIONS).join(', ')}`);
  if (accepted.includes(outcome)) {
    if (expect === 'killed') return { pass: true, message: 'PASS (known issue #10264 still reproduces: the tab was killed)' };
    if (outcome === 'killed-after-continue') return { pass: true, message: 'PASS (warned): the tab was killed AFTER the user clicked Continue loading on the memory warning' };
    return { pass: true, message: `PASS (${outcome})` };
  }
  if (expect === 'killed' && outcome !== 'error' && outcome !== 'timeout') {
    return { pass: false, message: `FAIL: expected the known #10264 kill but the load was ${outcome}. `
      + 'If the fix has landed, switch this run to --expect not-killed.' };
  }
  return { pass: false, message: `FAIL: expected ${expect}, got ${outcome}` };
}

/** Parse a systemd size ("3G", "1536M", "3221225472") into bytes. */
export function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(String(text).trim());
  if (!m) throw new Error(`bad size ${text}`);
  return Math.round(Number(m[1]) * 1024 ** ' KMGT'.indexOf((m[2] || ' ').toUpperCase()));
}

/** Coarse phase from the last page sample: what the load had reached when it ended. */
export function phaseOf(sample) {
  if (!sample) return 'before-open';
  if (sample.interactive) return 'loaded';
  if (sample.warning) return 'memory warning (load not started)';
  if ((sample.tris ?? 0) > 0) return sample.progress?.phase === 'Complete' ? 'geometry complete (not yet interactive)' : 'geometry-streaming';
  if (sample.progress?.phase) return `pre-geometry (${sample.progress.phase})`;
  return sample.loading ? 'pre-geometry' : 'before-open';
}

const POSITIVE = /^\d+(\.\d+)?$/;

/**
 * Validate raw CLI strings (parseArgs values). Returns a list of problems; empty means valid.
 * Every number must be a plain positive decimal, so '' / '0x4' / 'abc' / '-1' are rejected
 * before anything is generated or launched.
 */
export function optionErrors(v) {
  const errors = [];
  if (!v.expect || !Object.hasOwn(EXPECTATIONS, v.expect)) errors.push(`--expect is required: ${Object.keys(EXPECTATIONS).join(' | ')}`);
  if (!v.cap) errors.push('--cap is required (e.g. 3G)');
  else { try { parseSize(v.cap); } catch { errors.push(`--cap ${v.cap} is not a size like 3G or 1536M`); } }
  if (!v.fixture && !(v.kind && v['target-mb'])) errors.push('give --fixture or --kind and --target-mb');
  if (v.kind !== undefined && !['tfs', 'brep'].includes(v.kind)) errors.push('--kind must be tfs or brep');
  for (const k of ['target-mb', 'cores', 'device-memory', 'limit-min']) {
    if (v[k] !== undefined && !(POSITIVE.test(v[k]) && Number(v[k]) > 0)) errors.push(`--${k} must be a positive number, got '${v[k]}'`);
  }
  if (v.seed !== undefined && !/^\d+$/.test(v.seed)) errors.push(`--seed must be a non-negative integer, got '${v.seed}'`);
  if (v['cpu-quota'] !== undefined && !/^\d+%$/.test(v['cpu-quota'])) errors.push(`--cpu-quota must look like 400%, got '${v['cpu-quota']}'`);
  if (v.gl !== undefined && !['swiftshader', 'hardware'].includes(v.gl)) errors.push('--gl must be swiftshader or hardware');
  if (v['on-memory-dialog'] !== undefined && !['wait', 'cancel', 'continue'].includes(v['on-memory-dialog'])) errors.push('--on-memory-dialog must be wait, cancel or continue');
  if (v['watch-url'] !== undefined) {
    let ok = false;
    try { ok = ['http:', 'https:'].includes(new URL(v['watch-url']).protocol); } catch { ok = false; }
    if (!ok) errors.push(`--watch-url must be an http(s) URL, got '${v['watch-url']}'`);
  }
  return errors;
}

/**
 * Run cleanup steps last-registered first. Each step runs in its own try/catch,
 * so one failure (a scope that will not stop) never skips the rest (the fixture,
 * the profile dir). Returns the failures as strings.
 */
export async function runCleanup(steps) {
  const failures = [];
  for (const { name, fn } of [...steps].reverse()) {
    try { await fn(); } catch (err) { failures.push(`${name}: ${String(err?.message ?? err).slice(0, 200)}`); }
  }
  steps.length = 0;
  return failures;
}

/** Resolve `promise`, or `onTimeout()` after `ms`. */
export function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([promise.finally(() => clearTimeout(timer)), new Promise((r) => { timer = setTimeout(() => r(onTimeout()), ms); })]);
}

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
  const before = (ms, observed) => {
    if (!observed || firstDecisionMs === null) return null;
    if (ms === null || ms === undefined || ms >= firstDecisionMs) return false;
    return ms < firstDecisionMs - windowMs ? true : null;
  };
  const trackerReported = tracker?.reported === true;
  const facts = trackerReported ? tracker.facts : null;
  // Only requests at or after the file pick belong to this load; earlier ones are viewer startup.
  const loadRequests = watching ? timeline.filter((e) => e.event === 'request' && e.ms >= 0) : [];
  const startup = watching ? timeline.filter((e) => e.event === 'request' && e.ms < 0).map((e) => e.ms) : null;
  const firstAttemptMs = watching ? (loadRequests.map((e) => e.ms).sort((a, b) => a - b)[0] ?? null) : null;
  const unknown = {};
  /** Identity-dependent flag: null when the source was never marked, or when an unattributed
   *  event of at least the threshold size happened before the decision (it might be the source). */
  const identity = (name, ms, other, otherWhat) => {
    const v = before(ms, trackerReported);
    if (v === null || v === true) return v;
    if (!tracker.sourceMarked) { unknown[name] = 'the picked file was never marked (no file-input change event)'; return null; }
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
    attempts: watching ? loadRequests.length : null,
    failures: watching ? timeline.filter((e) => e.event === 'requestfailed' && e.ms >= 0).length : null,
    startupRequests: watching ? { count: startup.length, ms: startup } : null,
    firstAttemptMs,
    firstDecisionMs,
    decisionWindowMs: decision ? windowMs : null,
    attemptBeforeDecision: before(firstAttemptMs, watching),
    // From the tracker's kept facts (uncapped), never from its possibly truncated event log.
    readBeforeDecision: identity('readBeforeDecision', facts?.firstLargeSourceRead?.ms ?? null, facts?.firstUnattributedRead, 'an unattributed read'),
    unattributedReadBeforeDecision: before(facts?.firstUnattributedRead?.ms ?? null, trackerReported),
    sourcePostBeforeDecision: identity('sourcePostBeforeDecision', facts?.firstSourcePost?.ms ?? null, facts?.firstOtherPost, 'a worker post of another Blob'),
    logTruncated: trackerReported ? tracker.truncated : null,
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
