/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-tab memory budget for the geometry worker count (huge-file stage 1,
 * #9659). Both estimates and their calibration are in `tab-memory-budget.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGeometryMemoryFits,
  computeWorkerCount,
  GeometryMemoryBudgetError,
  planLoadWorkerCount,
  type WorkerCountResult,
} from './worker-count.js';
import {
  deviceMemoryCeilingGB,
  estimateTabPeakMiB,
  maxWorkersWithinBudget,
  sourceCopiesFloorMiB,
  TAB_MEMORY_MODEL,
  tabBudgetMiB,
} from './tab-memory-budget.js';

const GIB = 1024 ** 3;
const SIMULATED = '__IFC_LITE_GEOM_MEMORY_GB';

function plan(fileSizeMB: number, cores: number, reportedGB: number | undefined) {
  return computeWorkerCount({
    fileSizeMB, cores,
    deviceMemoryGB: reportedGB ?? 8,
    deviceMemoryCeilingGB: deviceMemoryCeilingGB(reportedGB),
    totalJobs: Math.ceil(fileSizeMB * 100),
  });
}

function browser(nav: Record<string, unknown>, parallel: boolean): void {
  vi.stubGlobal('navigator', nav);
  vi.stubGlobal('Worker', parallel ? class {} : undefined);
  vi.stubGlobal('SharedArrayBuffer', parallel ? ArrayBuffer : undefined);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>)[SIMULATED];
  Reflect.deleteProperty(globalThis, 'location');
});

// Every measured cold load: peak summed Chrome PSS (MiB), Chrome 156, exact
// kernel, Pop, 2026-11-10 (stage 0, the huge-file study, stage-1 evidence and
// the real-model calibration). F in MiB (bytes / 2^20).
const GEOMETRY_PHASE: Array<[name: string, fileMiB: number, workers: number, peakMiB: number]> = [
  ['1.03 GB replica', 985.7, 4, 9219], ['1.03 GB replica', 985.7, 1, 6523],
  ['1.74 GB replica', 1655.2, 4, 15040], ['1.74 GB replica', 1655.2, 2, 12045],
  ['2.09 GB replica', 1990.0, 4, 18136],
  ['real 343 MB', 326.78, 8, 5189], ['real 343 MB', 326.78, 8, 5120],
  ['real 177 MB', 169.24, 8, 3834],
  ['real 2.4 MB', 2.41, 8, 884], ['real 11 MB', 11.47, 8, 1041], ['real 34 MB', 33.67, 8, 1374],
  ['real 47 MB', 47.0, 8, 1493], ['real 54 MB', 53.75, 8, 1679],
];
// Real mid-size models at 1–2 workers peak AFTER geometry, independent of N.
const POST_GEOMETRY: Array<[name: string, fileMiB: number, workers: number, peakMiB: number]> = [
  ['real 343 MB', 326.78, 1, 3237], ['real 343 MB', 326.78, 2, 3015],
  ['real 177 MB', 169.24, 1, 2931], ['real 177 MB', 169.24, 2, 3081],
];

