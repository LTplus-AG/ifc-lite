/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The load trace every production load gets when `?perfTrace=1` is off
 * (#6961). It keeps exactly what field telemetry reads, and nothing else: the
 * first time of each milestone and the load attributes (journey, load path,
 * cache tier, worker count). Spans, records and worker merges stay no-ops, so
 * an instrumented call site still costs one empty method call.
 *
 * Every load path already calls `trace.milestone(...)` and `trace.finish(...)`
 * for the M1 span tree. Recording those calls here gives `ifc_model_loaded`
 * the same milestones on every path, the cache path included, with no second
 * set of timestamps to keep in step with the first.
 */

import type { LoadTrace, LoadTraceAttributes } from '@ifc-lite/load-trace';

/** What `fieldTelemetry.ts` reads off a finished load. */
export interface FieldLoadSummary {
  start: number;
  /** Milestone name -> ms after the load start (first call wins). */
  marks: Record<string, number>;
  attrs: LoadTraceAttributes;
}

export class FieldLoadTrace implements LoadTrace {
  readonly enabled = false;
  private readonly summary: FieldLoadSummary;
  private finished = false;

  constructor(readonly loadId: string, readonly start: number, attrs: LoadTraceAttributes = {}) {
    this.summary = { start, marks: {}, attrs: { ...attrs } };
  }

  setAttrs(attrs: LoadTraceAttributes): void { Object.assign(this.summary.attrs, attrs); }
  begin(): number { return -1; }
  end(): void {}
  span<T>(_name: string, fn: () => T): T { return fn(); }
  record(): void {}
  merge(): void {}
  snapshot(): null { return null; }

  milestone(name: string, atMs?: number | null): number {
    const at = atMs ?? performance.now() - this.start;
    this.summary.marks[name] ??= at;
    return at;
  }

  /** Like the recording trace, only the first `finish` sets attributes. */
  finish(attrs?: LoadTraceAttributes): number {
    if (!this.finished && attrs) this.setAttrs(attrs);
    this.finished = true;
    return performance.now() - this.start;
  }

  fieldSummary(): FieldLoadSummary { return this.summary; }
}
