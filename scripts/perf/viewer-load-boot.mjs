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
  return { shellQuietMs: s.now, quietWaitMs: s.now - firstReady, rendererReady: s.rendererReady, timedOut: !(s.now - s.lastLongTaskEnd >= quietMs),
    bootLongTaskMs: s.longTaskMs, bootLongTasks: s.longTasks, countersOff: s.countersOff };
}

/**
 * In page: the viewer's boot signal, read strictly. `__ifc_lite_boot_settled__`
 * must be a synchronous function returning exactly `true` or `false`; anything
 * else (a Promise, a string, 1) is reported by type, never coerced to settled.
 */
export function readBootSignal() {
  const f = globalThis.__ifc_lite_boot_settled__;
  if (typeof f !== 'function') return { kind: 'absent' };
  const v = f();
  if (v === true || v === false) return { kind: 'boolean', value: v };
  return { kind: 'invalid', type: v instanceof Promise ? 'Promise' : v === null ? 'null' : typeof v };
}

function signalError(signal) {
  return new Error(`boot-settled arm: __ifc_lite_boot_settled__() returned ${signal.type}, not a boolean (unverifiable)`);
}

/**
 * `boot-settled` arm (the `-settled` lanes): wait until the viewer reports its idle
 * boot work finished (`__ifc_lite_boot_settled__() === true`, e.g. a warm-up before
 * the first file), bounded by `timeoutMs`. A missing input never reads as success:
 * a page without the hook fails the sample unless its side declares
 * `bootSignal: false` (a build with no idle boot work), a declared-absent side
 * that does expose it fails too, a non-boolean answer fails, and a wait that
 * never settles is unverifiable. The default arm never calls this.
 */
export async function waitBootSettled(page, { expectSignal = true, timeoutMs = 20000 } = {}) {
  const started = Date.now();
  for (;;) {
    const signal = await page.evaluate(readBootSignal);
    if (signal.kind === 'absent') {
      if (expectSignal) throw new Error('boot-settled arm: the page exposes no __ifc_lite_boot_settled__(); declare `bootSignal: false` on a side whose build has no idle boot work');
      return { bootSettled: 'no signal (declared)', bootSettledWaitMs: 0 };
    }
    if (!expectSignal) throw new Error('boot-settled arm: the side declares `bootSignal: false`, but the page exposes __ifc_lite_boot_settled__()');
    if (signal.kind === 'invalid') throw signalError(signal);
    if (signal.value) return { bootSettled: true, bootSettledWaitMs: Date.now() - started };
    if (Date.now() - started >= timeoutMs) throw new Error(`boot-settled arm: idle boot work did not settle within ${timeoutMs} ms (unverifiable)`);
    await page.waitForTimeout(100);
  }
}

/**
 * The whole `boot-settled` arm: the signal, then the default quiet shell, then the
 * signal again, which must still be `true` at the arm (boot work that restarted
 * during the quiet wait fails the sample). The signal wait is outside the timed
 * interval: the clock starts at the change event, as in the default lanes.
 */
export async function armAfterBootSettled(page, { expectSignal = true, timeoutMs = 20000 } = {}) {
  const settled = await waitBootSettled(page, { expectSignal, timeoutMs });
  const quiet = await waitShellQuiet(page);
  let bootSettledAtArm = settled.bootSettled;
  if (expectSignal) {
    const signal = await page.evaluate(readBootSignal);
    if (signal.kind === 'invalid') throw signalError(signal);
    bootSettledAtArm = signal.kind === 'boolean' ? signal.value : 'absent';
    if (bootSettledAtArm !== true) throw new Error(`boot-settled arm: the signal was ${bootSettledAtArm} at the arm, after the quiet wait (boot work restarted)`);
  }
  return { ...quiet, ...settled, bootSettledAtArm };
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
