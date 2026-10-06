/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The enabled half of the viewer's load tracer (#6956), loaded on demand by
 * `loadTrace.ts` only when tracing is requested, so it never weighs on the
 * default entry chunk. Publishes `window.__IFC_LITE_LOAD_TRACE__`.
 */

import { buildSpanTree, createLoadTracer, startFrameMonitor, toChromeTrace, type LoadTracer } from '@ifc-lite/load-trace';
import { downloadBlob } from '../export/download.js';

const GLOBAL_KEY = '__IFC_LITE_LOAD_TRACE__';

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

/** Create the recording tracer and publish its API on the global. */
export function enableLoadTracing(): LoadTracer {
  // #6957: each load also carries its structural counters and a long-frame
  // (LoAF / longtask) summary; see `LoadTraceSnapshot.counters` / `.mainThread`.
  const tracer = createLoadTracer({ enabled: true, frames: startFrameMonitor() });
  exposeLoadTrace(tracer);
  return tracer;
}
