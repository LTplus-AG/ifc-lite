/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry worker count, budgeted by the memory of the whole tab.
 *
 * Every dedicated worker shares the page's renderer process, and every wasm
 * instance (the pre-pass worker and each geometry worker) holds a full copy
 * of the source, so the tab's peak grows as workers × file size
 * (`tab-memory-budget.ts` has both estimates and their calibration). The
 * count is the cores/thermal tier below, lowered to the largest N whose
 * conservative estimate fits the device's budget, never below one. Refusal is
 * a separate, strict lower bound: only when even the source copies the chosen
 * path must hold exceed the most memory the device can have
 * (`assertGeometryMemoryFits`, opt-in for the host).
 */

import { readDeviceMemoryOverrideGB } from './perf-flags.js';
import {
  deviceMemoryCeilingGB,
  estimateTabPeakMiB,
  GeometryMemoryBudgetError,
  maxWorkersWithinBudget,
  sourceCopiesFloorMiB,
  tabBudgetMiB,
} from './tab-memory-budget.js';

export { GeometryMemoryBudgetError };

/** Largest device memory (GiB) taken at face value; beyond it MiB arithmetic stops being meaningful. */
const MAX_PLAUSIBLE_MEMORY_GB = 1 << 20;
/** Files up to this size keep at least two workers under the memory budget (see `computeWorkerCount`). */
const MID_SIZE_FLOOR_MB = 512;

/**
 * An explicit worker count. A plain number keeps the long-standing semantics:
 * the memory budget still clips it (a value saved in localStorage months ago
 * must not lift memory protection). `{ count, beyondBudget: true }` is a fresh,
 * deliberate request (the viewer passes it only for `?geomWorkers=N` in the
 * current page URL): it may spend the budget's 25 % headroom, but is still
 * clamped to the most workers that fit the whole device (never below one).
 */
export type WorkerCountOverride = number | { count: number; beyondBudget: true };

export interface WorkerCountInputs {
  /** File size in megabytes (MiB). */
  fileSizeMB: number;
  /** `navigator.hardwareConcurrency`, 1+. */
  cores: number;
  /**
   * Device memory in GiB: `navigator.deviceMemory`, or 8 when the browser does
   * not expose it (Firefox, Safari). On 10+ cores the tiers and the budget lift
   * it to at least 16, because a clamped 8 on such a machine is in practice 16
   * GB or more; the budget never lifts it above `deviceMemoryCeilingGB`.
   */
  deviceMemoryGB: number;
  /**
   * The most RAM (GiB) the device can have (`deviceMemoryCeilingGB` of the
   * reported value). Undefined, non-finite or non-positive ⇒ unknown: the
   * load is then never refused, only budgeted.
   */
  deviceMemoryCeilingGB?: number;
  /** Plan the budget as if the device had at most this many GiB (diagnostic simulation; lowers only). */
  planningMemoryCapGB?: number;
  /** Total geometry jobs the pre-pass discovered. Workers can't exceed this. */
  totalJobs: number;
  /** Lower bound on workers when there are jobs. Defaults to 1. */
  minWorkers?: number;
  /** Upper bound on workers regardless of resources. Defaults to 8. */
  maxWorkers?: number;
  /** Explicit worker count (the viewer's `?geomWorkers=N` A/B knob); see `WorkerCountOverride`. */
  workerCountOverride?: WorkerCountOverride;
}

export interface WorkerCountResult {
  count: number;
  /** For diagnostics: which constraint was binding. */
  reason: 'cores' | 'memory' | 'jobs' | 'min' | 'max';
}

/** `computeWorkerCount`'s result with the memory plan it was chosen from. */
export interface WorkerCountPlan extends WorkerCountResult {
  /** Conservative estimate of the tab's geometry-phase peak (MiB) at `count` workers. */
  estimatedPeakMiB: number;
  /** The tab budget (MiB) the count was planned against. */
  budgetMiB: number;
  /** Whether `estimatedPeakMiB` is within `budgetMiB`. */
  fitsBudget: boolean;
  /** Lower bound (MiB) on what the parallel pool must hold: its full source copies. */
  floorMiB: number;
  /** The most memory the device can have, MiB (`Infinity` when unknown). */
  deviceCeilingMiB: number;
  /** `floorMiB` exceeds `deviceCeilingMiB`: a host may refuse (`assertGeometryMemoryFits`). */
  exceedsDevice: boolean;
}

/**
 * Returns the number of parallel geometry workers to spawn for a given file
 * and host capability. Pure function. All inputs validated, result clamped to
 * `[minWorkers, maxWorkers]` when there are jobs.
 */
