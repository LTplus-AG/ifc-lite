/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frame/pass timing: mode selection and multi-frame aggregation (issue #2670
 * perf-verdict gate). Pure — see `frame-timing-stats.ts` for the statistics
 * primitives this builds on, and `frame-timing-gpu.ts` for the thin
 * GPU-facing code that produces the raw samples consumed here.
 *
 * Timestamp queries (`GPUQuerySet` of type `'timestamp'`) require the
 * `'timestamp-query'` adapter feature, which is NOT always available — this
 * module's job is to decide, from a plain boolean feature flag, what mode to
 * run in, and to turn raw per-pass nanosecond pairs into the millisecond
 * statistics a caller reads. None of that requires a live device.
 */

import { computeDurationStats, nsToMs, type DurationStats } from './frame-timing-stats.js';

/**
 * How frame timing is actually running, after feature detection:
 *  - `'gpu-queries'`  — real GPU timestamp queries (most accurate; includes
 *    time the CPU never sees, e.g. queued/overlapping work on the GPU).
 *  - `'cpu-fallback'` — wall-clock deltas around `render()` on the CPU side.
 *    Labelled explicitly wherever it is reported: it measures a DIFFERENT
 *    thing (CPU-observed frame cadence, inflated by anything that blocks the
 *    main thread) and must never be presented next to a GPU-queries number
 *    as if the two were comparable.
 *  - `'disabled'`     — not measuring. The default; see `decideTimingMode`.
 */
export type TimingMode = 'gpu-queries' | 'cpu-fallback' | 'disabled';

export interface TimingModeRequest {
  /** Instrumentation is opt-in (see module doc on the renderer entry point). Defaults to not enabled by every caller in this codebase. */
  enabled: boolean;
  /** Whether the adapter this session got advertises the `'timestamp-query'` feature. */
  hasTimestampQueryFeature: boolean;
  /**
   * When GPU queries are unavailable, fall back to CPU-side frame-delta
   * timing instead of measuring nothing. Defaults to `true` when omitted —
   * pass `false` for a caller that only ever wants labelled GPU numbers, or
   * silence.
   */
  allowCpuFallback?: boolean;
}

/**
 * Decides which timing mode to run in. Pure decision table:
 *
 * | enabled | hasTimestampQueryFeature | allowCpuFallback | → mode          |
 * |---------|--------------------------|------------------|-----------------|
 * | false   | *                        | *                | disabled        |
 * | true    | true                     | *                | gpu-queries     |
 * | true    | false                    | true (default)   | cpu-fallback    |
 * | true    | false                    | false            | disabled        |
 *
 * Never throws: an absent feature degrades to a labelled fallback (or to
 * `disabled`), it never crashes the caller for asking.
 */
export function decideTimingMode(request: TimingModeRequest): TimingMode {
  if (!request.enabled) return 'disabled';
  if (request.hasTimestampQueryFeature) return 'gpu-queries';
  const allowCpuFallback = request.allowCpuFallback ?? true;
  return allowCpuFallback ? 'cpu-fallback' : 'disabled';
}

/** One resolved GPU timestamp-query pair for a single pass within one frame. */
export interface PassTimingSample {
  /** Caller-chosen label, e.g. `'shadow'`, `'main'`, `'sky'`. Passes sharing a label within one frame are summed (see `passDurationsMs`) — useful for e.g. multiple shadow cascades rendered as repeated passes under one logical name. */
  label: string;
  startNs: bigint;
  endNs: bigint;
}

/**
 * Per-pass durations (ms) for ONE frame, summed by label. A frame with two
 * `'shadow'` passes and one `'main'` pass returns `{ shadow: <sum of both>,
 * main: <its one duration> }` — the frame's per-pass breakdown, not a list
 * of raw pairs.
 */
export function passDurationsMs(samples: readonly PassTimingSample[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const sample of samples) {
    const ms = nsToMs(sample.startNs, sample.endNs);
    totals[sample.label] = (totals[sample.label] ?? 0) + ms;
  }
  return totals;
}

/**
 * Total GPU time (ms) for one frame: the sum of every pass's duration.
 * WebGPU passes on one queue do not overlap, so summing durations is the
 * frame total — there is no separate "frame envelope" timestamp pair to
 * reconcile against.
 */
export function frameTotalMs(samples: readonly PassTimingSample[]): number {
  let total = 0;
  for (const sample of samples) {
    total += nsToMs(sample.startNs, sample.endNs);
  }
  return total;
}

/** Aggregated statistics across many recorded frames. */
export interface FrameTimingReport {
  mode: TimingMode;
  /** Statistics over each frame's total GPU (or CPU-fallback) time. */
  frame: DurationStats;
  /** Statistics over each pass label's per-frame duration, keyed by label. A label absent from a given frame simply contributes no sample to its stats that frame — it is not treated as a 0ms sample. */
  passes: Record<string, DurationStats>;
}

/**
 * Reduces a history of per-frame pass samples into a `FrameTimingReport`.
 * `frames` is empty for a session where nothing was ever recorded (or the
 * mode is `'disabled'`) — `computeDurationStats([])` already returns the
 * explicit `count: 0` / all-`null` shape for that case, so no special
 * handling is needed here beyond passing `mode` through.
 */
export function aggregateFrameTimings(
  mode: TimingMode,
  frames: readonly (readonly PassTimingSample[])[],
): FrameTimingReport {
  const frameDurations = frames.map((f) => frameTotalMs(f));

  const perLabelDurations = new Map<string, number[]>();
  for (const frame of frames) {
    const perLabel = passDurationsMs(frame);
    for (const [label, ms] of Object.entries(perLabel)) {
      const list = perLabelDurations.get(label);
      if (list) list.push(ms);
      else perLabelDurations.set(label, [ms]);
    }
  }

  const passes: Record<string, DurationStats> = {};
  for (const [label, durations] of perLabelDurations) {
    passes[label] = computeDurationStats(durations);
  }

  return {
    mode,
    frame: computeDurationStats(frameDurations),
    passes,
  };
}
