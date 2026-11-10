/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry worker count, budgeted by the memory of the whole tab.
 *
 * Every dedicated worker shares the page's renderer process, and every wasm
 * instance (the pre-pass worker and each geometry worker) holds a full copy
 * of the source. So the tab's peak grows as workers × file size, plus the
 * SAB and the main-thread tables (`tab-memory-budget.ts` has the model and
 * its calibration). The count is the cores/thermal tier below, lowered to the
 * largest N whose estimated tab peak fits the device's budget, never below
 * one. When even one worker cannot fit the most memory the device can have,
 * the plan says so (`exceedsDevice`); `assertGeometryMemoryFits` lets the
 * host refuse such a load up front.
 */

import { readDeviceMemoryOverrideGB } from './perf-flags.js';
import {
  deviceMemoryCeilingGB,
  estimateTabPeakMiB,
  GeometryMemoryBudgetError,
  maxWorkersWithinBudget,
  tabBudgetMiB,
} from './tab-memory-budget.js';

export { GeometryMemoryBudgetError };

export interface WorkerCountInputs {
  /** File size in megabytes (MiB). */
  fileSizeMB: number;
  /** `navigator.hardwareConcurrency`, 1+. */
  cores: number;
  /**
   * Device memory in GiB to plan with: `navigator.deviceMemory`, or 8 when
   * the browser does not expose it (Firefox, Safari). On 10+ cores it is
   * raised to at least 16 (capped by `deviceMemoryCeilingGB`), because a
   * clamped 8 on such a machine is in practice 16 GB or more.
   */
  deviceMemoryGB: number;
  /**
   * The most RAM (GiB) the device can have (`deviceMemoryCeilingGB` of the
   * reported value). `Infinity`/undefined when unknown: the load is then never
   * refused, only budgeted.
   */
  deviceMemoryCeilingGB?: number;
  /** Total geometry jobs the pre-pass discovered. Workers can't exceed this. */
  totalJobs: number;
  /** Lower bound on workers when there are jobs. Defaults to 1. */
  minWorkers?: number;
  /** Upper bound on workers regardless of resources. Defaults to 8. */
  maxWorkers?: number;
  /**
   * Explicit worker count requested by the host (the viewer's `?geomWorkers=N`
   * A/B knob). It wins over the cores tier AND the memory budget, and skips
   * the up-front refusal: the user asked for this count. It is clamped only
   * to `[minWorkers, maxWorkers]` and the job count. `fitsBudget` in the
   * result says whether the estimate fit. Undefined ⇒ use the policy.
   */
  workerCountOverride?: number;
}

export interface WorkerCountResult {
  count: number;
  /** For diagnostics: which constraint was binding. */
  reason: 'cores' | 'memory' | 'jobs' | 'min' | 'max' | 'override';
  /** Estimated peak tab memory (MiB) at `count` workers (`estimateTabPeakMiB`). */
  estimatedPeakMiB: number;
  /** The tab budget (MiB) the count was planned against. */
  budgetMiB: number;
  /** Whether `estimatedPeakMiB` is within `budgetMiB`. */
  fitsBudget: boolean;
  /**
   * Even one geometry worker's estimated peak exceeds the most memory the
   * device can have (never set for an override or an unknown ceiling). A host
   * may refuse the load (`assertGeometryMemoryFits`); the pool still runs it
   * with one worker.
   */
  exceedsDevice: boolean;
  /** Estimated peak with one geometry worker, MiB (the refusal's "required"). */
  minimumPeakMiB: number;
  /** The most memory the device can have, MiB (`Infinity` when unknown). */
  deviceCeilingMiB: number;
}

/**
 * Returns the number of parallel geometry workers to spawn for a given file
 * and host capability. Pure function. All inputs validated, result clamped to
 * `[minWorkers, maxWorkers]` when there are jobs.
 */
