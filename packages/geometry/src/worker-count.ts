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
  /**
   * Explicit worker count requested by the host (e.g. the viewer's
   * `?geomWorkers=N` A/B knob). When set, it overrides the cores-tier
   * heuristic — but is STILL clamped to the memory budget, job count, and
   * `maxWorkers`, because OOM is never a valid tuning outcome. Undefined ⇒
   * use the heuristic. Lets a user measure their host's true thermal optimum,
   * which is machine-specific and can't be hard-coded.
   */
  workerCountOverride?: number;
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
  // `navigator.deviceMemory` is capped at 8 GB by browsers as a
  // fingerprinting-mitigation measure. When cores indicates a Pro/Max-tier
  // machine (10+) we know in practice it ships with ≥16 GB, so we lift
  // the floor accordingly. Without this, the memory budget computed
  // below pins us to 2 workers on huge files even on 32 GB desktops.
  const reportedMemoryGB = Math.max(1, inputs.deviceMemoryGB);
  const deviceMemoryGB = cores >= 10
    ? Math.max(reportedMemoryGB, 16)
    : reportedMemoryGB;
  const totalJobs = Math.max(0, Math.floor(inputs.totalJobs));
  const minWorkers = Math.max(1, Math.floor(inputs.minWorkers ?? 1));
  const maxWorkers = Math.max(minWorkers, Math.floor(inputs.maxWorkers ?? 8));

  if (totalJobs === 0) {
    // No jobs → no workers. Spawning even one worker pays for a
    // ~250ms WASM compile that has nothing to do; the docstring's
    // non-zero guarantee is scoped to "when there are jobs to do."
    return { count: 0, reason: 'jobs' };
  }

  // Cores-based ceiling (preserves the previous tier behaviour, but expressed
  // as upper bounds rather than exact picks).
  let coresCap: number;
  if (cores >= 16 && deviceMemoryGB >= 16) {
    coresCap = Math.min(maxWorkers, Math.floor(cores / 2));
  } else if (cores >= 12 && deviceMemoryGB >= 8) {
    // 12+ cores indicates M-series Pro 12-core or M-series Max with active
    // cooling. The >512 MB cap stays 4: a `?geomWorkers` A/B sweep on a large
    // georef model showed geometry wall-time is bound by MEMORY BANDWIDTH, not
    // cores — each worker streams a ~1.5×-file WASM heap + per-mesh copy-out
    // over the same unified-memory bus, so a 5th/6th grinder yields no speedup
    // (flat wall-time, higher peak memory) and starves the co-running parser.
    // This cap is a bandwidth ceiling, not a core-count proxy.
    coresCap = fileSizeMB > 512 ? 4 : 5;
  } else if (cores >= 10 && deviceMemoryGB >= 8) {
    // 10+ cores indicates M-series Pro/Max with active cooling. Same bandwidth
    // ceiling as the 12-core tier (measured: 3→4→5 workers gave no geometry
    // speedup on a 722 MB model and progressively starved the parser), so the
    // >512 MB cap stays 3. Users can override per-host via `?geomWorkers=N`.
    coresCap = fileSizeMB > 512 ? 3 : 4;
  } else if (cores >= 8 && deviceMemoryGB >= 8) {
    // Fanless laptops (MBA M-series, 8 cores) throttle hard at 4+ workers.
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

  // Explicit host override (A/B tuning). Honour the requested count but never
  // above the memory budget / job count / hard cap — OOM is not a tuning
  // outcome, so memoryCap stays the safety bound even when overridden. The
  // `reason` reports which bound (if any) clipped the request, so a silently
  // reduced override is visible in the dispatch log.
  if (
    inputs.workerCountOverride != null &&
    Number.isFinite(inputs.workerCountOverride)
  ) {
    let count = Math.max(1, Math.floor(inputs.workerCountOverride));
    let reason: WorkerCountResult['reason'] = 'cores'; // honouring the override
    if (memoryCap < count) {
      count = memoryCap;
      reason = 'memory';
    }
    if (totalJobs < count) {
      count = totalJobs;
      reason = 'jobs';
    }
    if (maxWorkers < count) {
      count = maxWorkers;
      reason = 'max';
    }
    if (minWorkers > count) {
      // Mirror the heuristic path's floor: never return below minWorkers, and
      // report it as the binding constraint (consistent `reason` in the log).
      count = minWorkers;
      reason = 'min';
    }
    return { count, reason };
  }

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
