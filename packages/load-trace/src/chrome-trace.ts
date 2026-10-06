/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LoadTraceSnapshot, TraceAttrValue, TraceSpan } from './types.js';

/** One event of the Chrome Trace Event format (chrome://tracing, Perfetto, DevTools). */
export interface ChromeTraceEvent {
  name: string;
  cat: string;
  ph: 'X' | 'M';
  pid: number;
  tid: number;
  ts?: number;
  dur?: number;
  args?: Record<string, TraceAttrValue>;
}

export interface ChromeTrace {
  traceEvents: ChromeTraceEvent[];
  displayTimeUnit: 'ms';
}

/**
 * Render loads as Chrome-trace JSON: one process per load, one thread track per
 * recording thread (`main`, `geom-0`, ...), complete (`X`) events in µs on the
 * main thread's clock. Open spans are omitted.
 */
export function toChromeTrace(snapshots: readonly LoadTraceSnapshot[]): ChromeTrace {
  const traceEvents: ChromeTraceEvent[] = [];
  snapshots.forEach((load, index) => {
    const pid = index + 1;
    const tids = new Map<string, number>([['main', 0]]);
    const tid = (thread: string): number => {
      let t = tids.get(thread);
      if (t === undefined) { t = tids.size; tids.set(thread, t); }
      return t;
    };
    const attrs: Record<string, TraceAttrValue> = { loadId: load.loadId };
    for (const [k, v] of Object.entries(load.attrs)) if (v !== undefined) attrs[k] = v;
    traceEvents.push({ name: 'process_name', cat: '__metadata', ph: 'M', pid, tid: 0, args: { name: `load ${load.loadId}` } });
    if (load.end !== null) {
      traceEvents.push(complete('load', pid, 0, load.start, load.end, attrs));
    }
    for (const span of load.spans) {
      if (span.end === null) continue;
      traceEvents.push(complete(span.name, pid, tid(span.thread), span.start, span.end, spanArgs(span)));
    }
    for (const [thread, t] of tids) {
      traceEvents.push({ name: 'thread_name', cat: '__metadata', ph: 'M', pid, tid: t, args: { name: thread } });
    }
  });
  return { traceEvents, displayTimeUnit: 'ms' };
}

function complete(
  name: string, pid: number, tid: number, start: number, end: number, args?: Record<string, TraceAttrValue>,
): ChromeTraceEvent {
  return {
    name, cat: 'ifc-load', ph: 'X', pid, tid,
    ts: Math.round(start * 1000), dur: Math.max(0, Math.round((end - start) * 1000)),
    ...(args ? { args } : {}),
  };
}

function spanArgs(span: TraceSpan): Record<string, TraceAttrValue> | undefined {
  if (!span.attrs && !span.milestone) return undefined;
  return { ...span.attrs, ...(span.milestone ? { milestone: true } : {}) };
}