export function computeWorkerCount(inputs: WorkerCountInputs): WorkerCountPlan {
  // NaN loses every comparison, so a NaN input would silently drop a cap or return NaN: replace non-finite inputs first.
  const fileSizeMB = Number.isFinite(inputs.fileSizeMB) ? Math.max(0, inputs.fileSizeMB) : 0;
  const cores = Number.isFinite(inputs.cores) ? Math.max(1, Math.floor(inputs.cores)) : 1;
  const positiveGB = (v: number | undefined): number | undefined =>
    v !== undefined && Number.isFinite(v) && v > 0 ? Math.min(v, MAX_PLAUSIBLE_MEMORY_GB) : undefined;
  const ceilingGB = positiveGB(inputs.deviceMemoryCeilingGB) ?? Infinity;
  // A non-finite or non-positive value is treated as unknown: the documented 8.
  const reportedMemoryGB = Math.max(1, positiveGB(inputs.deviceMemoryGB) ?? 8);
  // `navigator.deviceMemory` is clamped (8 on older Chrome and Android) as a
  // fingerprinting mitigation. When cores indicates a Pro/Max-tier machine
  // (10+) we know in practice it ships with ≥16 GB, so we lift the floor for
  // the cores tiers. The memory budget uses the same lift, but never above
  // what the reported value proves the device can have, nor above a simulation cap.
  const deviceMemoryGB = cores >= 10 ? Math.max(reportedMemoryGB, 16) : reportedMemoryGB;
  const planningMemoryGB = Math.min(
    deviceMemoryGB, Math.max(reportedMemoryGB, ceilingGB), positiveGB(inputs.planningMemoryCapGB) ?? Infinity,
  );
  // An unknown (NaN) job count does not bind; the other ceilings decide.
  const totalJobs = Number.isNaN(inputs.totalJobs) ? Infinity : Math.max(0, Math.floor(inputs.totalJobs));
  const minWorkers = Number.isFinite(inputs.minWorkers) ? Math.max(1, Math.floor(inputs.minWorkers ?? 1)) : 1;
  const maxWorkers = Number.isFinite(inputs.maxWorkers) ? Math.max(minWorkers, Math.floor(inputs.maxWorkers ?? 8)) : Math.max(minWorkers, 8);

  const budgetMiB = tabBudgetMiB(planningMemoryGB);
  const floorMiB = sourceCopiesFloorMiB(fileSizeMB, 'parallel');
  // Refuse only on the strict lower bound (source copies), never on the
  // conservative planning estimate: inaccuracy may cost workers, never a load.
  const exceedsDevice = floorMiB > ceilingGB * 1024;
  const finish = (count: number, reason: WorkerCountResult['reason']): WorkerCountPlan => {
    const estimatedPeakMiB = estimateTabPeakMiB(fileSizeMB, count);
    return {
      count, reason, estimatedPeakMiB, budgetMiB, fitsBudget: estimatedPeakMiB <= budgetMiB,
      floorMiB, deviceCeilingMiB: ceilingGB * 1024, exceedsDevice,
    };
  };

  if (totalJobs === 0) {
    // No jobs → no workers. Spawning even one worker pays for a
    // ~250ms WASM compile that has nothing to do; the docstring's
    // non-zero guarantee is scoped to "when there are jobs to do."
    return finish(0, 'jobs');
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

  // Whole-tab memory budget: the most workers whose conservative estimate
  // (SAB, main-thread tables, pre-pass instance and N full-source worker
  // heaps) fits. Fewer workers rather than an out-of-memory tab; never below one.
  // Up to 512 MiB the budget never takes the count below 2 when two workers fit
  // the whole device. Measured on real 177 / 343 MB models: at 1–2 workers the
  // tab peak (~2.9–3.2 GiB) comes AFTER geometry and does not depend on the
  // worker count (343 MB: 3237 MiB at 1 worker vs 3015 at 2), while one worker
  // cost up to 2.5× the load time. Above 512 MiB the geometry phase sets the
  // peak (1.03 GB: 9.2 GiB during geometry, 3.35 after), so the trade is real.
  // Below 4 GiB that post-geometry peak alone fills the device, so no floor there.
  const twoFitDevice = planningMemoryGB >= 4 && estimateTabPeakMiB(fileSizeMB, 2) <= planningMemoryGB * 1024;
  const memoryFloor = fileSizeMB <= MID_SIZE_FLOOR_MB && twoFitDevice ? Math.min(2, coresCap) : 1;
  const memoryCap = Math.max(memoryFloor, maxWorkersWithinBudget(fileSizeMB, budgetMiB));

  // Explicit host override (A/B tuning, field debugging): wins over the cores
  // tier. A plain number is still clipped by the memory budget, as it always
  // was; `beyondBudget` (fresh URL request) only by the whole device. The job
  // count and the hard bounds clip both; `reason` names the bound that did.
  const override = inputs.workerCountOverride;
  const overrideCount = typeof override === 'number' ? override : override?.count;
  if (overrideCount != null && Number.isFinite(overrideCount)) {
    let count = Math.max(1, Math.floor(overrideCount));
    let reason: WorkerCountResult['reason'] = 'cores'; // honouring the override
    const memoryBound = typeof override === 'object' && override.beyondBudget
      ? Math.max(1, maxWorkersWithinBudget(fileSizeMB, planningMemoryGB * 1024))
      : memoryCap;
    if (memoryBound < count) {
      count = memoryBound;
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
      count = minWorkers;
      reason = 'min';
    }
    return finish(count, reason);
  }

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
  if (pick.value < minWorkers) return finish(minWorkers, 'min');
  return finish(pick.value, pick.reason);
}

/**
 * Convenience wrapper that returns just the integer count.
 */
export function pickWorkerCount(inputs: WorkerCountInputs): number {
  return computeWorkerCount(inputs).count;
}

/** Whether `processAdaptive` can run the parallel worker pool in this realm (else it streams serially). */
export function parallelPoolAvailable(): boolean {
  return typeof SharedArrayBuffer !== 'undefined'
    && typeof Worker !== 'undefined'
    && typeof navigator !== 'undefined'
    && (navigator.hardwareConcurrency ?? 1) > 1;
}

function browserDeviceMemoryGB(): number | undefined {
  const nav = typeof navigator !== 'undefined' ? navigator as Navigator & { deviceMemory?: number } : undefined;
  return nav?.deviceMemory;
}

/**
 * The worker count a parallel load of `fileSizeMB` uses on this host: the
 * browser's cores and memory, and a file-size proxy for the job count (the
 * memory budget keeps an over-estimate harmless). `?perf.geomMemoryGB=N`
 * (or `__IFC_LITE_GEOM_MEMORY_GB`) caps the planning memory at N GiB to
 * reproduce a small device on a large host. It can only LOWER the count:
 * it never raises the budget and never changes the refusal ceiling.
 */
export function planLoadWorkerCount(fileSizeMB: number, workerCountOverride?: WorkerCountOverride): WorkerCountPlan & { cores: number } {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2;
  const reported = browserDeviceMemoryGB();
  const result = computeWorkerCount({
    fileSizeMB,
    cores,
    deviceMemoryGB: reported ?? 8,
    deviceMemoryCeilingGB: deviceMemoryCeilingGB(reported),
    planningMemoryCapGB: readDeviceMemoryOverrideGB(),
    totalJobs: Math.max(1, Math.ceil(fileSizeMB * 100)),
    workerCountOverride,
  });
  return { ...result, cores };
}

/**
 * Refuse a load of `byteLength` source bytes up front by throwing
 * `GeometryMemoryBudgetError` when even the source copies of the path that will
 * run (`parallelPoolAvailable()`: 3 × source for the worker pool, 2 × for the
 * serial fallback) exceed the most memory the browser's `deviceMemory` reading
 * allows. A strict lower bound against a reported ceiling: never decided by the
 * planning estimate, never by the memory simulation. Opt-in for the host,
 * called before reading the file; the pool itself never refuses.
 */
export function assertGeometryMemoryFits(byteLength: number): void {
  const fileSizeMB = Number.isFinite(byteLength) ? Math.max(0, byteLength) / (1024 * 1024) : 0;
  const ceilingMiB = deviceMemoryCeilingGB(browserDeviceMemoryGB()) * 1024;
  const floorMiB = sourceCopiesFloorMiB(fileSizeMB, parallelPoolAvailable() ? 'parallel' : 'serial');
  if (floorMiB > ceilingMiB) throw new GeometryMemoryBudgetError(floorMiB, ceilingMiB);
}

/** The pool's one-line plan diagnostic: binding bound, estimated peak and budget. */
export function describeWorkerPlan(plan: WorkerCountPlan & { cores: number }, workerCountOverride?: WorkerCountOverride): string {
  const requested = typeof workerCountOverride === 'object' ? `${workerCountOverride.count}, beyond budget` : workerCountOverride;
  const bound = requested != null
    ? `(override=${requested}, bound=${plan.reason})`
    : `(cores=${plan.cores}, bound=${plan.reason})`;
  return `${bound} tabPeakEstMiB=${Math.round(plan.estimatedPeakMiB)} tabBudgetMiB=${Math.round(plan.budgetMiB)}`
    + (plan.fitsBudget ? '' : ' (over budget)');
}
