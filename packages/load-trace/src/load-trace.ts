/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createPerfSink, MEASURE_PREFIX, type PerfSink } from './perf-sink.js';
import type {
  LoadTraceAttributes,
  LoadTraceSnapshot,
  TraceAttrs,
  TraceSpan,
  WorkerTracePayload,
} from './types.js';

/**
 * One load's trace. Every method is safe to call when tracing is OFF: the
 * disabled implementation keeps only the start time (so `milestone`/`finish`
 * still return elapsed ms) and every other call is an empty function, so an
 * instrumented call site costs one monomorphic no-op call and no allocation.
 */
export interface LoadTrace {
  readonly enabled: boolean;
  readonly loadId: string;
  /** Load start on the main `performance.now()` clock. */
  readonly start: number;
  setAttrs(attrs: LoadTraceAttributes): void;
  /** Open a span; returns a token for `end` (`-1` when disabled). */
  begin(name: string, attrs?: TraceAttrs, parent?: number): number;
  end(token: number, attrs?: TraceAttrs): void;
  /** Time `fn`; a returned promise ends the span when it settles. Returns `fn`'s result unchanged. */
  span<T>(name: string, fn: () => T, attrs?: TraceAttrs, parent?: number): T;
  /** Record an interval the caller already measured. */
  record(name: string, start: number, end: number, attrs?: TraceAttrs, parent?: number): void;
  /**
   * Mark a milestone `atMs` after the load start (default: now). The span runs
   * from the load start, so its measure duration IS the time-to-milestone. The
   * first call per name is recorded; every call returns the elapsed ms.
   */
  milestone(name: string, atMs?: number | null): number;
  /** Fold a worker's spans onto this timeline (clock-aligned via `timeOrigin`). */
  merge(payload: WorkerTracePayload, parent?: number): void;
  /** End the load root (first call wins); returns elapsed ms since the start. */
  finish(attrs?: LoadTraceAttributes): number;
  snapshot(): LoadTraceSnapshot | null;
}

export interface LoadTracerOptions {
  enabled: boolean;
  now?: () => number;
  timeOrigin?: number;
  /** `null` disables the User Timing mirror (the span tree is still kept). */
  sink?: PerfSink | null;
  /** Most recent loads retained; older ones are dropped. Default 16. */
  maxLoads?: number;
}

export interface LoadTracer {
  readonly enabled: boolean;
  startLoad(loadId: string, attrs?: LoadTraceAttributes, start?: number): LoadTrace;
  snapshots(): LoadTraceSnapshot[];
  latest(): LoadTraceSnapshot | null;
}

const defaultNow = (): number => globalThis.performance?.now() ?? Date.now();
const defaultTimeOrigin = (): number => globalThis.performance?.timeOrigin ?? 0;

class DisabledLoadTrace implements LoadTrace {
  readonly enabled = false;
  constructor(readonly loadId: string, readonly start: number, private readonly now: () => number) {}
  setAttrs(): void {}
  begin(): number { return -1; }
  end(): void {}
  span<T>(_name: string, fn: () => T): T { return fn(); }
  record(): void {}
  milestone(_name: string, atMs?: number | null): number { return atMs ?? this.now() - this.start; }
  merge(): void {}
  finish(): number { return this.now() - this.start; }
  snapshot(): null { return null; }
}

class RecordingLoadTrace implements LoadTrace {
  readonly enabled = true;
  private readonly spans: TraceSpan[] = [];
  private readonly milestones = new Set<string>();
  private readonly attrs: LoadTraceAttributes;
  private end_: number | null = null;

  constructor(
    readonly loadId: string,
    readonly start: number,
    attrs: LoadTraceAttributes,
    private readonly now: () => number,
    private readonly timeOrigin: number,
    private readonly sink: PerfSink | null,
  ) {
    this.attrs = { ...attrs };
  }

  setAttrs(attrs: LoadTraceAttributes): void {
    Object.assign(this.attrs, attrs);
  }

  begin(name: string, attrs?: TraceAttrs, parent?: number): number {
    return this.push(name, 'main', this.now(), null, attrs, parent);
  }

