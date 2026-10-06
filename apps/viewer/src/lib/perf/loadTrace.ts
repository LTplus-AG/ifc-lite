/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's load tracer (#6956, perf charter #6954).
 *
 * Off by default. `?perfTrace=1` (or `globalThis.__IFC_LITE_PERF_TRACE = 1`
 * set before boot, which is how the Playwright benchmark enables it) turns it
 * on and publishes `window.__IFC_LITE_LOAD_TRACE__`:
 *
 *   loads()                every retained load's span tree (JSON-safe), with
 *                          its structural counters and long-frame summary (#6957)
 *   latest()               the most recent load, or null
 *   tree()                 the latest load nested by parent span
 *   chromeTrace()          Chrome-trace JSON for DevTools / Perfetto
 *   downloadChromeTrace()  save that JSON as a file
 *
 * With tracing off every instrumented call site is a no-op method call.
 */

import { NOOP_LOAD_TRACE, type LoadTrace, type LoadTracer } from '@ifc-lite/load-trace';
import { isPerfTraceRequested, PERF_TRACE_ENABLED } from './perfTraceFlag.js';

export { isPerfTraceRequested };

/**
 * Resolve on the next animation frame, or after `fallbackMs` when rAF stalls
 * (hidden tab, host without rAF), and say which. Both load paths use it to
 * record `geometry.firstVisible` without losing it to a stalled frame.
 */
export function nextPaintOrTimeout(fallbackMs = 250): Promise<'paint' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => resolve('timeout'), fallbackMs);
    globalThis.requestAnimationFrame?.(() => {
      globalThis.clearTimeout(timer);
      resolve('paint');
    });
  });
}

/**
 * Record `geometry.firstVisible` on the next paint, or at `appendedAt` (the
 * first append) when rAF stalls. Await the result before the load closes.
 */
export function recordFirstVisible(trace: Pick<LoadTrace, 'milestone'>, appendedAt: number, fallbackMs = 250): Promise<void> {
  return nextPaintOrTimeout(fallbackMs).then((how) => {
    trace.milestone('geometry.firstVisible', how === 'paint' ? undefined : appendedAt);
  });
}

const DISABLED_TRACER: LoadTracer = {
  enabled: false,
  startLoad: () => NOOP_LOAD_TRACE,
  snapshots: () => [],
  latest: () => null,
};

/**
 * The viewer's shared tracer: a no-op until tracing is requested. The real
 * tracer, its span tree and the Chrome-trace export live in
 * `loadTraceEnabled.ts`, imported on demand, so a default boot ships none of
 * it in the entry chunk. Loads start long after boot, so `?perfTrace=1` (or
 * the benchmark's pre-boot flag) still captures every load.
 */
export let loadTracer: LoadTracer = DISABLED_TRACER;
if (PERF_TRACE_ENABLED) {
  void import('./loadTraceEnabled.js')
    .then((mod) => { loadTracer = mod.enableLoadTracing(); })
    .catch((error: unknown) => console.warn('[perf] load tracing could not be enabled', error));
}
