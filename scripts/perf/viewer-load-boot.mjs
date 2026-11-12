/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boot and main-thread quiescence for `load-scoreboard.mjs` timing samples.
 *
 * - The boot tail (welcome WebGL scene, WebGL capability probe, WebGPU renderer
 *   init, wasm prewarm) runs long tasks after the file input exists. Arming
 *   the load clock inside it queued the input event behind 1-3 s of boot work
 *   in about 10% of opens. `waitShellQuiet` arms only once no long task has run
 *   for `quietMs`, and reports boot (time to a quiet shell) as its own metric.
 * - `?perfTrace=1` switches the realm-wide perf counters on, and with them a
 *   walk of every worker message payload on the main thread (about 0.5 s on a
 *   Holter cold load). Timing samples pre-install a disabled registry, so spans
 *   (which readiness needs) stay on and the main-thread byte accounting stays
 *   off. Workers enable their own counters on the trace-enable message; that
 *   sender-side cost stays (off the main thread).
 * - `waitUiQuiet` reports when the main thread first stays free of long tasks
 *   for `quietMs` after readiness, so UI work deferred past the settle event is
 *   still visible to the scoreboard.
 */

import { UI_QUIET_CAP_MS } from './load-scoreboard-stats.mjs';

/** Init script (arg: { countersOff }): record long tasks from boot; optionally disable perf counters. */
export function BOOT_OBSERVERS({ countersOff }) {
  globalThis.__benchLongTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) globalThis.__benchLongTasks.push([e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* no longtask support: quiescence then waits on the renderer only */ }
  // App-shell ready: the moment the store and the file input both exist, stamped in page (not when a poll notices).
  const stampShell = () => {
    if (globalThis.__benchShellAt === undefined && globalThis.__ifc_lite_viewer_store__ && document.getElementById('file-input-open')) {
      globalThis.__benchShellAt = performance.now();
    }
    return globalThis.__benchShellAt !== undefined;
  };
  const watchShell = () => {
    if (stampShell()) return;
    const mo = new MutationObserver(() => { if (stampShell()) mo.disconnect(); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) watchShell(); else document.addEventListener('DOMContentLoaded', watchShell, { once: true });
  if (countersOff) {
    const key = Symbol.for('ifc-lite.perf-counters');
    globalThis[key] = { get enabled() { return false; }, enable() {}, add() {}, read: () => ({}), drain: () => null };
    globalThis.__benchCountersOff = true;
  }
}

function shellState() {
  const tasks = globalThis.__benchLongTasks ?? [];
  const lastEnd = tasks.reduce((m, [s, d]) => Math.max(m, s + d), 0);
  return { now: performance.now(), lastLongTaskEnd: lastEnd, longTaskMs: tasks.reduce((a, [, d]) => a + d, 0), longTasks: tasks.length,
    rendererReady: Boolean(globalThis.__ifc_lite_render_stats__?.()?.adapter), countersOff: Boolean(globalThis.__benchCountersOff) };
}

/**
 * Wait until no long task ran for `quietMs`. Page clock = ms since navigation start.
 * The viewport's renderer (and its debug hooks) mounts with the first load, so
 * renderer readiness is recorded, not required.
 */
export async function waitShellQuiet(page, { quietMs = 1000, timeoutMs = 15000 } = {}) {
  const started = Date.now();
  let s = await page.evaluate(shellState);
  const firstReady = s.now;
  while (!(s.now - s.lastLongTaskEnd >= quietMs) && Date.now() - started < timeoutMs) {
    await page.waitForTimeout(100);
    s = await page.evaluate(shellState);
  }
  return { shellQuietMs: s.now, armAbs: s.now, quietWaitMs: s.now - firstReady, rendererReady: s.rendererReady, timedOut: !(s.now - s.lastLongTaskEnd >= quietMs),
    bootLongTaskMs: s.longTaskMs, bootLongTasks: s.longTasks, countersOff: s.countersOff };
}

/**
 * The quiet the arm really had, read after the open from every long-task entry
 * (entries arrive asynchronously, so a poll can arm before a block that just
 * ended is reported). `quietAtArmMs` = page-clock ms from the end of the last long
 * task that ended at or before the arm to the arm (null: no long task before it);
 * `armInsideLongTask` = the arm fell inside a long task; `armedEarly` = less than
 * `quietMs` of real quiet. Measurement only: it never changes the arm.
 */
export function quietAtArm(tasks, armAbs, quietMs = 1000) {
  if (!Number.isFinite(armAbs)) return { quietAtArmMs: null, armInsideLongTask: null, armedEarly: null };
  let lastEnd = null, inside = false;
  for (const [start, dur] of tasks ?? []) {
    const end = start + dur;
    if (end <= armAbs) lastEnd = lastEnd === null ? end : Math.max(lastEnd, end);
    else if (start < armAbs) inside = true;
  }
  const quiet = lastEnd === null ? null : armAbs - lastEnd;
  return { quietAtArmMs: quiet, armInsideLongTask: inside, armedEarly: inside || (quiet !== null && quiet < quietMs) };
}

/**
 * After readiness: the end of the last long task before the main thread first
 * stays quiet for `quietMs`, as ms after `originAbs` (page clock). Capped by `timeoutMs`.
 */
export async function waitUiQuiet(page, readyAbs, originAbs, { quietMs = 500, timeoutMs = UI_QUIET_CAP_MS } = {}) {
  const started = Date.now();
  for (;;) {
    const s = await page.evaluate(() => ({ now: performance.now(), tasks: globalThis.__benchLongTasks ?? [] }));
    const after = s.tasks.filter(([start, dur]) => start + dur > readyAbs);
    const lastEnd = Math.max(readyAbs, ...after.map(([start, dur]) => start + dur));
    const timedOut = Date.now() - started >= timeoutMs;
    if (s.now - lastEnd >= quietMs || timedOut) {
      return { uiQuietMs: lastEnd - originAbs, longTasksAfterReady: after.length, longTaskMsAfterReady: after.reduce((a, [, d]) => a + d, 0), uiQuietTimedOut: timedOut && s.now - lastEnd < quietMs };
    }
    await page.waitForTimeout(100);
  }
}