export function computeWorkerCount(inputs: WorkerCountInputs): WorkerCountResult {
  // NaN loses every comparison, so a NaN input would silently drop a cap or return NaN: replace non-finite inputs first.
  const fileSizeMB = Number.isFinite(inputs.fileSizeMB) ? Math.max(0, inputs.fileSizeMB) : 0;
  const cores = Number.isFinite(inputs.cores) ? Math.max(1, Math.floor(inputs.cores)) : 1;
  const ceilingGB = Number.isNaN(inputs.deviceMemoryCeilingGB) ? Infinity : inputs.deviceMemoryCeilingGB ?? Infinity;
  // `navigator.deviceMemory` is clamped (8 on older Chrome and Android) as a
  // fingerprinting mitigation. When cores indicates a Pro/Max-tier machine
  // (10+) we know in practice it ships with ≥16 GB, so we lift the floor for
  // the cores tiers. The memory budget uses the same lift, but never above
  // what the reported value proves the device can have.
  // A non-finite or non-positive value is treated as unknown: the documented 8.
  const reportedMemoryGB = Number.isFinite(inputs.deviceMemoryGB) && inputs.deviceMemoryGB > 0
    ? Math.max(1, inputs.deviceMemoryGB) : 8;
  const deviceMemoryGB = cores >= 10 ? Math.max(reportedMemoryGB, 16) : reportedMemoryGB;
  const planningMemoryGB = Math.min(deviceMemoryGB, Math.max(reportedMemoryGB, ceilingGB));
  // An unknown (NaN) job count does not bind; the other ceilings decide.
  const totalJobs = Number.isNaN(inputs.totalJobs) ? Infinity : Math.max(0, Math.floor(inputs.totalJobs));
  const minWorkers = Number.isFinite(inputs.minWorkers) ? Math.max(1, Math.floor(inputs.minWorkers ?? 1)) : 1;
  const maxWorkers = Number.isFinite(inputs.maxWorkers) ? Math.max(minWorkers, Math.floor(inputs.maxWorkers ?? 8)) : Math.max(minWorkers, 8);

  const budgetMiB = tabBudgetMiB(planningMemoryGB);
  const minimumPeakMiB = estimateTabPeakMiB(fileSizeMB, 1);
  const finish = (count: number, reason: WorkerCountResult['reason'], exceedsDevice = false): WorkerCountResult => {
    const estimatedPeakMiB = estimateTabPeakMiB(fileSizeMB, count);
    return {
      count, reason, estimatedPeakMiB, budgetMiB,
      fitsBudget: estimatedPeakMiB <= budgetMiB, exceedsDevice, minimumPeakMiB,
      deviceCeilingMiB: ceilingGB * 1024,
    };
  };

  if (totalJobs === 0) {
    // No jobs → no workers. Spawning even one worker pays for a
    // ~250ms WASM compile that has nothing to do; the docstring's
    // non-zero guarantee is scoped to "when there are jobs to do."
    return finish(0, 'jobs');
  }

  // Explicit host override (A/B tuning, field debugging): the user's count
  // wins over the cores tier and the memory budget. Only the job count and
  // the hard bounds clip it; `reason` names the bound that did.
  if (inputs.workerCountOverride != null && Number.isFinite(inputs.workerCountOverride)) {
    let count = Math.max(1, Math.floor(inputs.workerCountOverride));
    let reason: WorkerCountResult['reason'] = 'override';
    if (totalJobs < count) {
      count = totalJobs;
      reason = 'jobs';
    }
    if (maxWorkers < count) {
      count = maxWorkers;
      reason = 'max';
    }
    if (minWorkers > count) {
      count = minWorkers;
      reason = 'min';
    }
    return finish(count, reason);
  }

  // Cores-based ceiling (thermal and memory-bandwidth tiers).
  let coresCap: number;
  // Small files load in a few seconds (not a sustained grind) and cost trivial
  // memory, so neither the thermal nor the bandwidth/RAM concerns the per-core
  // caps below guard against bind. A small but geometry-heavy model is
  // COMPUTE-bound (boolean-clipped steel — 170_KM is 20 MB / ~5000 booleans —
  // or dense breps), which scales with cores; the 3–4-worker cap left most of
  // an active-cooled (10+ core) machine idle. The measured bandwidth ceiling
  // was a >512 MB georef result (#1159) — the opposite regime. Give small files
  // near-full parallelism; the memory budget below still gates if RAM is
  // tight, and `?geomWorkers=N` still overrides per-host.
  //
  // Lower bound (MIN_PARALLEL_MB): the caller spawns workers from a file-size
  // PROXY (`fileSizeMB × 100`) before the pre-pass reports real job counts, so
  // the totalJobs ceiling below can't yet protect a *light* small model. Gating
  // the bump to ≥8 MB keeps tiny/simple models (which load in a couple seconds
  // on a few workers) off the fast path — so we don't pay extra WASM-init/heap
  // for idle workers on a model with little parallel work — while the 8–64 MB
  // band, where there's enough geometry to amortize the workers, still scales.
  // (#1258 review P2.)
  //
  // Narrowed from 64 to 24 MB after a 10-core browser worker-count sweep: the
  // original 8-64 MB band OVER-PROVISIONED decode- and heavy-tail-bound models in
  // the 24-64 MB range. Each worker is a separate WASM instance that re-decodes
  // the file into its own heap and rebuilds the entity index, so cores-2 = 8
  // workers ran 20-30% SLOWER than 4 at ~5x the peak memory (e.g. 882 MB vs
  // 161 MB on a 54 MB model; a 34 MB heavy-tail model went 7.2s -> 5.7s at 4).
  // Genuinely small compute-bound steel (170_KM: 20 MB / ~26k boolean jobs) still
  // measurably benefits from cores-2 (17.0s vs 22.9s at 4 workers), so the fast
  // path is kept for <= 24 MB where the per-worker re-decode/memory cost is low.
  // Above 24 MB falls through to the per-core bandwidth cap below (4 on 10-core).
  const SMALL_FILE_MB = 24;
  const MIN_PARALLEL_MB = 8;
  if (fileSizeMB >= MIN_PARALLEL_MB && fileSizeMB <= SMALL_FILE_MB && cores >= 10) {
    coresCap = Math.min(maxWorkers, cores - 2);
  } else if (cores >= 16 && deviceMemoryGB >= 16) {
    // Same >512 MB bandwidth ceiling as the 12-core tier below. This was the
    // ONLY tier without the huge-file clamp, so a 16-core desktop spawned
    // cores/2 = 8 workers on an 883 MB model - each a private MVP-wasm realm
    // holding a full source copy plus its own entity index (~10.6 GB total),
    // producing the 16 GB peaks reported in #1682. Geometry wall-time on huge
    // files is memory-bandwidth bound, not core bound (the 12-core A/B sweep
    // showed a 5th/6th grinder yields no speedup), so the extra workers bought
    // nothing but memory. Users can still override per-host via `?geomWorkers=N`.
    coresCap = fileSizeMB > 512 ? 4 : Math.min(maxWorkers, Math.floor(cores / 2));
  } else if (cores >= 12 && deviceMemoryGB >= 8) {
    // 12+ cores indicates M-series Pro 12-core or M-series Max with active
    // cooling. The >512 MB cap stays 4: a `?geomWorkers` A/B sweep on a large
    // georef model showed geometry wall-time is bound by MEMORY BANDWIDTH, not
    // cores — each worker streams a file-sized WASM heap + per-mesh copy-out
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

  // Whole-tab memory budget: the most workers whose estimated tab peak (SAB,
  // main-thread tables, pre-pass instance and N full-source worker heaps)
  // fits. Fewer workers rather than an out-of-memory tab; never below one.
  const memoryCap = Math.max(1, maxWorkersWithinBudget(fileSizeMB, budgetMiB));

  // Final pick: tightest ceiling, then clamp.
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
  // Refuse only when one worker exceeds the most RAM the device can have.
  // With an unknown or possibly clamped `deviceMemory` the ceiling is
  // infinite, so the load is attempted with one worker: an uncertain
  // estimate is never grounds to block a load that might succeed.
  const exceedsDevice = minimumPeakMiB > ceilingGB * 1024;
  if (pick.value < minWorkers) return finish(minWorkers, 'min', exceedsDevice);
  return finish(pick.value, pick.reason, exceedsDevice);
}

/**
 * Convenience wrapper that returns just the integer count.
 */
export function pickWorkerCount(inputs: WorkerCountInputs): number {
  return computeWorkerCount(inputs).count;
}

/**
 * The worker count a parallel load of `fileSizeMB` uses on this host: the
 * browser's cores and memory, and a file-size proxy for the job count (the
 * memory budget keeps an over-estimate harmless). `?perf.geomMemoryGB=N`
 * (or `__IFC_LITE_GEOM_MEMORY_GB`) plans as if this were an N-GiB device whose
 * memory is known exactly, for testing the budget on a large host.
 */
export function planLoadWorkerCount(fileSizeMB: number, workerCountOverride?: number): WorkerCountResult & { cores: number } {
  const nav = typeof navigator !== 'undefined' ? navigator as Navigator & { deviceMemory?: number } : undefined;
  const cores = nav?.hardwareConcurrency ?? 2;
  const simulatedGB = readDeviceMemoryOverrideGB();
  const reported = simulatedGB ?? nav?.deviceMemory;
  const result = computeWorkerCount({
    fileSizeMB,
    cores,
    deviceMemoryGB: reported ?? 8,
    deviceMemoryCeilingGB: simulatedGB ?? deviceMemoryCeilingGB(reported),
    totalJobs: Math.max(1, Math.ceil(fileSizeMB * 100)),
    workerCountOverride,
  });
  return { ...result, cores };
}

/**
 * Refuse a load of `byteLength` source bytes up front when even one geometry
 * worker cannot fit this device (see `computeWorkerCount`'s `exceedsDevice`),
 * by throwing `GeometryMemoryBudgetError`. Opt-in for the host, called before
 * reading the file: the parallel pool itself never refuses, it only budgets
 * (the estimate can over-count unusual files, so the host decides).
 */
export function assertGeometryMemoryFits(byteLength: number, workerCountOverride?: number): void {
  const plan = planLoadWorkerCount(byteLength / (1024 * 1024), workerCountOverride);
  if (plan.exceedsDevice) throw new GeometryMemoryBudgetError(plan.minimumPeakMiB, plan.deviceCeilingMiB);
}

/** The pool's one-line plan diagnostic: binding bound, estimated peak and budget. */
export function describeWorkerPlan(plan: WorkerCountResult & { cores: number }, workerCountOverride?: number): string {
  const bound = workerCountOverride != null
    ? `(override=${workerCountOverride}, bound=${plan.reason})`
    : `(cores=${plan.cores}, bound=${plan.reason})`;
  return `${bound} tabPeakEstMiB=${Math.round(plan.estimatedPeakMiB)} tabBudgetMiB=${Math.round(plan.budgetMiB)}`
    + (plan.fitsBudget ? '' : ' (over budget)');
}
