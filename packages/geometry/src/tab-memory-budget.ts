/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-tab memory for one parallel geometry load, as two deliberately
 * different estimates (F = source size in MiB, N = geometry workers):
 *
 * 1. PLANNING (conservative, picks the worker count): an upper envelope of the
 *    geometry phase, the part of the load whose memory grows with N.
 *
 *      plan(N) = 300 + 4.36 F + (N + 1) × (170 + 0.86 F)   MiB
 *
 *    Every dedicated worker lives in the page's renderer process, and every
 *    wasm instance (the pre-pass worker and each geometry worker) holds a full
 *    copy of the source, so this grows with N × F. Slopes are a least-squares
 *    fit to synthetic 1.03 / 1.74 / 2.09 GB replicas at 1, 2 and 4 workers
 *    (each worker removed saved ≈ 0.9 F); the 170 MiB per-instance term was
 *    then raised until no geometry-dominated measured load is under-predicted.
 *    Those loads are 13 cold peaks of summed Chrome PSS (Chrome 156): the
 *    replicas, real 343 MB and 177 MB models at 8 workers, and five real
 *    2–56 MB models at 8 workers. Residuals run from +1.1 % (the denser 177 MB
 *    model) to +13 % (343 MB), and up to +110 % for the 2 MB model (fixed costs).
 *
 *    NOT covered: the post-geometry peak. On real mid-size models at 1–2
 *    workers the tab peaks after geometry (≈ 2.9–3.4 GiB for the 177 and 343 MB
 *    models, measured), independent of N and not proportional to F, so the
 *    estimate is up to 43 % low there. Worker count cannot change that peak,
 *    which is why the policy keeps two workers up to 512 MiB (`worker-count.ts`).
 *    Validity: files 2 MB – 2 GB, architectural/structural content, Chrome.
 *
 * 2. REFUSAL (a strict lower bound, decides only refusal): the full source
 *    copies the chosen execution path must hold at once, and nothing else.
 *    The parallel pool holds the source buffer, the pre-pass worker's copy and
 *    at least one geometry worker's copy (3 F); the serial fallback holds the
 *    source and one wasm copy (2 F). Every measured load is far above it, so
 *    model inaccuracy can cost workers but never cause a refusal.
 */

/** Constants of the conservative planning estimate, in MiB and MiB per MiB of source. */
export const TAB_MEMORY_MODEL = {
  /** Page, renderer and wasm-module baseline that does not scale with the file. */
  fixedMiB: 300,
  /** Source SAB (1×) + main-thread entity/metadata tables + parser-worker tables + received meshes. */
  sharedPerSourceMiB: 4.36,
  /** Per wasm instance, independent of the file (raised to envelope the measured loads, see above). */
  perInstanceMiB: 170,
  /** Per wasm instance: its whole-source copy + its entity index + scratch, net of what the tab shares. */
  perInstancePerSourceMiB: 0.86,
  /** The pre-pass worker is one more full-source instance, alive while the geometry stream runs. */
  prepassInstances: 1,
} as const;

/** Full source copies each execution path holds at once (the refusal's lower bound). */
export const SOURCE_COPIES = { parallel: 3, serial: 2 } as const;

/** Conservative planning estimate (MiB) of the tab's geometry-phase peak with `workers` geometry workers. */
export function estimateTabPeakMiB(fileSizeMB: number, workers: number): number {
  const f = Number.isFinite(fileSizeMB) ? Math.max(0, fileSizeMB) : 0;
  const instances = Math.max(0, Math.floor(workers)) + TAB_MEMORY_MODEL.prepassInstances;
  return TAB_MEMORY_MODEL.fixedMiB
    + TAB_MEMORY_MODEL.sharedPerSourceMiB * f
    + instances * (TAB_MEMORY_MODEL.perInstanceMiB + TAB_MEMORY_MODEL.perInstancePerSourceMiB * f);
}

/** Strict lower bound (MiB) on what a load must hold: its full source copies on the given path. */
export function sourceCopiesFloorMiB(fileSizeMB: number, path: keyof typeof SOURCE_COPIES): number {
  const f = Number.isFinite(fileSizeMB) ? Math.max(0, fileSizeMB) : 0;
  return SOURCE_COPIES[path] * f;
}

/**
 * The memory one tab may plan to use on a device with `deviceMemoryGB` GiB:
 * everything but 25 % (at least 1 GiB) left for the OS, the browser, the GPU
 * process and other tabs. Same headroom rule the worker count used before it
 * counted the whole tab.
 */
export function tabBudgetMiB(deviceMemoryGB: number): number {
  // Clamped so the MiB arithmetic cannot overflow to Infinity − Infinity = NaN.
  const totalMiB = Number.isFinite(deviceMemoryGB) ? Math.min(Math.max(0, deviceMemoryGB), 2 ** 20) * 1024 : 0;
  return totalMiB - Math.max(1024, totalMiB * 0.25);
}

/** Largest worker count whose planning estimate fits `budgetMiB` (0 when not even one fits). */
export function maxWorkersWithinBudget(fileSizeMB: number, budgetMiB: number): number {
  if (Number.isNaN(budgetMiB)) return 0;
  if (budgetMiB === Infinity) return Infinity;
  const f = Number.isFinite(fileSizeMB) ? Math.max(0, fileSizeMB) : 0;
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
 * Chromium rounds physical memory to the NEAREST power of two (ties down) and
 * clamps it: desktop to 2–32 since the "Update Device Memory API limits"
 * change, Android to 1–8, older builds to at most 8. An unclamped reading v
 * therefore means at most 1.5 v. 8 and 32+ can be clamped values (an older
 * build or Android reports 8 for a 64 GB machine), and an absent value
 * (Firefox, Safari) says nothing, so all three are unbounded: refusing on
 * them could block a load that would succeed. This is Chromium policy, not
 * a hardware proof; spoofed values defeat it.
 */
export function deviceMemoryCeilingGB(reported: number | undefined): number {
  if (reported === undefined || !Number.isFinite(reported) || reported <= 0) return Infinity;
  if (reported === 8 || reported >= 32) return Infinity;
  return reported * 1.5;
}

/**
 * The refusal: even the strict lower bound of this load (its full source
 * copies on the path that will run) exceeds the most memory the device can
 * have. Distinct from the 2 GiB single-allocation refusal (`WasmSourceSizeError`
 * in `@ifc-lite/parser`) and from an out-of-memory failure during a load.
 */
export class GeometryMemoryBudgetError extends RangeError {
  /** Lower bound on what the load must hold, MiB. */
  readonly requiredMiB: number;
  /** The most memory the device can have, MiB. */
  readonly availableMiB: number;
  constructor(requiredMiB: number, availableMiB: number) {
    super(
      `This model needs at least ${Math.ceil(requiredMiB)} MiB of memory to load in the browser; `
      + `this device reports at most ${Math.floor(availableMiB)} MiB`,
    );
    this.name = 'GeometryMemoryBudgetError';
    this.requiredMiB = requiredMiB;
    this.availableMiB = availableMiB;
  }
}
