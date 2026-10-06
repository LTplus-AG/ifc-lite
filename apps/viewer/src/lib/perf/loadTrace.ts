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
 *   loads()                every retained load's span tree (JSON-safe)
 *   latest()               the most recent load, or null
 *   tree()                 the latest load nested by parent span
 *   chromeTrace()          Chrome-trace JSON for DevTools / Perfetto
 *   downloadChromeTrace()  save that JSON as a file
 *
 * With tracing off every instrumented call site is a no-op method call.
 */

import { buildSpanTree, createLoadTracer, toChromeTrace, type LoadTracer } from '@ifc-lite/load-trace';
import { downloadBlob } from '../export/download.js';
import { readPerfFlag } from './flags.js';

const GLOBAL_KEY = '__IFC_LITE_LOAD_TRACE__';

export function isPerfTraceRequested(
  search: string = globalThis.location?.search ?? '',
  flag: unknown = readPerfFlag('perfTrace'),
): boolean {
  if (flag === 1 || flag === true || flag === '1') return true;
  return new URLSearchParams(search).get('perfTrace') === '1';
}

export function exposeLoadTrace(tracer: LoadTracer, target: Record<string, unknown> = globalThis as Record<string, unknown>): void {
  target[GLOBAL_KEY] = {
    loads: () => tracer.snapshots(),
    latest: () => tracer.latest(),
    tree: () => {
      const latest = tracer.latest();
      return latest ? buildSpanTree(latest) : [];
    },
    chromeTrace: () => toChromeTrace(tracer.snapshots()),
    downloadChromeTrace: () => {
      const json = JSON.stringify(toChromeTrace(tracer.snapshots()));
      downloadBlob(new Blob([json], { type: 'application/json' }), `ifc-lite-load-trace-${Date.now()}.json`);
    },
  };
}

export const loadTracer: LoadTracer = createLoadTracer({ enabled: isPerfTraceRequested() });
if (loadTracer.enabled) exposeLoadTrace(loadTracer);
