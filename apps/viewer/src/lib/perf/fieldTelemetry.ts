/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Field telemetry for every load (#6961, perf charter #6954). Loaded on
 * demand by `fieldTelemetryLoader.ts`, so none of this is in the entry chunk.
 *
 * `ifc_model_loaded` gets, on every load path:
 *
 * - the four milestones (first pixel, spatial ready, properties ready, stream
 *   complete), read off the load's own trace: the always-on `FieldLoadTrace`
 *   in production, the recording trace under `?perfTrace=1`;
 * - main-thread health over the load window from a long-animation-frame (or,
 *   without LoAF, longtask) observer;
 * - bytes the workers handed the main thread, from `memoryAccounting`, which
 *   already runs on every load;
 * - journey, cache tier and worker count from the trace attributes, and the
 *   active perf-flag arm from the M7 registry.
 *
 * Why not the recording tracer: it keeps every span, a per-load counter
 * registry and a 20k-entry frame log, and counting message bytes walks every
 * worker payload. This module costs one PerformanceObserver that fires only
 * on frames over 50 ms, plus a handful of property reads per load.
 */

import { startFrameMonitor, summarizeFrames, type FrameMonitor, type LoadTrace, type LoadTraceSnapshot, type ObserverCtor } from '@ifc-lite/load-trace';
import { FieldLoadTrace, type FieldLoadSummary } from './fieldLoadTrace.js';
import { perfFlagArm } from './fieldArm.js';
import { memoryAccounting } from './memoryAccounting.js';

export { perfFlagArm } from './fieldArm.js';
export * from './fieldEvents.js';

export type FieldProps = Record<string, string | number | boolean | undefined>;

/** Long frames kept for the load windows; only frames over 50 ms are logged. */
const MAX_LONG_FRAMES = 2_000;

let monitor: FrameMonitor | null = null;

/** Start the session's long-frame log once; later calls are no-ops. */
export function startLongFrameLog(Observer?: ObserverCtor): void {
  monitor ??= startFrameMonitor(Observer, MAX_LONG_FRAMES);
}

/** Test seam: drop the session log so the next start observes afresh. */
export function resetLongFrameLogForTests(): void {
  monitor?.stop();
  monitor = null;
}

export interface LongFrameStats {
  source: 'loaf' | 'longtask';
  blockedMs: number;
  longestMs: number;
  count: number;
}

/**
 * Main-thread health between two `performance.now()` times, or null when the
 * engine has neither LoAF nor longtask (Firefox, Safari): "not measured", not
 * a healthy zero.
 */
export function longFramesBetween(start: number, end: number): LongFrameStats | null {
  if (!monitor) return null;
  const { supported } = monitor;
  if (!supported.loaf && !supported.longtask) return null;
  const summary = summarizeFrames(monitor.entries(), supported, start, end, []);
  const source = supported.loaf ? 'loaf' : 'longtask';
  const stats = summary[source];
  return { source, blockedMs: Math.round(stats.blockingMs), longestMs: Math.round(stats.longestMs), count: stats.count };
}

function summaryFromSnapshot(trace: LoadTrace, snapshot: LoadTraceSnapshot | null): FieldLoadSummary {
  const marks: Record<string, number> = {};
  for (const span of snapshot?.spans ?? []) {
    if (span.milestone && span.end !== null) marks[span.name] ??= span.end - span.start;
  }
  return { start: trace.start, marks, attrs: snapshot?.attrs ?? {} };
}

function loadSummary(trace: LoadTrace): FieldLoadSummary {
  return trace instanceof FieldLoadTrace ? trace.fieldSummary() : summaryFromSnapshot(trace, trace.snapshot());
}

const round = (ms: number | undefined) => (ms === undefined ? undefined : Math.round(ms));

/**
 * The full `ifc_model_loaded` properties: the path's own payload plus the
 * #6961 field properties. A value the path measured always wins, and nothing
 * unmeasured is sent (absent, never null or a fabricated 0).
 */
export function fieldLoadProps(trace: LoadTrace, payload: FieldProps, at: number = performance.now()): FieldProps {
  const { start, marks, attrs } = loadSummary(trace);
  // A path that streams geometry records `geometry.streamComplete`. One that
  // commits the model in a single step (IFCX, GLB, server, point cloud,
  // LandXML) has nothing to show before that commit, so its milestones are
  // the commit time: `milestone_source` says which one a row carries.
  const streamed = marks['geometry.streamComplete'] !== undefined;
  const total = typeof payload.total_elapsed_ms === 'number' ? payload.total_elapsed_ms : undefined;
  const commit = streamed ? undefined : total;
  const storeReady = marks['cache.storeReady'];
  const frames = longFramesBetween(start, at);
  const memory = memoryAccounting.summary();
  const workerBytes = memory.totalGeometryBytes + memory.transportBytes;
  const props: FieldProps = {
    first_visible_geometry_ms: round(marks['geometry.firstVisible'] ?? commit),
    spatial_ready_ms: round(marks['parser.spatialReady'] ?? storeReady ?? commit),
    metadata_complete_ms: round(marks['parser.complete'] ?? storeReady ?? commit),
    stream_complete_ms: round(marks['geometry.streamComplete'] ?? commit),
    milestone_source: streamed ? 'trace' : 'commit',
    journey: attrs.journey,
    cache_tier: attrs.cacheTier,
    worker_count: typeof attrs.workerCount === 'number' ? attrs.workerCount : undefined,
    main_thread_blocked_ms: frames?.blockedMs,
    longest_long_frame_ms: frames?.longestMs,
    long_frame_count: frames?.count,
    long_frame_source: frames?.source,
    worker_transfer_bytes: workerBytes > 0 ? workerBytes : undefined,
    perf_flags: perfFlagArm(),
  };
  // The path's own measured values win; its unmeasured (undefined) ones do not.
  for (const [key, value] of Object.entries(payload)) if (value !== undefined) props[key] = value;
  for (const key of Object.keys(props)) if (props[key] === undefined) delete props[key];
  return props;
}
