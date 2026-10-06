/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TraceAttrs } from './types.js';
import {
  createWorkerSpanRecorder,
  TRACE_ENABLE_MESSAGE,
  TRACE_SPANS_MESSAGE,
  type TraceSpansMessage,
  type WorkerSpanRecorder,
} from './worker.js';

/**
 * Spans for the phases INSIDE one long worker handler (#6979), where
 * `createWorkerTraceHost`'s one-span-per-message is too coarse. The parser
 * worker runs a whole parse in a single `parse` message and the host
 * terminates it the moment `complete` arrives, so a span posted after the
 * handler settles would die with the worker: `flush()` posts what has
 * finished so far, and the worker calls it before any message after which it
 * may be terminated.
 *
 * Enabled by the same `enableWorkerTrace` request as the host. Until then
 * every method is a null check, so an untraced load pays nothing measurable.
 */
export interface WorkerPhaseTrace {
  readonly enabled: boolean;
  /** Feed each inbound message first; `true` = it was the enable request (consumed). */
  accept(data: unknown): boolean;
  /** Open a span; `-1` when disabled. */
  begin(name: string, attrs?: TraceAttrs): number;
  end(token: number, attrs?: TraceAttrs): void;
  /** Time `fn`; a returned promise ends the span when it settles. Returns `fn`'s result unchanged. */
  span<T>(name: string, fn: () => T, attrs?: TraceAttrs): T;
  /**
   * Sequential phases: end the previous `step` span and open `name` (or just
   * end it, for `null`). A repeated name keeps the open span, so a progress
   * callback that reports one phase many times can drive this directly.
   */
  step(name: string | null): void;
  /** Post every finished span now (nothing when there are none). */
  flush(): void;
}

export interface WorkerPhaseTraceOptions {
  post: (message: TraceSpansMessage) => void;
  now?: () => number;
  timeOrigin?: number;
}

export function createWorkerPhaseTrace(options: WorkerPhaseTraceOptions): WorkerPhaseTrace {
  let recorder: WorkerSpanRecorder | null = null;
  let stepName: string | null = null;
  let stepToken = -1;
  const trace: WorkerPhaseTrace = {
    get enabled() { return recorder !== null; },
    accept(data) {
      if ((data as { type?: unknown } | null)?.type !== TRACE_ENABLE_MESSAGE) return false;
      const thread = (data as { thread?: unknown }).thread;
      recorder = createWorkerSpanRecorder(typeof thread === 'string' ? thread : 'worker', options.now, options.timeOrigin);
      return true;
    },
    begin: (name, attrs) => recorder?.begin(name, attrs) ?? -1,
    end: (token, attrs) => { if (token >= 0) recorder?.end(token, attrs); },
    span(name, fn, attrs) {
      if (!recorder) return fn();
      const token = recorder.begin(name, attrs);
      let result: ReturnType<typeof fn>;
      try {
        result = fn();
      } catch (err) {
        trace.end(token, { error: true });
        throw err;
      }
      if (isThenable(result)) {
        // Observes settlement only; the caller still owns the returned promise.
        result.then(() => trace.end(token), () => trace.end(token, { error: true }));
      } else {
        trace.end(token);
      }
      return result;
    },
    step(name) {
      if (!recorder || name === stepName) return;
      trace.end(stepToken);
      stepName = name;
      stepToken = name === null ? -1 : recorder.begin(name);
    },
    flush() {
      const payload = recorder?.drain();
      if (payload) options.post({ type: TRACE_SPANS_MESSAGE, payload });
    },
  };
  return trace;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';
}
