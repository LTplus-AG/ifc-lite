/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adaptive per-call job budget for the streaming geometry worker's inner
 * `processGeometryBatch` calls.
 *
 * A `processGeometryBatch` call is synchronous WASM: while it runs the worker
 * posts no events, no meshes stream, and nothing feeds the host's stall
 * watchdog. So the silent window the watchdog sees equals one call's
 * wall-time = jobs × ms-per-job. The catch is ms-per-job is dominated by CSG
 * density, which varies by one-to-two orders of magnitude across models (an
 * extruded slab vs. a dense steel connection). A *fixed* job count therefore
 * produces wildly different silent windows: the old `512` was <1 s on light
 * geometry but ~23 s on dense steel — long enough to trip the watchdog and
 * kill a healthy load (issue #1097).
 *
 * Instead of committing to one count, the worker targets a fixed wall-time per
 * call (`TARGET_BATCH_MS`) and resizes the next call from the throughput it
 * just measured, clamped to [`MIN_BATCH_JOBS`, `MAX_BATCH_JOBS`]. Light
 * regions grow toward MAX (few calls, good decoder-cache locality); dense
 * regions shrink toward MIN (small, regular heartbeats). The size is carried
 * across chunks so density learned on one chunk applies to the next — dense
 * CSG clusters by file region, so once a worker sees density it stays small
 * for the rest of that region. The only unbounded window left is the single
 * call that first crosses a light→dense boundary at MAX size; MAX is kept
 * modest (and the watchdog's subsequent grace generous) so even that
 * transitional call stays well under budget.
 *
 * Extracted from the worker (which can't be unit-tested — it imports the WASM
 * module at top level) so the formula stays covered, mirroring `watchdog.ts`.
 */

/** Wall-time budget a single `processGeometryBatch` call should aim for. */
export const TARGET_BATCH_MS = 2_000;
/** Smallest job count — floors decoder-cache thrash on the densest regions. */
export const MIN_BATCH_JOBS = 64;
/**
 * Largest job count — caps the lone transitional call that crosses into a
 * dense region before throughput is re-measured. Kept modest so that call
 * stays comfortably under the watchdog's subsequent grace even at high
 * ms-per-job.
 */
export const MAX_BATCH_JOBS = 256;

/**
 * The next per-call job budget given the last call's job count + wall-time.
 * Pure. Targets `TARGET_BATCH_MS`, clamped to [`MIN_BATCH_JOBS`,
 * `MAX_BATCH_JOBS`]. A zero/sub-ms measurement (a trivially light batch) grows
 * straight to MAX. With nothing measured (`jobs <= 0`) the `current` size is
 * returned unchanged.
 */
export function nextAdaptiveBatchJobs(
  current: number,
  jobs: number,
  elapsedMs: number,
): number {
  if (jobs <= 0) return current;
  const msPerJob = elapsedMs / jobs;
  if (!(msPerJob > 0)) return MAX_BATCH_JOBS;
  const projected = Math.floor(TARGET_BATCH_MS / msPerJob);
  return Math.max(MIN_BATCH_JOBS, Math.min(MAX_BATCH_JOBS, projected));
}