  end(token: number, attrs?: TraceAttrs): void {
    const span = this.spans[token];
    if (!span || span.end !== null) return;
    span.end = this.now();
    if (attrs) span.attrs = { ...span.attrs, ...attrs };
    this.emit(span);
  }

  span<T>(name: string, fn: () => T, attrs?: TraceAttrs, parent?: number): T {
    const token = this.begin(name, attrs, parent);
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.end(token, { error: true });
      throw err;
    }
    if (isThenable(result)) {
      // The derived promise only observes settlement; the caller still owns
      // (and handles) the original promise returned below.
      result.then(() => this.end(token), () => this.end(token, { error: true }));
    } else {
      this.end(token);
    }
    return result;
  }

  record(name: string, start: number, end: number, attrs?: TraceAttrs, parent?: number): void {
    this.emit(this.spans[this.push(name, 'main', start, end, attrs, parent)]);
  }

  milestone(name: string, atMs?: number | null): number {
    const at = atMs ?? this.now() - this.start;
    if (!this.milestones.has(name)) {
      this.milestones.add(name);
      const span = this.spans[this.push(name, 'main', this.start, this.start + at)];
      span.milestone = true;
      this.emit(span);
    }
    return at;
  }

  merge(payload: WorkerTracePayload, parent?: number): void {
    const shift = payload.timeOrigin - this.timeOrigin;
    for (const s of payload.spans) {
      this.emit(this.spans[this.push(s.name, payload.thread, s.start + shift, s.end + shift, s.attrs, parent)]);
    }
  }

  finish(attrs?: LoadTraceAttributes): number {
    if (this.end_ === null) {
      this.end_ = this.now();
      if (attrs) this.setAttrs(attrs);
      this.sink?.measure(`${MEASURE_PREFIX}load`, this.start, this.end_, { loadId: this.loadId });
    }
    return this.end_ - this.start;
  }

  snapshot(): LoadTraceSnapshot {
    return {
      loadId: this.loadId,
      attrs: { ...this.attrs },
      timeOrigin: this.timeOrigin,
      start: this.start,
      end: this.end_,
      spans: this.spans.map((s) => ({ ...s, ...(s.attrs ? { attrs: { ...s.attrs } } : {}) })),
    };
  }

  private push(
    name: string, thread: string, start: number, end: number | null, attrs?: TraceAttrs, parent?: number,
  ): number {
    const id = this.spans.length;
    const parentId = parent !== undefined && parent >= 0 && parent < id ? parent : null;
    this.spans.push({ id, name, thread, start, end, parentId, ...(attrs ? { attrs: { ...attrs } } : {}) });
    return id;
  }

  private emit(span: TraceSpan): void {
    if (span.end === null || !this.sink) return;
    this.sink.measure(`${MEASURE_PREFIX}${span.name}`, span.start, span.end, {
      loadId: this.loadId, thread: span.thread, ...span.attrs,
    });
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';
}

export function createLoadTracer(options: LoadTracerOptions): LoadTracer {
  const now = options.now ?? defaultNow;
  const maxLoads = Math.max(1, options.maxLoads ?? 16);
  const enabled = options.enabled;
  const timeOrigin = options.timeOrigin ?? defaultTimeOrigin();
  const sink = options.sink === undefined ? (enabled ? createPerfSink() : null) : options.sink;
  const loads: RecordingLoadTrace[] = [];
  return {
    enabled,
    startLoad(loadId, attrs = {}, start = now()) {
      if (!enabled) return new DisabledLoadTrace(loadId, start, now);
      const trace = new RecordingLoadTrace(loadId, start, attrs, now, timeOrigin, sink);
      loads.push(trace);
      if (loads.length > maxLoads) loads.splice(0, loads.length - maxLoads);
      return trace;
    },
    snapshots: () => loads.map((l) => l.snapshot()),
    latest: () => loads[loads.length - 1]?.snapshot() ?? null,
  };
}

/** A disabled trace with no clock of its own, for callers given no trace at all. */
export const NOOP_LOAD_TRACE: LoadTrace = new DisabledLoadTrace('noop', 0, () => 0);
