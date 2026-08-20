/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure statistics for frame/pass GPU timing (issue #2670 perf-verdict gate).
 *
 * Everything in this file is arithmetic over plain numbers/bigints — no
 * `GPUQuerySet`, no `performance.now()`, nothing that touches a clock or a
 * device. That split is deliberate: the thin GPU-facing code in
 * `frame-timing-gpu.ts` cannot be exercised without a WebGPU adapter with the
 * `timestamp-query` feature (which this environment's Chromium does not
 * expose — `navigator.gpu` itself is absent), so every number it produces is
 * pushed through here, where it CAN be tested with synthetic values.
 */

/**
 * Summary statistics over a sample of frame or pass durations, in
 * milliseconds.
 *
 * A mean hides exactly the stutter a perf verdict cares about — one frame
 * that spikes to 40 ms among fifty at 8 ms barely moves a mean, but it is
 * the one a user notices. `p95` (and `max`, its worst case) are the
 * statistics this module treats as the headline; `mean` and `median` are
 * kept for context, not as the number to gate on.
 *
 * `count === 0` is the explicit empty-sample marker: every other field is
 * `null` rather than `0`, because a real all-zero sample and "nothing was
 * measured" must never be indistinguishable to a caller reading this object.
 */
export interface DurationStats {
  /** Number of samples the statistics below were computed over. */
  count: number;
  min: number | null;
  /** 50th percentile (nearest-rank on the sorted sample). */
  median: number | null;
  /** 95th percentile (nearest-rank on the sorted sample) — see class doc. */
  p95: number | null;
  max: number | null;
  /** Arithmetic mean. Context only — do not gate a perf verdict on this. */
  mean: number | null;
}

const EMPTY_STATS: DurationStats = {
  count: 0,
  min: null,
  median: null,
  p95: null,
  max: null,
  mean: null,
};

/**
 * WebGPU timestamp queries resolve to nanoseconds (`BigInt64Array` values
 * read back from the resolve buffer). The renderer's budgets and every other
 * timing surface in this codebase (`FrameStats.timestamp` via
 * `performance.now()`) are in milliseconds, so every raw pair gets converted
 * through this one function.
 *
 * Takes `bigint` (the actual readback type) so a caller cannot accidentally
 * pass an already-lossy `Number(timestamp)` of a value that may exceed
 * `Number.MAX_SAFE_INTEGER` (a query set can hold timestamps for a
 * long-running session; ~104 days of nanoseconds overflows a JS number).
 * The subtraction happens in `bigint` space and only the final, small
 * (sub-second, in practice sub-100ms) millisecond duration is converted to
 * `number`.
 *
 * Clamps a negative delta (`endNs < startNs`) to `0` rather than returning
 * a physically impossible negative duration. This is reachable: GPU
 * timestamps are not guaranteed monotonic across a device reset (see this
 * module's own doc above). `0` is the honest floor — a duration cannot be
 * negative, and unlike a raw negative number it cannot silently drag a
 * `min`/`mean` computed downstream into nonsense. This is the guard's one
 * choke point: `frameTotalMs`/`passDurationsMs` (`frame-timing.ts`) sum
 * this function's output directly, without ever routing it through
 * `computeDurationStats`, so a guard placed only in `computeDurationStats`
 * would miss that summation entirely. Use `isNegativeDelta` alongside this
 * function where the caller wants to know a clamp happened.
 */
export function nsToMs(startNs: bigint, endNs: bigint): number {
  const deltaNs = endNs - startNs;
  if (deltaNs < 0n) return 0;
  return Number(deltaNs) / 1_000_000;
}

/**
 * Reports whether `(startNs, endNs)` is a monotonicity violation (`endNs <
 * startNs`) — the only case the module's own doc calls out as reachable:
 * GPU timestamps "are not guaranteed monotonic across a device reset".
 *
 * This is the guard's true origin point: `nsToMs` alone cannot both return a
 * single honest millisecond number for every downstream summation (see
 * `frameTotalMs`/`passDurationsMs` in `frame-timing.ts`, which add its
 * output directly into a running total and never pass through
 * `computeDurationStats`) AND separately expose "this one was bad" — a
 * plain `number` return has no second channel for that. Callers that want
 * to surface an invalid-sample count (rather than let a clamped-to-0 value
 * pass as an unremarkable real zero) call this predicate on the same raw
 * pair alongside `nsToMs`. `computeDurationStats` is deliberately NOT where
 * this lives: by the time a caller has an array of plain millisecond
 * numbers, it has no way to tell a clamped GPU-reset zero apart from a
 * genuine fast pass or a CPU-fallback delta (which is never negative — it
 * comes from `performance.now()`, spec-guaranteed non-decreasing) — see
 * that function's doc.
 */
export function isNegativeDelta(startNs: bigint, endNs: bigint): boolean {
  return endNs - startNs < 0n;
}

/**
 * Nearest-rank percentile over `sorted` (must already be sorted ascending).
 * `p` is a fraction in `[0, 1]`. Rounds the rank rather than interpolating —
 * cheap, deterministic, and matches how `p95`/`median` are colloquially read
 * off a sorted sample in perf work.
 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const rank = Math.ceil(p * sorted.length) - 1;
  const clamped = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[clamped];
}

/**
 * Reduces a sample of durations (milliseconds) to summary statistics. Pure:
 * no side effects, no clock reads — the durations are supplied by the
 * caller, whether they came from GPU timestamp queries or the CPU
 * frame-delta fallback (see `frame-timing.ts`).
 *
 * `durationsMs.length === 0` returns `EMPTY_STATS` (`count: 0`, every other
 * field `null`) rather than computing `0`s — a percentile or a mean over an
 * empty array is either `NaN` (misreported as a real "instant" frame) or a
 * divide-by-zero, and either would read as "this was fast" instead of "this
 * was never measured".
 */
export function computeDurationStats(durationsMs: readonly number[]): DurationStats {
  if (durationsMs.length === 0) return EMPTY_STATS;

  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);

  return {
    count: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}
