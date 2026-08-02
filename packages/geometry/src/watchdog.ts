/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Watchdog for the geometry streaming pipeline.
 *
 * Two phases, two different right metrics:
 *
 * - First batch: scales with file size. On a 1 GB IFC the single-threaded
 *   pre-pass alone runs WASM for 30-60 s before the first geometry batch is
 *   emitted, and that scan time genuinely grows with bytes — so the deadline
 *   must too, or users on multi-GB files time out before anything renders.
 *
 * - Subsequent batches: a FIXED grace, deliberately NOT scaled by file size.
 *   Once geometry is flowing, the only silent window is the wall-time of a
 *   single synchronous `processGeometryBatch` call. That tracks geometric
 *   complexity per job (CSG density), which is uncorrelated with megabytes —
 *   dense steel packs far more CSG per MB than an extruded slab. The previous
 *   per-MB ramp measured the wrong thing and killed healthy loads on
 *   CSG-dense models (issue #1097: a ~275 MB steel model tripped its own
 *   15 s + MB*30 = 23 s deadline mid-stream). The worker now bounds a single
 *   call to ~`TARGET_BATCH_MS` via adaptive batch sizing (see
 *   geometry.worker.ts), so this grace gives >10x headroom on realistic
 *   density while still flagging a genuinely wedged pool.
 *
 * Floors are at or above the previous fixed values so we never *decrease* a
 * timeout relative to what shipped before (no regression on small/medium
 * files).
 */

export interface WatchdogInputs {
  /** True when running the desktop-stable WASM path (faster pre-pass). */
  desktopStableWasm: boolean;
  /** Number of geometry batches already received from the iterator. */
  batchCount: number;
  /** File size in megabytes. Use 0 if unknown. */
  fileSizeMB: number;
}

const FIRST_BATCH_FLOOR_MS_BROWSER = 30_000;
const FIRST_BATCH_FLOOR_MS_DESKTOP = 15_000;

// Subsequent-batch grace — a fixed silent-window budget once geometry is
// flowing, independent of file size (issue #1097). Raised above the old 15 s /
// 5 s floors to comfortably exceed the worker's bounded per-call wall-time
// (~`DEFAULT_BATCH_SIZING.targetMs` = 8 s, ~5× headroom) while still catching a
// genuinely wedged pool. The extra room above the target covers the one call
// adaptive sizing can't pre-empt: a `maxJobs` (512) batch that first crosses a
// light→dense boundary before throughput is re-measured. On the reporter's
// Windows machine that was ~23 s at the observed worst density (45 ms/job); 40 s
// keeps ~1.7× headroom there. The old per-MB ramp scaled with the wrong metric
// (bytes, not CSG density) and killed healthy CSG-dense loads.
const SUBSEQUENT_BATCH_MS_BROWSER = 40_000;
const SUBSEQUENT_BATCH_MS_DESKTOP = 25_000;

const FIRST_BATCH_PER_MB_BROWSER = 60;   // 1 GB → +60 s, total 90 s
const FIRST_BATCH_PER_MB_DESKTOP = 30;   // 1 GB → +30 s, total 45 s

/**
 * Returns the watchdog timeout in milliseconds for the current iterator
 * step. Pure function.
 */
export function getGeometryStreamWatchdogMs(inputs: WatchdogInputs): number {
  const desktopStableWasm = inputs.desktopStableWasm === true;
  const batchCount = Math.max(0, Math.floor(inputs.batchCount));
  const fileSizeMB = Math.max(0, inputs.fileSizeMB);

  // Subsequent batches: fixed grace, NOT scaled by file size — the silent
  // window is one bounded WASM call's wall-time (CSG density), not bytes.
  if (batchCount > 0) {
    return desktopStableWasm ? SUBSEQUENT_BATCH_MS_DESKTOP : SUBSEQUENT_BATCH_MS_BROWSER;
  }

  // First batch: scale with file size so the single-threaded pre-pass scan has
  // time to finish on multi-GB files before any geometry renders.
  const floor = desktopStableWasm ? FIRST_BATCH_FLOOR_MS_DESKTOP : FIRST_BATCH_FLOOR_MS_BROWSER;
  const perMb = desktopStableWasm ? FIRST_BATCH_PER_MB_DESKTOP : FIRST_BATCH_PER_MB_BROWSER;
  return Math.max(floor, Math.round(floor + fileSizeMB * perMb));
}
