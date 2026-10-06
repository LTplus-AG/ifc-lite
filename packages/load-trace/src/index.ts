/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {
  createLoadTracer,
  NOOP_LOAD_TRACE,
  type LoadTrace,
  type LoadTracer,
  type LoadTracerOptions,
} from './load-trace.js';

export type { PerfSink } from './perf-sink.js';

export {
  createWorkerTraceHost,
  enableWorkerTrace,
  isTraceSpansMessage,
  type TraceSpansMessage,
  type WorkerTraceHostOptions,
} from './worker.js';

export { toChromeTrace, type ChromeTrace, type ChromeTraceEvent } from './chrome-trace.js';
export { buildSpanTree, type SpanTreeNode } from './tree.js';

export type {
  LoadTraceAttributes,
  LoadTraceSnapshot,
  TraceAttrs,
  TraceAttrValue,
  TraceSpan,
  WorkerSpan,
  WorkerTracePayload,
} from './types.js';
