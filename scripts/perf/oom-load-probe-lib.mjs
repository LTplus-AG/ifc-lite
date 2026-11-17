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


/**
 * Outcome precedence: one table, applied top to bottom, first match wins. Every adjacent pair
 * has a unit test (oom-load-probe-lib.test.mjs, "precedence:"), so a reorder cannot go unnoticed.
 *
 *  #  outcome                        when                                                  why it outranks the rows below
 *  1  killed / killed-after-continue positive evidence about THIS tab: the page reported a   a dead tab is the defect under test; nothing a
 *                                    renderer crash (Playwright 'crash', raised when this   dead page showed can override it. Process TYPES
 *                                    page's renderer dies), the page target closed, or     never decide this row: an unrelated renderer or a
 *                                    the browser exited                                    GPU process vanishing is not this tab (review #10415)
 *  -  (invariant)                    an alive, positively interactive tab is never killed, whatever the kill accounting says;
 *                                    classify() asserts it (TAB_ALIVE_INVARIANT)
 *  2  error                          any OOM kill whose victim was not identified in its   cannot be called killed or alive: never a pass,
 *                                    own sample interval (per event), with the page alive   even when the page is interactive (review #10415)
 *  3  loaded                         the load reached full interactivity (positively       a finished model beats any text elsewhere on
 *                                    observed); OOM kills of other processes and ambiguous  the page, including a stale or later error
 *                                    victims (more vanished processes than kills) are noted
 *  4  refused                        the explicit pre-read refusal text (store load        the refusal IS a load error; it must be read
 *                                    error or a dialog/notice)                             before the generic error row
 *  5  error                          any other load error (store error or a model in       a failed load is never a pass, even with a
 *                                    error), incl. "Ran out of memory while processing"     memory warning still on screen (review #10415)
 *  6  cancelled                      the warning was shown and the probe clicked Cancel    a decision was made; outranks "waiting"
 *  7  awaiting-decision              the warning was shown, no decision, load not started  the viewer is waiting for the user, not stuck
 *  8  timeout                        the time limit passed with none of the above          no verdict reached in time
 *  9  error                          nothing at all was observed                           never a pass
 */
const TAB_DEATH = (o) => [o.pageCrashed && 'page crashed (its renderer died)', o.pageClosed && 'page target closed', o.browserGone && 'browser exited'].filter(Boolean);
const tabAlive = (o) => TAB_DEATH(o).length === 0;
const texts = (o) => [o.storeError, ...(o.otherErrors ?? []), ...(o.notices ?? [])].filter(Boolean).map(String);

/** What a poll records when a model is in error before the store has its message. */
export const GENERIC_MODEL_ERROR = 'model load error';
export const PRECEDENCE = Object.freeze([
  { outcome: 'killed', when: (o) => !tabAlive(o),
    reason: (o, k) => `${TAB_DEATH(o).join(', ')}${k.kills ? ` (cgroup oom_kill=${k.kills}${k.types.length ? `; vanished: ${k.types.join('+')}` : ''})` : ''}` },
  { outcome: 'error', when: (o, k) => k.unidentified > 0,
    reason: (o, k) => `cgroup oom_kill=${k.kills} with ${k.unidentified} kill(s) whose victim was not identified${k.types.length ? ` (identified: ${k.types.join('+')})` : ''}; the page stayed alive` },
  { outcome: 'loaded', when: (o) => Boolean(o.interactive), reason: () => 'interactive' },
  { outcome: 'refused', when: (o) => texts(o).some((t) => REFUSAL_MESSAGE.test(t)),
    reason: (o) => texts(o).find((t) => REFUSAL_MESSAGE.test(t)).trim().slice(0, 300) },
  { outcome: 'error', when: (o) => Boolean(o.storeError),
    reason: (o) => (OOM_FAILURE_MESSAGE.test(String(o.storeError)) ? `out of memory during processing: ${String(o.storeError).trim().slice(0, 260)}` : String(o.storeError).slice(0, 300)) },
  { outcome: 'error', when: (o) => texts(o).some((t) => OOM_FAILURE_MESSAGE.test(t)),
    reason: (o) => `out of memory during processing: ${texts(o).find((t) => OOM_FAILURE_MESSAGE.test(t)).trim().slice(0, 260)}` },
  { outcome: 'cancelled', when: (o) => o.warningShown && o.decision === 'cancel', reason: () => 'memory warning, probe clicked Cancel' },
  { outcome: 'awaiting-decision', when: (o) => o.warningShown && (o.decision ?? 'none') === 'none', reason: () => 'memory warning shown, load not started' },
  { outcome: 'timeout', when: (o) => Boolean(o.timedOut), reason: () => 'time limit' },
  { outcome: 'error', when: () => true, reason: () => 'no verdict observed' },
]);

