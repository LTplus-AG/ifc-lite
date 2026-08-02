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
 * call (`targetMs`) and resizes the next call from the throughput it just
 * measured, clamped to [`minJobs`, `maxJobs`]. Light regions grow toward MAX
 * (few calls, good decoder-cache locality — re-decode of shared sub-entities
 * is amortised over more jobs); dense regions shrink toward MIN (small, regular
 * heartbeats). The size is carried across chunks so density learned on one
 * chunk applies to the next — dense CSG clusters by file region, so once a
 * worker sees density it stays small for the rest of that region.
 *
 * Throughput vs. safety: a SMALLER `targetMs` streams more smoothly and keeps
 * the silent window further under the watchdog grace, but a TOO-small target
 * collapses dense regions to tiny batches that re-pay decoder-cache setup and
 * re-decode shared sub-entities per call — the dominant cost once the O(file)
 * pre-pass scan is seeded out. The defaults below were tuned on the largest
 * real models (300 MB–1 GB, CSG-dense steel + architectural) to sit at the
 * knee: large enough that decode overhead is a few percent, small enough that
 * the steady-state silent window stays well under the watchdog's subsequent
 * grace (see watchdog.ts). The only window adaptive sizing can't pre-empt is
 * the single call that first crosses a light→dense boundary at MAX size, so
 * `maxJobs × worst-realistic-ms-per-job` is kept under that grace too.
 *
 * Extracted from the worker (which can't be unit-tested — it imports the WASM
 * module at top level) so the formula stays covered, mirroring `watchdog.ts`.
 */

export interface BatchSizingConfig {
  /** Wall-time budget a single `processGeometryBatch` call should aim for. */
  targetMs: number;
  /** Smallest job count — floors decoder-cache thrash on the densest regions. */
  minJobs: number;
  /**
   * Largest job count — caps the lone transitional call that crosses into a
   * dense region before throughput is re-measured. Kept so `maxJobs ×
   * worst-ms-per-job` stays under the watchdog's subsequent grace.
   */
  maxJobs: number;
}

/**
 * Defaults tuned on the largest real models. `targetMs` of 8 s keeps dense
 * steel batches large enough to amortise decoder setup (vs. the ~2 s first cut
 * which collapsed them to the floor and ran ~2× slower), while staying ~4×
 * under the 30 s browser grace. `maxJobs` of 512 matches the historical fixed
 * batch on light geometry (no throughput regression there) and, at the
 * observed worst density (~45 ms/job → 23 s), still lands under the grace for
 * the one transitional call.
 */
export const DEFAULT_BATCH_SIZING: BatchSizingConfig = {
  targetMs: 8_000,
  minJobs: 64,
  maxJobs: 512,
};

/**
 * Merge a partial override (e.g. a runtime tuning hook) onto the defaults,
 * dropping any non-finite/non-positive field and enforcing `minJobs <=
 * maxJobs`. Always returns a usable config.
 */
export function resolveBatchSizing(partial?: Partial<BatchSizingConfig> | null): BatchSizingConfig {
  const pick = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  const targetMs = pick(partial?.targetMs, DEFAULT_BATCH_SIZING.targetMs);
  const minJobs = pick(partial?.minJobs, DEFAULT_BATCH_SIZING.minJobs);
  const maxJobs = Math.max(minJobs, pick(partial?.maxJobs, DEFAULT_BATCH_SIZING.maxJobs));
  return { targetMs, minJobs, maxJobs };
}

/**
 * The next per-call job budget given the last call's job count + wall-time.
 * Pure. Targets `cfg.targetMs`, clamped to [`cfg.minJobs`, `cfg.maxJobs`]. A
 * zero/sub-ms measurement (a trivially light batch) grows straight to MAX.
 * With nothing measured (`jobs <= 0`) the `current` size is returned unchanged.
 */
export function nextAdaptiveBatchJobs(
  current: number,
  jobs: number,
  elapsedMs: number,
  cfg: BatchSizingConfig = DEFAULT_BATCH_SIZING,
): number {
  if (jobs <= 0) return current;
  const msPerJob = elapsedMs / jobs;
  if (!(msPerJob > 0)) return cfg.maxJobs;
  const projected = Math.floor(cfg.targetMs / msPerJob);
  return Math.max(cfg.minJobs, Math.min(cfg.maxJobs, projected));
}
