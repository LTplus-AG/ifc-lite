/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-tab memory model for one parallel geometry load.
 *
 * Every dedicated worker lives in the page's renderer process, so the
 * process has to hold the source SAB, the main-thread and parser tables, and
 * one wasm heap per instance at the same time. Each instance holds a full
 * copy of the source: the pre-pass worker and every geometry worker
 * (`setSourceBytes`). The peak, during the geometry stream, is
 *
 *   peak(N) = FIXED + SHARED × F + (N + PREPASS) × (INSTANCE + PER_INSTANCE × F)
 *
 * with F the source size in MiB and N the geometry worker count.
 *
 * Calibration: least-squares fit to the peak summed Chrome PSS of six cold
 * loads (Chrome 156, exact kernel, `?perfMem=1`): a real 343 MB architectural
 * model at 8 workers, synthetic 1.03 GB replicas of it at 4 and 1 workers,
 * 1.74 GB at 4 and 2, 2.09 GB at 4. The model is within ±1.2 % of all six;
 * the runs at different worker counts pin the per-worker slope (≈ 0.9 × F
 * per worker removed, measured directly). The file is sparse
 * (~78 B per record). Denser files carry a larger index per byte and cost
 * more per instance, so for them the model is an UNDER-estimate. That is
 * the safe direction for the refusal below (it refuses less), and the
 * reason the refusal compares against the most RAM the device could have,
 * not against the planning budget.
 */

/** Constants of the whole-tab peak model, in MiB and MiB per MiB of source. */
export const TAB_MEMORY_MODEL = {
  /** Page, renderer and wasm-module baseline that does not scale with the file. */
  fixedMiB: 300,
  /** Source SAB (1×) + main-thread entity/metadata tables + parser-worker tables + received meshes. */
  sharedPerSourceMiB: 4.36,
  /** Per wasm instance (allocator, module state, batch working set) independent of the file. */
  perInstanceMiB: 100,
  /** Per wasm instance: its whole-source copy + its entity index + scratch, net of what the tab shares. */
  perInstancePerSourceMiB: 0.86,
  /** The pre-pass worker is one more full-source instance, alive while the geometry stream runs. */
  prepassInstances: 1,
} as const;

/** Estimated peak tab memory (MiB) for a load of `fileSizeMB` with `workers` geometry workers. */
export function estimateTabPeakMiB(fileSizeMB: number, workers: number): number {
  const f = Math.max(0, fileSizeMB);
  const instances = Math.max(0, Math.floor(workers)) + TAB_MEMORY_MODEL.prepassInstances;
  return TAB_MEMORY_MODEL.fixedMiB
    + TAB_MEMORY_MODEL.sharedPerSourceMiB * f
    + instances * (TAB_MEMORY_MODEL.perInstanceMiB + TAB_MEMORY_MODEL.perInstancePerSourceMiB * f);
}

/**
 * The memory one tab may plan to use on a device with `deviceMemoryGB` GiB:
 * everything but 25 % (at least 1 GiB) left for the OS, the browser, the GPU
 * process and other tabs. Same headroom rule the worker count used before it
 * counted the whole tab.
 */
export function tabBudgetMiB(deviceMemoryGB: number): number {
  const totalMiB = Math.max(0, deviceMemoryGB) * 1024;
  return totalMiB - Math.max(1024, totalMiB * 0.25);
}

/** Largest worker count whose estimated peak fits `budgetMiB` (0 when not even one fits). */
export function maxWorkersWithinBudget(fileSizeMB: number, budgetMiB: number): number {
  const f = Math.max(0, fileSizeMB);
  const perWorker = TAB_MEMORY_MODEL.perInstanceMiB + TAB_MEMORY_MODEL.perInstancePerSourceMiB * f;
  let n = Math.max(0, Math.floor((budgetMiB - estimateTabPeakMiB(f, 0)) / perWorker));
  // The division can land one off at an exact boundary; settle it against the estimate itself.
  if (estimateTabPeakMiB(f, n + 1) <= budgetMiB) n += 1;
  if (n > 0 && estimateTabPeakMiB(f, n) > budgetMiB) n -= 1;
  return n;
}

/**
 * The most RAM (GiB) a device reporting `navigator.deviceMemory = reported`
 * can have, or `Infinity` when the value says nothing about an upper bound.
 *
 * Chromium rounds physical memory to the NEAREST power of two and clamps it:
 * desktop to 2/4/8/16/32 since the "Update Device Memory API limits" change,
 * Android and older desktop builds to at most 8. A value below the clamp
 * therefore means less than 1.5 × reported. 8 and 32 can be clamped values
 * (an older build or Android reports 8 for a 64 GB machine), and an absent
 * value (Firefox, Safari) says nothing, so all three are unbounded: refusing
 * on them could block a load that would succeed.
 */
export function deviceMemoryCeilingGB(reported: number | undefined): number {
  if (reported === undefined || !Number.isFinite(reported) || reported <= 0) return Infinity;
  if (reported === 8 || reported >= 32) return Infinity;
  return reported * 1.5;
}

/**
 * Thrown before any byte is read or any worker spawns when even one geometry
 * worker's estimated tab peak exceeds the most memory this device can have.
 * Distinct from the 2 GiB single-allocation refusal (`WasmSourceSizeError`
 * in `@ifc-lite/parser`) and from an out-of-memory failure during a load.
 */
export class GeometryMemoryBudgetError extends RangeError {
  /** Estimated tab peak with one geometry worker, MiB. */
  readonly requiredMiB: number;
  /** The most memory the device can have, MiB. */
  readonly availableMiB: number;
  constructor(requiredMiB: number, availableMiB: number) {
    super(
      `This model needs about ${Math.ceil(requiredMiB)} MiB of memory to load in the browser; `
      + `this device has at most ${Math.floor(availableMiB)} MiB`,
    );
    this.name = 'GeometryMemoryBudgetError';
    this.requiredMiB = requiredMiB;
    this.availableMiB = availableMiB;
  }
}
