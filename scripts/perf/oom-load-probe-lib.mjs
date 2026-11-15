/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure parts of `oom-load-probe.mjs` (#10264): turning what one capped load
 * observed into an outcome, and deciding whether that outcome is the expected
 * one. Kept free of browser and cgroup access so the verdict logic is tested.
 *
 * Outcomes:
 *   loaded   the viewer reached full interactivity.
 *   refused  the viewer showed a memory message and the tab survived: main's
 *            own out-of-memory explanation (apps/viewer/src/lib/load-error-message.ts)
 *            or a pre-read memory-budget refusal (e.g. "exceeds this tab's
 *            local processing memory budget").
 *   killed   a Chrome process was OOM-killed inside the cap, the renderer
 *            crashed, or the browser disconnected.
 *   error    a load error that is not about memory (a real bug of another kind).
 *   timeout  none of the above within the time limit.
 *
 * An OOM kill wins over everything else: if the cgroup recorded one, the run
 * is `killed` even when the page later recovered, so a kill can never be
 * reported as a pass.
 */

export const OUTCOMES = Object.freeze(['loaded', 'refused', 'killed', 'error', 'timeout']);

/** Memory messages the viewer shows instead of dying (main's OOM text and pre-read refusals). */
export const MEMORY_MESSAGE = /local processing memory budget|ran out of memory|out of memory|too large for this device|memory budget/i;

/**
 * @param {object} o
 * @param {number} [o.oomKills]       memory.events oom_kill of the cap's cgroup.
 * @param {boolean} [o.pageCrashed]   Playwright page 'crash'.
 * @param {boolean} [o.browserGone]   Playwright browser/context 'close' or 'disconnected' before the verdict.
 * @param {boolean} [o.interactive]   openAndWaitInteractive resolved.
 * @param {string|null} [o.storeError] the viewer store's `error`.
 * @param {string} [o.pageText]       visible page text at the end (toasts, dialogs).
 * @param {boolean} [o.timedOut]
 * @returns {{ outcome: string, reason: string }}
 */
export function classify(o) {
  if ((o.oomKills ?? 0) > 0) return { outcome: 'killed', reason: `cgroup oom_kill=${o.oomKills}` };
  if (o.pageCrashed) return { outcome: 'killed', reason: 'renderer crashed' };
  if (o.browserGone) return { outcome: 'killed', reason: 'browser process exited' };
  const message = [o.storeError, o.pageText].filter(Boolean).join('\n');
  if (MEMORY_MESSAGE.test(message)) {
    const line = message.split('\n').find((l) => MEMORY_MESSAGE.test(l)) ?? '';
    return { outcome: 'refused', reason: line.trim().slice(0, 300) };
  }
  if (o.interactive) return { outcome: 'loaded', reason: 'interactive' };
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
  'not-killed': ['loaded', 'refused'],
  loaded: ['loaded'],
  refused: ['refused'],
});

/**
 * @returns {{ pass: boolean, message: string }} `error` and `timeout` never pass.
 */
export function verdict(outcome, expect) {
  const accepted = EXPECTATIONS[expect];
  if (!accepted) throw new Error(`--expect must be one of ${Object.keys(EXPECTATIONS).join(', ')}`);
  if (accepted.includes(outcome)) {
    return { pass: true, message: expect === 'killed'
      ? 'PASS (known issue #10264 still reproduces: the tab was killed)'
      : `PASS (${outcome})` };
  }
  if (expect === 'killed' && (outcome === 'loaded' || outcome === 'refused')) {
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
  if ((sample.tris ?? 0) > 0) return 'geometry-streaming';
  if (sample.progress?.phase) return `pre-geometry (${sample.progress.phase})`;
  return sample.loading ? 'pre-geometry' : 'before-open';
}
