/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { perfCounters, type PerfCounterRegistry } from './counters.js';
import type { LoadTrace } from './load-trace.js';
import type { TraceAttrs, WorkerSpan, WorkerTracePayload } from './types.js';

/** Main -> worker: start recording, labelling spans with `thread`. */
export const TRACE_ENABLE_MESSAGE = 'load-trace:enable';
/** Worker -> main: finished spans, see `WorkerTracePayload`. */
export const TRACE_SPANS_MESSAGE = 'load-trace:spans';

export interface TraceEnableMessage { type: typeof TRACE_ENABLE_MESSAGE; thread: string }
export interface TraceSpansMessage { type: typeof TRACE_SPANS_MESSAGE; payload: WorkerTracePayload }

export interface WorkerSpanRecorder {
  readonly thread: string;
  begin(name: string, attrs?: TraceAttrs): number;
  end(token: number, attrs?: TraceAttrs): void;
  /** Finished spans since the last drain, or `null` when there are none. */
  drain(): WorkerTracePayload | null;
}

/**
 * Records spans on the worker's own clock. `timeOrigin` travels with every
 * drained payload so the main thread can shift the spans onto its clock: a
 * worker's `performance.now()` is relative to the WORKER's creation time.
 */
export function createWorkerSpanRecorder(
  thread: string,
  now: () => number = () => performance.now(),
  timeOrigin: number = performance.timeOrigin,
): WorkerSpanRecorder {
  const open = new Map<number, WorkerSpan>();
  let done: WorkerSpan[] = [];
  let next = 0;
  return {
    thread,
    begin(name, attrs) {
      const token = next++;
      open.set(token, { name, start: now(), end: Number.NaN, ...(attrs ? { attrs: { ...attrs } } : {}) });
      return token;
    },
    end(token, attrs) {
      const span = open.get(token);
      if (!span) return;
      open.delete(token);
      span.end = now();
      if (attrs) span.attrs = { ...span.attrs, ...attrs };
      done.push(span);
    },
    drain() {
      if (done.length === 0) return null;
      const spans = done;
      done = [];
      return { thread, timeOrigin, spans };
    },
  };
}

export interface WorkerTraceHostOptions {
  /** Request message `type` -> span name. Unlisted types are never traced. */
  spanNames: Readonly<Record<string, string>>;
  /** Types traced only on their first occurrence (e.g. the first geometry chunk). */
  onceTypes?: readonly string[];
  post: (message: TraceSpansMessage) => void;
  now?: () => number;
  timeOrigin?: number;
  /**
   * This worker's counter registry (#6957), switched on with tracing. Its
   * increments ride back with the spans after every handler, so per-chunk
   * work (wasm copies, ...) reaches the load even for untraced message types.
   */
  counters?: PerfCounterRegistry;
}

/**
 * Wrap a worker's message dispatch. Until the main thread sends
 * `TRACE_ENABLE_MESSAGE` the wrapper is one null check and a direct call, so
 * an untraced load pays nothing measurable. Once enabled, each listed message
 * type becomes one span, posted back as soon as its handler settles, and any
 * handler that moved a counter posts those increments (#6957).
 */
/**
 * The wrapped dispatch, plus `flush()`: post what is pending NOW. A worker the
 * main thread terminates on a message it is about to send (the pre-pass
 * worker on its final event) calls it first, or the counters die with it.
 */
export type WorkerTraceHost = ((data: unknown, run: () => Promise<void>) => Promise<void>) & { flush(): void };

export function createWorkerTraceHost(options: WorkerTraceHostOptions): WorkerTraceHost {
  let recorder: WorkerSpanRecorder | null = null;
  const seenOnce = new Set<string>();
  const once = new Set(options.onceTypes ?? []);
  const counters = options.counters ?? perfCounters;
  const flush = (rec: WorkerSpanRecorder) => {
    const payload = rec.drain();
    const moved = counters.drain();
    if (!payload && !moved) return;
    const out = payload ?? { thread: rec.thread, timeOrigin: options.timeOrigin ?? performance.timeOrigin, spans: [] };
    options.post({ type: TRACE_SPANS_MESSAGE, payload: moved ? { ...out, counters: moved } : out });
  };
  const host = async (data: unknown, run: () => Promise<void>): Promise<void> => {
    const type = (data as { type?: unknown } | null)?.type;
    if (type === TRACE_ENABLE_MESSAGE) {
      const thread = (data as { thread?: unknown }).thread;
      recorder = createWorkerSpanRecorder(typeof thread === 'string' ? thread : 'worker', options.now, options.timeOrigin);
      seenOnce.clear(); // a pooled worker (#7036) serves several loads: each gets its first-chunk span
      counters.enable();
      counters.drain(); // only what happens from here on belongs to a load
      return;
    }
    const rec = recorder;
    if (!rec) return run();
    const name = typeof type === 'string' ? options.spanNames[type] : undefined;
    const traced = name !== undefined && !(once.has(type as string) && seenOnce.has(type as string));
    if (traced && once.has(type as string)) seenOnce.add(type as string);
    const token = traced ? rec.begin(name) : -1;
    try {
      await run();
    } finally {
      if (traced) rec.end(token);
      flush(rec);
    }
  };
  return Object.assign(host, { flush: () => { if (recorder) flush(recorder); } });
}

/** Ask `worker` to record spans for `trace` (no-op when tracing is off). Returns `worker`. */
export function enableWorkerTrace<W extends { postMessage(message: unknown): void }>(
  worker: W, trace: LoadTrace, thread: string,
): W {
  if (trace.enabled) worker.postMessage({ type: TRACE_ENABLE_MESSAGE, thread } satisfies TraceEnableMessage);
  return worker;
}

export function isTraceSpansMessage(message: unknown): message is TraceSpansMessage {
  return (message as { type?: unknown } | null)?.type === TRACE_SPANS_MESSAGE;
}
