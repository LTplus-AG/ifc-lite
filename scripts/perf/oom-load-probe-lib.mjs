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
 *   refused  the viewer stopped an oversized load BEFORE local processing
 *            and the tab survived (REFUSAL_MESSAGE in the store's load error
 *            or a dialog/toast).
 *   awaiting-decision  the viewer showed a "may exceed available memory"
 *            warning (Continue loading / Cancel) and the load had not started;
 *            the probe was told to leave it there (--on-memory-dialog wait).
 *   cancelled the probe clicked Cancel on that warning (--on-memory-dialog cancel).
 *   killed   the renderer or browser was OOM-killed inside the cap or crashed,
 *            or any Chrome process was OOM-killed and the page did not finish,
 *            with no warning accepted.
 *   killed-after-continue  the same, after the probe clicked Continue loading
 *            (--on-memory-dialog continue): the user was warned. Reported on
 *            its own, never folded into a pass or into plain `killed`.
 *   error    any other load error, including main's after-the-fact
 *            "Ran out of memory while processing" once the load had started
 *            (the viewer failed, it did not refuse), and worker/runtime crash
 *            messages that leave the tab alive.
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
 * @param {boolean} [o.loadStarted]    geometry streamed or the source was read before the message.
 * @param {boolean} [o.timedOut]
 * @param {boolean} [o.warningShown]   a MEMORY_WARNING dialog appeared before the load started.
 * @param {'none'|'continue'|'cancel'} [o.decision] what the probe clicked on it.
 * @returns {{ outcome: string, reason: string }}
 */
export function classify(o) {
  const killed = o.decision === 'continue' ? 'killed-after-continue' : 'killed';
  const types = o.killedTypes ?? [];
  if ((o.oomKills ?? 0) > 0) {
    const which = types.length ? types.join('+') : 'unknown process';
    const tabDied = o.pageCrashed || o.browserGone || types.some((t) => TAB_PROCESSES.has(t));
    if (o.interactive && !tabDied && types.length) {
      return { outcome: 'loaded', reason: `interactive; note: cgroup OOM-killed ${which} (not the tab)` };
    }
    return { outcome: killed, reason: `cgroup oom_kill=${o.oomKills} (${which})` };
  }
  if (o.pageCrashed) return { outcome: killed, reason: 'renderer crashed' };
  if (o.browserGone) return { outcome: killed, reason: 'browser process exited' };
  if (o.interactive) return { outcome: 'loaded', reason: 'interactive' };
  if (o.warningShown && o.decision === 'cancel') return { outcome: 'cancelled', reason: 'memory warning, probe clicked Cancel' };
  if (o.warningShown && (o.decision ?? 'none') === 'none') return { outcome: 'awaiting-decision', reason: 'memory warning shown, load not started' };
  const texts = [o.storeError, ...(o.notices ?? [])].filter(Boolean).map(String);
  const refusal = texts.find((t) => REFUSAL_MESSAGE.test(t));
  if (refusal) return { outcome: 'refused', reason: refusal.trim().slice(0, 300) };
  const oom = texts.find((t) => OOM_FAILURE_MESSAGE.test(t));
  if (oom) {
    return o.loadStarted
      ? { outcome: 'error', reason: `out of memory after the load started: ${oom.trim().slice(0, 260)}` }
      : { outcome: 'refused', reason: oom.trim().slice(0, 300) };
  }
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
