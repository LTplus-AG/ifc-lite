/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Attribute values that survive structured clone, JSON and the User Timing `detail`. */
export type TraceAttrValue = string | number | boolean;
export type TraceAttrs = Readonly<Record<string, TraceAttrValue>>;

/**
 * Per-load attributes (charter #6954). `journey` is the charter journey id
 * (`J1` cold open, `J2` warm/cache open, `J4` federated add, ...).
 */
export interface LoadTraceAttributes {
  journey?: string;
  modelKind?: 'primary' | 'federated';
  cacheTier?: string;
  loadPath?: string;
  workerCount?: number;
  [key: string]: TraceAttrValue | undefined;
}

/**
 * One span on the load timeline. Times are milliseconds on the MAIN thread's
 * `performance.now()` clock; worker spans are shifted onto it at merge time.
 */
export interface TraceSpan {
  id: number;
  name: string;
  /** `main`, or the worker label given to `enableWorkerTrace` (e.g. `geom-0`). */
  thread: string;
  start: number;
  /** `null` while the span is still open. */
  end: number | null;
  /** Parent span id; `null` means the load root. */
  parentId: number | null;
  /** Milestones start at the load root, so their duration is time-to-milestone. */
  milestone?: true;
  attrs?: Record<string, TraceAttrValue>;
}

/** JSON-safe copy of one load's span tree (`spans` is flat; `parentId` links it). */
export interface LoadTraceSnapshot {
  loadId: string;
  attrs: LoadTraceAttributes;
  /** Main-thread `performance.timeOrigin`, so absolute times can be recovered. */
  timeOrigin: number;
  start: number;
  end: number | null;
  spans: TraceSpan[];
}

/** A finished span recorded inside a worker, on that worker's own clock. */
export interface WorkerSpan {
  name: string;
  start: number;
  end: number;
  attrs?: Record<string, TraceAttrValue>;
}

/** What a worker posts back: its spans plus the clock origin needed to align them. */
export interface WorkerTracePayload {
  thread: string;
  timeOrigin: number;
  spans: WorkerSpan[];
}