/**
 * @param {object} o
 * @param {number} [o.oomKills]        memory.events oom_kill of the cap's cgroup.
 * @param {string[]} [o.killedTypes]   Chrome process types that vanished at an OOM kill; empty if unknown.
 * @param {{added: number, types: string[]}[]} [o.killEvents] per increase of oom_kill: kills added, types vanished.
 * @param {boolean} [o.pageCrashed]    Playwright page 'crash'.
 * @param {boolean} [o.browserGone]    Playwright context 'close' before the verdict.
 * @param {boolean} [o.pageClosed]     the page under test closed (its target is gone) before the verdict.
 * @param {boolean} [o.interactive]    openAndWaitInteractive resolved.
 * @param {string|null} [o.storeError] the viewer store's load error (or GENERIC_MODEL_ERROR).
 * @param {string[]} [o.otherErrors]   later, different load errors kept beside storeError.
 * @param {string[]} [o.notices]       text of dialogs, alerts and toasts at the end (not the whole page).
 * @param {boolean} [o.timedOut]
 * @param {boolean} [o.warningShown]   a MEMORY_WARNING dialog appeared.
 * @param {'none'|'continue'|'cancel'} [o.decision] what the probe clicked on it.
 * @returns {{ outcome: string, reason: string, rule: number }}
 */
export function classify(o) {
  // Per-event accounting when the sampler recorded events; otherwise (callers without events)
  // the aggregate form, which is equivalent when every kill came from one interval.
  const k = o.killEvents
    ? oomAccounting(o.killEvents, o.oomKills ?? 0)
    : { kills: o.oomKills ?? 0, types: o.killedTypes ?? [], unidentified: Math.max(0, (o.oomKills ?? 0) - (o.killedTypes ?? []).length), ambiguous: 0 };
  const index = PRECEDENCE.findIndex((r) => r.when(o, k));
  const rule = PRECEDENCE[index];
  let outcome = rule.outcome;
  if (outcome === 'killed' && o.decision === 'continue') outcome = 'killed-after-continue';
  let reason = rule.reason(o, k);
  // Rows 3+ are a live tab: note OOM kills of other processes, and ambiguous victims.
  if (index >= 2 && k.kills > 0) {
    reason += `; note: cgroup OOM-killed ${k.types.join('+')} (not the tab)`;
    if (k.ambiguous) reason += `; ${k.ambiguous} interval(s) with more vanished processes than kills (victim ambiguous)`;
  }
  // TAB_ALIVE_INVARIANT: an alive, positively interactive tab is never killed.
  if ((outcome === 'killed' || outcome === 'killed-after-continue') && o.interactive && tabAlive(o)) {
    throw new Error('TAB_ALIVE_INVARIANT violated: an alive, interactive tab was classified killed');
  }
  return { outcome, reason, rule: index + 1 };
}

/**
 * Fold one final page snapshot into the observations, so classification never depends on
 * which promise (the interactive wait, a rejection, the 2 s poll) settled first.
 * `snap` is `{ error, modelStates, warningVisible, warningText, notices }` read from the page
 * after the wait ended on any path; `null` when the page is gone (crash or browser exit,
 * which the kill evidence covers).
 */
export function mergeFinalSnapshot(obs, snap) {
  if (!snap) return obs;
  const out = { ...obs };
  if (snap.error || snap.modelStates?.includes('error')) {
    const later = snap.error ?? GENERIC_MODEL_ERROR;
    if (!out.storeError || out.storeError === GENERIC_MODEL_ERROR) out.storeError = later; // a specific message replaces the placeholder
    else if (later !== GENERIC_MODEL_ERROR && later !== out.storeError) out.otherErrors = [...(out.otherErrors ?? []), later]; // keep both; the table decides
  }
  if (snap.warningVisible && !out.warningShown) out.warningShown = true;
  if (Array.isArray(snap.notices)) out.notices = snap.notices;
  return out;
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
  // The fallback runs inside the promise: a throw (or a rejected fallback promise) rejects this
  // promise, so a caller such as runCleanup records it instead of an uncaught timer exception.
  const fallback = new Promise((resolve, reject) => {
    timer = setTimeout(() => { Promise.resolve().then(onTimeout).then(resolve, reject); }, ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), fallback]);
}

/**
 * Per-event OOM accounting: `events` are `{ added, types }`, one per increase of the cgroup's
 * oom_kill counter, with the Chrome process types that vanished in that interval. A kill counts
 * as identified only within its own interval, so an extra vanished process in one interval can
 * never stand in for a missing victim in another. Kills the sampler never saw as an event
 * (`totalKills` above the events' sum) are unidentified.
 */
export function oomAccounting(events, totalKills = 0) {
  const types = events.flatMap((e) => e.types);
  let unidentified = events.reduce((n, e) => n + Math.max(0, e.added - e.types.length), 0);
  // More vanished processes than kills in one interval: which one was the victim is ambiguous.
  const ambiguous = events.filter((e) => e.types.length > e.added).length;
  const seen = events.reduce((n, e) => n + e.added, 0);
  if (totalKills > seen) unidentified += totalKills - seen;
  return { kills: Math.max(totalKills, seen), types, unidentified, ambiguous };
}

