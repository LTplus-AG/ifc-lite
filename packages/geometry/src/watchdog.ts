/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Size-aware watchdog for the geometry streaming pipeline.
 *
 * The previous fixed 30 s first-batch watchdog was tuned for ~100 MB files.
 * On a 1 GB IFC the pre-pass alone runs single-threaded WASM for 30-60 s
 * even on fast hardware, so users were timing out before the first geometry
 * batch was emitted. This helper scales the first-batch deadline with file
 * size while preserving the snappy post-first-batch deadline (a real stall
 * mid-stream is still flagged quickly).
 *
 * Floors are at the previous fixed values so we never *decrease* a timeout
 * relative to what shipped before (no regression on small/medium files).
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
const SUBSEQUENT_BATCH_FLOOR_MS_BROWSER = 15_000;
const SUBSEQUENT_BATCH_FLOOR_MS_DESKTOP = 5_000;

const FIRST_BATCH_PER_MB_BROWSER = 60;   // 1 GB → +60 s, total 90 s
const FIRST_BATCH_PER_MB_DESKTOP = 30;   // 1 GB → +30 s, total 45 s

// Subsequent-batch ramp. Workers in the streaming pipeline now process
// big chunks (~25 K jobs) per WASM call to avoid decoder-cache thrash
// (see geometry.worker.ts STREAM_BATCH_SIZE comment). On a 1 GB file
// each WASM call can take ~20-40 s when CPU is contended with the
// parser worker, so the subsequent-batch deadline must scale with file
// size too — otherwise the watchdog fires while workers are actively
// producing meshes.
const SUBSEQUENT_BATCH_PER_MB_BROWSER = 30;  // 1 GB → +30 s, total 45 s
const SUBSEQUENT_BATCH_PER_MB_DESKTOP = 15;  // 1 GB → +15 s, total 20 s

/**
 * Returns the watchdog timeout in milliseconds for the current iterator
 * step. Pure function. Always ≥ the previous fixed value.
 */
export function getGeometryStreamWatchdogMs(inputs: WatchdogInputs): number {
  const desktopStableWasm = inputs.desktopStableWasm === true;
  const batchCount = Math.max(0, Math.floor(inputs.batchCount));
  const fileSizeMB = Math.max(0, inputs.fileSizeMB);

  const floor = batchCount > 0
    ? (desktopStableWasm ? SUBSEQUENT_BATCH_FLOOR_MS_DESKTOP : SUBSEQUENT_BATCH_FLOOR_MS_BROWSER)
    : (desktopStableWasm ? FIRST_BATCH_FLOOR_MS_DESKTOP : FIRST_BATCH_FLOOR_MS_BROWSER);

  const perMb = batchCount > 0
    ? (desktopStableWasm ? SUBSEQUENT_BATCH_PER_MB_DESKTOP : SUBSEQUENT_BATCH_PER_MB_BROWSER)
    : (desktopStableWasm ? FIRST_BATCH_PER_MB_DESKTOP : FIRST_BATCH_PER_MB_BROWSER);

  return Math.max(floor, Math.round(floor + fileSizeMB * perMb));
}
