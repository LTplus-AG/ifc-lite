/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-tab memory budget for the geometry worker count (huge-file stage 1).
 * The model and its calibration are in `tab-memory-budget.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGeometryMemoryFits,
  computeWorkerCount,
  GeometryMemoryBudgetError,
  planLoadWorkerCount,
} from './worker-count.js';
import {
  deviceMemoryCeilingGB,
  estimateTabPeakMiB,
  maxWorkersWithinBudget,
  TAB_MEMORY_MODEL,
  tabBudgetMiB,
} from './tab-memory-budget.js';

const GIB = 1024 ** 3;

function plan(fileSizeMB: number, cores: number, reportedGB: number | undefined) {
  return computeWorkerCount({
    fileSizeMB, cores,
    deviceMemoryGB: reportedGB ?? 8,
    deviceMemoryCeilingGB: deviceMemoryCeilingGB(reportedGB),
    totalJobs: Math.ceil(fileSizeMB * 100),
  });
}

describe('whole-tab peak model', () => {
  it('reproduces the six measured cold loads it was fitted to within ±2 %', () => {
    // Peak summed Chrome PSS, Chrome 156, exact kernel, Pop (huge-file study
    // and stage-1 evidence, 2026-11-10): real 343 MB model at 8 workers;
    // 1.03 GB replica at 4 and 1, 1.74 GB at 4 and 2, 2.09 GB at 4 workers.
    const measured: Array<[fileMiB: number, workers: number, peakMiB: number]> = [
      [342_657_851 / 2 ** 20, 8, 5189],
      [985.7, 4, 9219],
      [985.7, 1, 6523],
      [1655.2, 4, 15040],
      [1655.2, 2, 12045],
      [1990.0, 4, 18136],
    ];
    for (const [f, n, peak] of measured) {
      const ratio = estimateTabPeakMiB(f, n) / peak;
      expect(ratio).toBeGreaterThan(0.98);
      expect(ratio).toBeLessThan(1.02);
    }
  });

  it('counts the pre-pass worker as one more full-source instance', () => {
    const f = 1000;
    const perInstance = TAB_MEMORY_MODEL.perInstanceMiB + TAB_MEMORY_MODEL.perInstancePerSourceMiB * f;
    expect(estimateTabPeakMiB(f, 0)).toBeCloseTo(
      TAB_MEMORY_MODEL.fixedMiB + TAB_MEMORY_MODEL.sharedPerSourceMiB * f + perInstance, 6);
    expect(estimateTabPeakMiB(f, 4) - estimateTabPeakMiB(f, 3)).toBeCloseTo(perInstance, 6);
  });

  it('maxWorkersWithinBudget is exact at the boundary', () => {
    const f = 986;
    const at3 = estimateTabPeakMiB(f, 3);
    expect(maxWorkersWithinBudget(f, at3)).toBe(3);
    expect(maxWorkersWithinBudget(f, at3 - 0.001)).toBe(2);
    expect(maxWorkersWithinBudget(f, estimateTabPeakMiB(f, 1) - 1)).toBe(0);
  });

  it('keeps the old headroom rule for the budget (25 %, at least 1 GiB)', () => {
    expect(tabBudgetMiB(4)).toBe(3072);
    expect(tabBudgetMiB(16)).toBe(12288);
    expect(tabBudgetMiB(32)).toBe(24576);
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
    expect(deviceMemoryCeilingGB(8)).toBe(Infinity);
    expect(deviceMemoryCeilingGB(32)).toBe(Infinity);
    expect(deviceMemoryCeilingGB(undefined)).toBe(Infinity);
    expect(deviceMemoryCeilingGB(Number.NaN)).toBe(Infinity);
    expect(deviceMemoryCeilingGB(0)).toBe(Infinity);
  });
});

describe('worker count: unchanged where it already fits, fewer where it does not', () => {
  // Rows: [host, cores, reported deviceMemory]; columns: file MB. Values are
  // the counts on main (before) and with the tab budget (after). Every cell
  // that changes has before > after and estimate(before) > budget.
  const SIZES = [5, 20, 54, 100, 200, 343, 400, 512, 722, 986, 1200, 1655, 1990];
  const TABLE: Array<[string, number, number | undefined, number[], number[]]> = [
    ['4c / 4 GB', 4, 4, [2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1], [2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1]],
    ['8c / 8 GB', 8, 8, [3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1, 1], [3, 3, 3, 3, 3, 3, 3, 3, 2, 1, 1, 1, 1]],
    ['10c / 16 GB', 10, 16, [4, 8, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2], [4, 8, 4, 4, 4, 4, 4, 4, 3, 3, 3, 2, 1]],
    ['12c / 8 (clamped)', 12, 8, [5, 8, 5, 5, 5, 5, 5, 5, 4, 4, 4, 3, 2], [5, 8, 5, 5, 5, 5, 5, 5, 4, 4, 4, 2, 1]],
    ['16c / 16 GB', 16, 16, [8, 8, 8, 8, 8, 8, 8, 8, 4, 4, 4, 3, 2], [8, 8, 8, 8, 8, 8, 8, 8, 4, 4, 4, 2, 1]],
    ['16c / 32 GB', 16, 32, [8, 8, 8, 8, 8, 8, 8, 8, 4, 4, 4, 4, 4], [8, 8, 8, 8, 8, 8, 8, 8, 4, 4, 4, 4, 4]],
    ['8c / unknown', 8, undefined, [3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1, 1], [3, 3, 3, 3, 3, 3, 3, 3, 2, 1, 1, 1, 1]],
    ['10c / unknown', 10, undefined, [4, 8, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2], [4, 8, 4, 4, 4, 4, 4, 4, 3, 3, 3, 2, 1]],
  ];

  for (const [host, cores, reported, before, after] of TABLE) {
    it(`${host}: ${SIZES.map((f, i) => `${f}MB→${after[i]}`).join(' ')}`, () => {
      SIZES.forEach((f, i) => {
        const r = plan(f, cores, reported);
        expect({ f, count: r.count }).toEqual({ f, count: after[i] });
        if (after[i] !== before[i]) {
          // A change only ever lowers the count, and only where the old count
          // did not fit the tab budget.
          expect(after[i]).toBeLessThan(before[i]);
          expect(estimateTabPeakMiB(f, before[i])).toBeGreaterThan(r.budgetMiB);
          expect(r.reason).toBe('memory');
        } else {
          expect(r.fitsBudget || r.count === 1).toBe(true);
        }
      });
    });
  }

  it('a 1.74 GB file on a 16 GB / 16-core desktop gets 2 workers, not the 4 the cores tier allows', () => {
    const r = plan(1655, 16, 16);
    expect(r.count).toBe(2);
    expect(r.reason).toBe('memory');
    expect(r.estimatedPeakMiB).toBeLessThanOrEqual(r.budgetMiB);
    expect(estimateTabPeakMiB(1655, 3)).toBeGreaterThan(r.budgetMiB);
  });

  it('never returns fewer than one worker when there are jobs', () => {
    const r = plan(1990, 8, 8);
    expect(r.count).toBe(1);
    expect(r.fitsBudget).toBe(false);
    expect(r.exceedsDevice).toBe(false); // 8 may be a clamped value: attempt it
  });
});

describe('override', () => {
  it('wins over the budget and skips the refusal', () => {
    const r = computeWorkerCount({
      fileSizeMB: 1500, cores: 4, deviceMemoryGB: 4, deviceMemoryCeilingGB: deviceMemoryCeilingGB(4),
      totalJobs: 100_000, workerCountOverride: 3,
    });
    expect(r.count).toBe(3);
    expect(r.reason).toBe('override');
    expect(r.exceedsDevice).toBe(false);
  });
});

describe('fail early when one worker cannot fit the device', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).__IFC_LITE_GEOM_MEMORY_GB;
  });

  it('refuses a 1.2 GB file on a device reporting 4 GB (at most 6 GiB)', () => {
    const r = plan(1200, 4, 4);
    expect(r.exceedsDevice).toBe(true);
    expect(r.minimumPeakMiB).toBeGreaterThan(6 * 1024);
    expect(r.deviceCeilingMiB).toBe(6 * 1024);
  });

  it('does not refuse just below the boundary', () => {
    // estimate(1) = 500 + 6.08 F; ceiling 6144 MiB → boundary at F ≈ 928.3 MiB.
    expect(plan(928, 4, 4).exceedsDevice).toBe(false);
    expect(plan(929, 4, 4).exceedsDevice).toBe(true);
  });

  it('never refuses when deviceMemory is missing or possibly clamped', () => {
    for (const reported of [undefined, 8, 32]) {
      expect(plan(2047, 4, reported).exceedsDevice).toBe(false);
    }
  });

  it('planLoadWorkerCount reads navigator.deviceMemory and treats a missing one as unknown', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    const unknown = planLoadWorkerCount(1990);
    expect(unknown.count).toBe(1);
    expect(unknown.exceedsDevice).toBe(false);
    expect(unknown.deviceCeilingMiB).toBe(Infinity);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 4 });
    expect(planLoadWorkerCount(1990).exceedsDevice).toBe(true);
  });

  it('assertGeometryMemoryFits throws GeometryMemoryBudgetError with the numbers the message shows', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 4, deviceMemory: 4 });
    expect(() => assertGeometryMemoryFits(0.5 * GIB)).not.toThrow();
    let caught: unknown;
    try { assertGeometryMemoryFits(1.5 * GIB); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(GeometryMemoryBudgetError);
    const err = caught as GeometryMemoryBudgetError;
    expect(err.requiredMiB).toBeCloseTo(estimateTabPeakMiB(1536, 1), 6);
    expect(err.availableMiB).toBe(6 * 1024);
    // The override skips the refusal: the user asked for a count.
    expect(() => assertGeometryMemoryFits(1.5 * GIB, 1)).not.toThrow();
  });

  it('the simulated device memory flag plans an exact N-GiB device on a large host', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 32, deviceMemory: 32 });
    expect(planLoadWorkerCount(986).count).toBe(4);
    (globalThis as Record<string, unknown>).__IFC_LITE_GEOM_MEMORY_GB = 8;
    const simulated = planLoadWorkerCount(986);
    expect(simulated.count).toBe(1); // no 10+-core lift to 16 for an exact value
    expect(simulated.budgetMiB).toBe(6144);
    // The pool's plan never throws: it still runs one worker. Refusing is the host's opt-in.
    expect(planLoadWorkerCount(1655)).toMatchObject({ count: 1, exceedsDevice: true });
    expect(() => assertGeometryMemoryFits(1655 * 1024 ** 2)).toThrow(GeometryMemoryBudgetError);
  });
});
