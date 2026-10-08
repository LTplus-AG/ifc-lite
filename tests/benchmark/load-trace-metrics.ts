/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Benchmark metrics read from the viewer's load-trace span tree (#6956)
 * instead of console regexes. The span names are the ones
 * `apps/viewer/src/hooks/useIfcLoader.ts` and
 * `packages/geometry/src/geometry-parallel.ts` record; each metric keeps the
 * meaning (and epoch) of the console line it replaces, so a span value and a
 * regex value of the same load agree to within rounding.
 *
 * Kept structural (no import of @ifc-lite/load-trace): the snapshot crosses
 * `page.evaluate` as plain JSON.
 */

export interface LoadTraceSnapshotJson {
  loadId: string;
  attrs: Record<string, unknown>;
  start: number;
  end: number | null;
  spans: Array<{ name: string; thread: string; start: number; end: number | null; milestone?: boolean }>;
  /** #6957 structural counters for this load (see LoadTraceSnapshot.counters). */
  counters?: Record<string, number>;
  workerCounters?: Record<string, Record<string, number>>;
  /** #6957 long-animation-frame / longtask summary (see FrameSummary). */
  mainThread?: Record<string, unknown>;
}

/**
 * #6957 counter families whose totals follow scheduling rather than the
 * model, measured run-to-run on FZK and Snowdon: GPU uploads and merges
 * (`flushPending` slices its queue by a per-frame time budget, and a lost
 * device re-uploads everything), store writes and React commits (progress
 * updates and batching follow frame timing). They are recorded with their
 * spread; `structural` keeps the families that repeat exactly (copies, worker
 * messages, wasm ingress), so a diff there means the load did different work.
 */
export const SCHEDULING_DEPENDENT_PREFIXES: readonly string[] = ['gpu.', 'render.', 'react.', 'store.', 'viewer.'];
/** Grows with every rendered frame, so it is ignored when waiting for counters to settle. */
export const PER_FRAME_COUNTERS: readonly string[] = ['gpu.uniformWriteBytes'];

export interface LoadCounters {
  structural: Record<string, number>;
  scheduling: Record<string, number>;
  workerCounters: Record<string, Record<string, number>>;
  mainThread: Record<string, unknown> | null;
}

/** Split a snapshot's counters for the result JSON; null when the viewer recorded none. */
export function countersFromLoadTrace(snapshot: LoadTraceSnapshotJson | null): LoadCounters | null {
  if (!snapshot?.counters) return null;
  const structural: Record<string, number> = {};
  const scheduling: Record<string, number> = {};
  for (const name of Object.keys(snapshot.counters).sort()) {
    const bucket = SCHEDULING_DEPENDENT_PREFIXES.some((p) => name.startsWith(p)) ? scheduling : structural;
    bucket[name] = snapshot.counters[name];
  }
  return { structural, scheduling, workerCounters: snapshot.workerCounters ?? {}, mainThread: snapshot.mainThread ?? null };
}

/** The counters that must stop moving before a load's counters are recorded. */
export function settleKey(snapshot: LoadTraceSnapshotJson | null): string {
  const counters = { ...(snapshot?.counters ?? {}) };
  for (const name of PER_FRAME_COUNTERS) delete counters[name];
  return JSON.stringify(counters);
}

export const SPAN_METRIC_KEYS = [
  'totalWallClockMs',
  'fileReadMs',
  'firstBatchWaitMs',
  'firstAppendGeometryBatchMs',
  'firstVisibleGeometryMs',
  'streamCompleteMs',
  'geometryStreamingMs',
  'metadataStartMs',
  'spatialReadyMs',
  'metadataCompleteMs',
  'metadataFailedMs',
] as const;
export type SpanMetricKey = (typeof SPAN_METRIC_KEYS)[number];
export type SpanMetrics = Partial<Record<SpanMetricKey, number>>;

/** Milestone span -> the console-derived metric it replaces (all ms since load start). */
const MILESTONES: ReadonlyArray<[string, SpanMetricKey]> = [
  ['geometry.firstAppend', 'firstAppendGeometryBatchMs'],
  ['geometry.firstVisible', 'firstVisibleGeometryMs'],
  ['geometry.streamComplete', 'streamCompleteMs'],
  ['parser.start', 'metadataStartMs'],
  ['parser.spatialReady', 'spatialReadyMs'],
  ['parser.complete', 'metadataCompleteMs'],
  ['parser.failed', 'metadataFailedMs'],
];

/**
 * Rounding each side can carry: the console lines print whole ms (`toFixed(0)`
 * / `Math.round`), except the final summary, which prints seconds to 0.1 s.
 */
export const SPAN_REGEX_TOLERANCE_MS: Readonly<Record<SpanMetricKey, number>> = {
  totalWallClockMs: 100,
  fileReadMs: 2,
  firstBatchWaitMs: 2,
  firstAppendGeometryBatchMs: 2,
  firstVisibleGeometryMs: 2,
  streamCompleteMs: 2,
  geometryStreamingMs: 2,
  metadataStartMs: 2,
  spatialReadyMs: 2,
  metadataCompleteMs: 2,
  metadataFailedMs: 2,
};

const first = (snapshot: LoadTraceSnapshotJson, name: string) =>
  snapshot.spans.find((s) => s.name === name && s.end !== null);

export function metricsFromLoadTrace(snapshot: LoadTraceSnapshotJson | null): SpanMetrics {
  if (!snapshot) return {};
  const out: SpanMetrics = {};
  if (snapshot.end !== null) out.totalWallClockMs = Math.round(snapshot.end - snapshot.start);
  const read = first(snapshot, 'file.read');
  if (read) out.fileReadMs = Math.round(read.end! - read.start);
  for (const [name, key] of MILESTONES) {
    const span = first(snapshot, name);
    if (span) out[key] = Math.round(span.end! - snapshot.start);
  }
  // `[stream] worker[i] first batch @ Xms` counts from the pool start, not the load start.
  const pool = snapshot.spans.find((s) => s.name === 'geometry.pool'); // start is all we need; may still be open
  const firstBatch = first(snapshot, 'geometry.firstBatch');
  if (pool && firstBatch) out.firstBatchWaitMs = Math.round(firstBatch.end! - pool.start);
  if (out.streamCompleteMs !== undefined) out.geometryStreamingMs = out.streamCompleteMs;
  return out;
}

export interface SpanRegexDisagreement {
  metric: SpanMetricKey;
  span: number;
  regex: number;
  toleranceMs: number;
}

/** Metrics present on both sides whose values differ by more than the rounding allowance. */
export function compareSpanAndRegexMetrics(
  span: SpanMetrics,
  regex: Partial<Record<SpanMetricKey, number | null>>,
): SpanRegexDisagreement[] {
  const out: SpanRegexDisagreement[] = [];
  for (const metric of SPAN_METRIC_KEYS) {
    const s = span[metric];
    const r = regex[metric];
    if (s === undefined || r === null || r === undefined) continue;
    const toleranceMs = SPAN_REGEX_TOLERANCE_MS[metric];
    if (Math.abs(s - r) > toleranceMs) out.push({ metric, span: s, regex: r, toleranceMs });
  }
  return out;
}
