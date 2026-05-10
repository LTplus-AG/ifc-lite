/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Memory-budget-aware geometry worker count.
 *
 * Each parallel worker holds a WASM instance whose linear memory grows to
 * roughly `fileSize × 1.5` while building geometry. Spawning N workers
 * therefore costs `N × 1.5 × fileSize` plus the main-thread footprint
 * (original buffer + SAB + accumulating mesh data ≈ `fileSize × 2.5`).
 *
 * The previous heuristic only looked at core count, so a 16-core / 32 GB
 * desktop loading a 1 GB file would spawn 8 workers and OOM. The fix is to
 * cap worker count by available RAM after subtracting an OS/browser
 * headroom and the main-thread budget.
 */

export interface WorkerCountInputs {
  /** File size in megabytes. */
  fileSizeMB: number;
  /** `navigator.hardwareConcurrency`, 1+. */
  cores: number;
  /**
   * `navigator.deviceMemory` value (whole gigabytes; capped at 8 by browsers
   * when telemetry-sensitive). When unknown, callers should pass 8.
   */
  deviceMemoryGB: number;
  /** Total geometry jobs the pre-pass discovered. Workers can't exceed this. */
  totalJobs: number;
  /**
   * Lower bound on workers. Defaults to 1 — never returns 0 when there are
   * jobs to do.
   */
  minWorkers?: number;
  /**
   * Upper bound on workers regardless of resources. Defaults to 8 to match
   * the previous hard cap.
   */
  maxWorkers?: number;
}

export interface WorkerCountResult {
  count: number;
  /** For diagnostics: which constraint was binding. */
  reason: 'cores' | 'memory' | 'jobs' | 'min' | 'max';
}

/**
 * Returns the number of parallel geometry workers to spawn for a given file
 * and host capability. Pure function — the only side effect is the chosen
 * number. All inputs validated, result clamped to `[minWorkers, maxWorkers]`.
 */
export function computeWorkerCount(inputs: WorkerCountInputs): WorkerCountResult {
  const fileSizeMB = Math.max(0, inputs.fileSizeMB);
  const cores = Math.max(1, Math.floor(inputs.cores));
  const deviceMemoryGB = Math.max(1, inputs.deviceMemoryGB);
  const totalJobs = Math.max(0, Math.floor(inputs.totalJobs));
  const minWorkers = Math.max(1, Math.floor(inputs.minWorkers ?? 1));
  const maxWorkers = Math.max(minWorkers, Math.floor(inputs.maxWorkers ?? 8));

  if (totalJobs === 0) {
    return { count: minWorkers, reason: 'jobs' };
  }

  // Cores-based ceiling (preserves the previous tier behaviour, but expressed
  // as upper bounds rather than exact picks).
  let coresCap: number;
  if (cores >= 16 && deviceMemoryGB >= 16) {
    coresCap = Math.min(maxWorkers, Math.floor(cores / 2));
  } else if (cores >= 8 && deviceMemoryGB >= 8) {
    // Fanless laptops (MBA M-series) throttle hard at 4+ workers.
    coresCap = fileSizeMB > 512 ? 2 : 3;
  } else {
    coresCap = Math.max(1, Math.min(2, Math.floor(cores / 2)));
  }

  // Memory budget. Reserve 25% of reported RAM (or 1 GB, whichever is larger)
  // for the OS, browser, GPU pool, and other tabs. Subtract main-thread cost
  // (`fileSize × 2.5`). Whatever remains funds workers at `fileSize × 1.5`.
  const totalRAMmb = deviceMemoryGB * 1024;
  const reservedHeadroomMB = Math.max(1024, totalRAMmb * 0.25);
  const mainBudgetMB = fileSizeMB * 2.5;
  const perWorkerMB = Math.max(64, fileSizeMB * 1.5);
  const remaining = totalRAMmb - reservedHeadroomMB - mainBudgetMB;
  const memoryCap = remaining > 0
    ? Math.max(1, Math.floor(remaining / perWorkerMB))
    : 1;

  // Final pick: tightest of the three ceilings, then clamp.
  const candidates: Array<{ value: number; reason: WorkerCountResult['reason'] }> = [
    { value: coresCap, reason: 'cores' },
    { value: memoryCap, reason: 'memory' },
    { value: totalJobs, reason: 'jobs' },
    { value: maxWorkers, reason: 'max' },
  ];

  let pick = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].value < pick.value) pick = candidates[i];
  }

  if (pick.value < minWorkers) {
    return { count: minWorkers, reason: 'min' };
  }
  return { count: pick.value, reason: pick.reason };
}

/**
 * Convenience wrapper that returns just the integer count.
 */
export function pickWorkerCount(inputs: WorkerCountInputs): number {
  return computeWorkerCount(inputs).count;
}