describe('planning estimate (conservative)', () => {
  it('never under-predicts a measured geometry-dominated load, synthetic or real', () => {
    for (const [name, f, n, peak] of GEOMETRY_PHASE) {
      expect(estimateTabPeakMiB(f, n), `${name} @${n}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it('stays within +15 % on the huge replicas and the real 343 MB model, where budgets bind', () => {
    for (const [name, f, n, peak] of GEOMETRY_PHASE.filter(([, f]) => f >= 300)) {
      expect(estimateTabPeakMiB(f, n) / peak, `${name} @${n}`).toBeLessThan(1.15);
    }
  });

  it('is documented as NOT covering the post-geometry peak of real mid-size models at 1–2 workers', () => {
    for (const [name, f, n, peak] of POST_GEOMETRY) {
      expect(estimateTabPeakMiB(f, n), `${name} @${n}`).toBeLessThan(peak * 1.05);
    }
  });

  it('counts the pre-pass worker as one more full-source instance', () => {
    const f = 1000;
    const perInstance = TAB_MEMORY_MODEL.perInstanceMiB + TAB_MEMORY_MODEL.perInstancePerSourceMiB * f;
    expect(estimateTabPeakMiB(f, 0)).toBeCloseTo(
      TAB_MEMORY_MODEL.fixedMiB + TAB_MEMORY_MODEL.sharedPerSourceMiB * f + perInstance, 6);
    expect(estimateTabPeakMiB(f, 4) - estimateTabPeakMiB(f, 3)).toBeCloseTo(perInstance, 6);
  });

  it('maxWorkersWithinBudget is exact at the boundary and safe at the extremes', () => {
    const f = 986;
    const at3 = estimateTabPeakMiB(f, 3);
    expect(maxWorkersWithinBudget(f, at3)).toBe(3);
    expect(maxWorkersWithinBudget(f, at3 - 0.001)).toBe(2);
    expect(maxWorkersWithinBudget(f, estimateTabPeakMiB(f, 1) - 1)).toBe(0);
    expect(maxWorkersWithinBudget(f, Number.NaN)).toBe(0);
    expect(maxWorkersWithinBudget(f, Infinity)).toBe(Infinity);
  });

  it('keeps the old headroom rule for the budget (25 %, at least 1 GiB) and never returns NaN', () => {
    expect(tabBudgetMiB(4)).toBe(3072);
    expect(tabBudgetMiB(16)).toBe(12288);
    expect(Number.isNaN(tabBudgetMiB(Number.MAX_VALUE))).toBe(false);
    expect(Number.isNaN(tabBudgetMiB(Number.NaN))).toBe(false);
  });
});

describe('refusal floor (strict lower bound)', () => {
  it('is the full source copies of the path, far below every measured load', () => {
    expect(sourceCopiesFloorMiB(1000, 'parallel')).toBe(3000);
    expect(sourceCopiesFloorMiB(1000, 'serial')).toBe(2000);
    for (const [name, f, n, peak] of [...GEOMETRY_PHASE, ...POST_GEOMETRY]) {
      expect(sourceCopiesFloorMiB(f, 'parallel'), `${name} @${n}`).toBeLessThan(peak);
    }
  });
});

describe('deviceMemoryCeilingGB', () => {
  it('bounds values below the browser clamp by the nearest-power-of-two bucket', () => {
    expect(deviceMemoryCeilingGB(0.5)).toBe(0.75);
    expect(deviceMemoryCeilingGB(2)).toBe(3);
    expect(deviceMemoryCeilingGB(4)).toBe(6);
    expect(deviceMemoryCeilingGB(16)).toBe(24);
  });

  it('treats values that can be clamped (8, 32+) and absent values as unbounded', () => {
    for (const v of [8, 32, 64, undefined, Number.NaN, 0, -2]) expect(deviceMemoryCeilingGB(v)).toBe(Infinity);
  });
});

describe('worker count: unchanged where it already fits, fewer where it does not', () => {
  // Rows: [host, cores, reported deviceMemory]; values are the counts on main
  // (before) and with the tab budget (after). Every cell that changes has
  // before > after and estimate(before) > budget (also checked exhaustively
  // over 179,456 cases against main's function in the PR).
  const SIZES = [5, 20, 54, 100, 200, 343, 400, 512, 722, 986, 1200, 1655, 1990];
  const TABLE: Array<[string, number, number | undefined, number[], number[]]> = [
    ['4c / 2 GB', 4, 2, [2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1], [2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ['4c / 4 GB', 4, 4, [2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1]],
    ['8c / 8 GB', 8, 8, [3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1, 1], [3, 3, 3, 3, 3, 3, 3, 3, 2, 1, 1, 1, 1]],
    ['10c / 16 GB', 10, 16, [4, 8, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2], [4, 8, 4, 4, 4, 4, 4, 4, 3, 3, 3, 1, 1]],
    ['16c / 16 GB', 16, 16, [8, 8, 8, 8, 8, 8, 8, 8, 4, 4, 4, 3, 2], [8, 8, 8, 8, 8, 8, 8, 8, 4, 4, 4, 1, 1]],
    ['16c / 32 GB', 16, 32, [8, 8, 8, 8, 8, 8, 8, 8, 4, 4, 4, 4, 4], [8, 8, 8, 8, 8, 8, 8, 8, 4, 4, 4, 4, 4]],
    ['8c / unknown', 8, undefined, [3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1, 1], [3, 3, 3, 3, 3, 3, 3, 3, 2, 1, 1, 1, 1]],
    ['10c / unknown', 10, undefined, [4, 8, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2], [4, 8, 4, 4, 4, 4, 4, 4, 3, 3, 3, 1, 1]],
  ];

  for (const [host, cores, reported, before, after] of TABLE) {
    it(`${host}: ${SIZES.map((f, i) => `${f}MB→${after[i]}`).join(' ')}`, () => {
      SIZES.forEach((f, i) => {
        const r = plan(f, cores, reported);
        expect({ f, count: r.count }).toEqual({ f, count: after[i] });
        if (after[i] !== before[i]) {
          expect(after[i]).toBeLessThan(before[i]);
          expect(estimateTabPeakMiB(f, before[i])).toBeGreaterThan(r.budgetMiB);
          expect(r.reason).toBe('memory');
        }
      });
    });
  }

  it('up to 512 MiB the budget keeps two workers that fit the whole device (real-model measurement)', () => {
    // Real 343 MB model, forced counts: peak 3237 MiB at 1 worker vs 3015 at 2;
    // real 177 MB model: 2931 vs 3081, but 38 s vs 15 s to interactive.
    const fits = plan(400, 4, 4);
    expect(estimateTabPeakMiB(400, 2)).toBeGreaterThan(fits.budgetMiB);
    expect(fits.count).toBe(2);
    expect(plan(300, 4, 2).count).toBe(1); // below 4 GiB: no floor
    expect(plan(512, 4, 4).count).toBe(1); // two would not fit the whole device
    expect(plan(600, 8, 4).count).toBe(1); // above 512 MiB the geometry phase sets the peak
  });
});

describe('the exported result type is unchanged (review finding 4)', () => {
  it('an old-style WorkerCountResult stub and an exhaustive reason switch still type-check', () => {
    const stub: WorkerCountResult = { count: 1, reason: 'cores' };
    const reason = (r: WorkerCountResult): 'cores' | 'memory' | 'jobs' | 'min' | 'max' => r.reason;
    expect(reason(stub)).toBe('cores');
    expect(reason(plan(1990, 16, 16))).toBe('memory');
  });
});

describe('override (review finding 2)', () => {
  it('a plain (remembered) override keeps the old semantics: the memory budget clips it', () => {
    const r = computeWorkerCount({
      fileSizeMB: 1900, cores: 4, deviceMemoryGB: 4, deviceMemoryCeilingGB: 6, totalJobs: 190_000,
      workerCountOverride: 8,
    });
    expect(r).toMatchObject({ count: 1, reason: 'memory' });
  });

  it('an explicit beyond-budget request may spend the headroom but not plan past the whole device', () => {
    // Worst case without the clamp: 8 workers on 2048 MiB.
    expect(estimateTabPeakMiB(2048, 8)).toBeGreaterThan(26_000);
    const laptop = computeWorkerCount({
      fileSizeMB: 2048, cores: 16, deviceMemoryGB: 16, totalJobs: 100_000,
      workerCountOverride: { count: 8, beyondBudget: true },
    });
    expect(laptop).toMatchObject({ count: 2, reason: 'memory' }); // 2 ≈ 15.0 GiB, 3 ≈ 16.6 GiB > 16 GiB
    expect(laptop.estimatedPeakMiB).toBeLessThanOrEqual(16 * 1024);
    const desktop = computeWorkerCount({
      fileSizeMB: 2048, cores: 16, deviceMemoryGB: 32, totalJobs: 100_000,
      workerCountOverride: { count: 8, beyondBudget: true },
    });
    expect(desktop).toMatchObject({ count: 8, reason: 'cores', fitsBudget: false });
    expect(desktop.estimatedPeakMiB).toBeLessThanOrEqual(32 * 1024);
    // A plain override of the same count on the same desktop stays inside the budget.
    const remembered = computeWorkerCount({
      fileSizeMB: 2048, cores: 16, deviceMemoryGB: 32, totalJobs: 100_000, workerCountOverride: 8,
    });
    expect(remembered.fitsBudget).toBe(true);
  });

  it('an override can still dial the count down, and wins over the cores tier', () => {
    expect(plan(722, 10, 16).count).toBe(3);
    const down = computeWorkerCount({ fileSizeMB: 722, cores: 10, deviceMemoryGB: 16, totalJobs: 70_000, workerCountOverride: 1 });
    expect(down.count).toBe(1);
    const up = computeWorkerCount({ fileSizeMB: 722, cores: 10, deviceMemoryGB: 16, totalJobs: 70_000, workerCountOverride: 6 });
    expect(up.count).toBe(6);
  });
});

describe('non-finite and overflowing inputs (review finding 5)', () => {
  it('a non-finite, non-positive or overflowing deviceMemory never yields a NaN budget that drops the cap', () => {
    const unknown = plan(1655, 16, undefined);
    for (const deviceMemoryGB of [Infinity, Number.NaN, -1, 0, Number.MAX_VALUE, 1e308]) {
      const r = computeWorkerCount({ fileSizeMB: 1655, cores: 16, deviceMemoryGB, totalJobs: 100_000 });
      expect(Number.isFinite(r.budgetMiB), String(deviceMemoryGB)).toBe(true);
      expect(Number.isInteger(r.count)).toBe(true);
    }
    expect(unknown.count).toBe(1);
  });

  it('a negative or non-finite ceiling is unknown, never a negative "available"', () => {
    for (const deviceMemoryCeilingGB of [-1, -Infinity, Number.NaN, 0]) {
      const r = computeWorkerCount({ fileSizeMB: 1900, cores: 4, deviceMemoryGB: 4, deviceMemoryCeilingGB, totalJobs: 1 });
      expect(r.deviceCeilingMiB).toBe(Infinity);
      expect(r.exceedsDevice).toBe(false);
    }
  });

  it('NaN or infinite cores, job count and bounds never yield a NaN count (never below one)', () => {
    const cases: Array<Partial<Parameters<typeof computeWorkerCount>[0]>> = [
      { cores: Number.NaN }, { cores: Infinity }, { totalJobs: Number.NaN },
      { minWorkers: Number.NaN }, { maxWorkers: Number.NaN }, { minWorkers: Infinity }, { maxWorkers: Infinity },
    ];
    for (const extra of cases) {
      const r = computeWorkerCount({ fileSizeMB: 500, cores: 8, deviceMemoryGB: 8, totalJobs: 50_000, ...extra });
      expect(Number.isInteger(r.count), JSON.stringify(extra)).toBe(true);
      expect(r.count).toBeGreaterThanOrEqual(1);
      expect(r.count).toBeLessThanOrEqual(8);
    }
    expect(computeWorkerCount({ fileSizeMB: Number.NaN, cores: 8, deviceMemoryGB: 8, totalJobs: 10 }).count).toBe(3);
  });
});

describe('refusal: only on the strict floor of the path that will run (review findings 1 and 3)', () => {
  it('refuses the parallel pool when 3 × source exceeds the reading, but not the serial fallback at 2 ×', () => {
    // Reading 1 GB ⇒ at most 1.5 GiB. 600 MiB: parallel floor 1800 > 1536, serial floor 1200 ≤ 1536.
    browser({ hardwareConcurrency: 8, deviceMemory: 1 }, true);
    expect(() => assertGeometryMemoryFits(600 * 1024 ** 2)).toThrow(GeometryMemoryBudgetError);
    browser({ hardwareConcurrency: 8, deviceMemory: 1 }, false);
    expect(() => assertGeometryMemoryFits(600 * 1024 ** 2)).not.toThrow();
    browser({ hardwareConcurrency: 1, deviceMemory: 1 }, true); // one core: processAdaptive streams serially
    expect(() => assertGeometryMemoryFits(600 * 1024 ** 2)).not.toThrow();
  });

  it('does not refuse where the old 1-worker estimate did (929 MiB on a 4 GB reading)', () => {
    browser({ hardwareConcurrency: 4, deviceMemory: 4 }, true);
    expect(() => assertGeometryMemoryFits(929 * 1024 ** 2)).not.toThrow();
    expect(() => assertGeometryMemoryFits(2047 * 1024 ** 2)).not.toThrow(); // 3 × 2047 MiB ≤ 6 GiB
  });

  it('reports the floor and the reading, not the planning estimate', () => {
    browser({ hardwareConcurrency: 8, deviceMemory: 2 }, true);
    let caught: unknown;
    try { assertGeometryMemoryFits(1.5 * GIB); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(GeometryMemoryBudgetError);
    expect((caught as GeometryMemoryBudgetError).requiredMiB).toBe(3 * 1536);
    expect((caught as GeometryMemoryBudgetError).availableMiB).toBe(3 * 1024);
  });

  it('never refuses when deviceMemory is missing or possibly clamped', () => {
    for (const deviceMemory of [undefined, 8, 32]) {
      browser({ hardwareConcurrency: 8, deviceMemory }, true);
      expect(() => assertGeometryMemoryFits(2047 * 1024 ** 2)).not.toThrow();
    }
  });

  it('the memory simulation cannot refuse, cannot raise the budget, and only lowers the count', () => {
    browser({ hardwareConcurrency: 32, deviceMemory: 32 }, true);
    Object.defineProperty(globalThis, 'location', { value: { search: '?perf.geomMemoryGB=0.001' }, configurable: true });
    expect(() => assertGeometryMemoryFits(1024 ** 2)).not.toThrow();
    expect(() => assertGeometryMemoryFits(1.9 * GIB)).not.toThrow();
    expect(planLoadWorkerCount(986).count).toBe(1);
    (globalThis as Record<string, unknown>)[SIMULATED] = 8;
    expect(planLoadWorkerCount(986)).toMatchObject({ count: 1, budgetMiB: 6144 });
    // On a real 4 GB reading, a 64 GiB simulation does not lift the budget.
    browser({ hardwareConcurrency: 4, deviceMemory: 4 }, true);
    (globalThis as Record<string, unknown>)[SIMULATED] = 64;
    expect(planLoadWorkerCount(986).budgetMiB).toBe(3072);
    // Out-of-range values are ignored.
    browser({ hardwareConcurrency: 32, deviceMemory: 32 }, true);
    (globalThis as Record<string, unknown>)[SIMULATED] = 1e308;
    expect(planLoadWorkerCount(986)).toMatchObject({ count: 4, budgetMiB: 24576 });
  });
});
