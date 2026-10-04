/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { LodPacer, shouldReplacePass } from './pacer.js';

describe('LodPacer read-rate estimate (#6869)', () => {
  it('converges to a steady read rate', () => {
    const pacer = new LodPacer({ initialPointsPerMs: 100 });
    for (let i = 0; i < 200; i++) pacer.observe(500_000, 1_000); // 500 points/ms
    expect(pacer.pointsPerMs).toBeCloseTo(500, 0);
  });

  it('drops fast and rises slowly (asymmetric EMA)', () => {
    const down = new LodPacer({ initialPointsPerMs: 1_000 });
    down.observe(500, 1); // half as fast
    const up = new LodPacer({ initialPointsPerMs: 1_000 });
    up.observe(2_000, 1); // twice as fast
    const dropShare = (1_000 - down.pointsPerMs) / 500;
    const riseShare = (up.pointsPerMs - 1_000) / 1_000;
    expect(dropShare).toBeGreaterThanOrEqual(0.5);
    expect(riseShare).toBeLessThanOrEqual(0.15);
    expect(riseShare).toBeGreaterThan(0);
  });

  it('clips outliers: one absurd sample cannot swing the estimate', () => {
    const pacer = new LodPacer({ initialPointsPerMs: 1_000, clipRatio: 4 });
    pacer.observe(1e12, 1); // a cache hit reported as a read
    expect(pacer.pointsPerMs).toBeLessThanOrEqual(1_000 * (1 + 0.1 * 3) + 1e-9);
    const stall = new LodPacer({ initialPointsPerMs: 1_000, clipRatio: 4 });
    stall.observe(1, 60_000); // a tab in the background
    expect(stall.pointsPerMs).toBeGreaterThanOrEqual(1_000 / 4);
  });

  it('ignores samples that carry no information', () => {
    const pacer = new LodPacer({ initialPointsPerMs: 700 });
    for (const [p, ms] of [[0, 10], [100, 0], [Number.NaN, 5], [100, -1], [100, Number.POSITIVE_INFINITY]]) pacer.observe(p, ms);
    expect(pacer.pointsPerMs).toBe(700);
  });
});

describe('LodPacer pass budgets', () => {
  it('sizes a first pass to the time budget, then the full budget', () => {
    const pacer = new LodPacer({ initialPointsPerMs: 1_000, firstPassMs: 200, minFirstPassPoints: 10_000 });
    expect(pacer.passBudgets(5_000_000)).toEqual([200_000, 5_000_000]);
  });

  it('one pass when the full budget already fits the time budget', () => {
    const pacer = new LodPacer({ initialPointsPerMs: 1_000, firstPassMs: 200 });
    expect(pacer.passBudgets(150_000)).toEqual([150_000]);
  });

  it('a slow reader still gets a usable first pass (floor)', () => {
    const pacer = new LodPacer({ initialPointsPerMs: 1, firstPassMs: 200, minFirstPassPoints: 50_000 });
    expect(pacer.passBudgets(5_000_000)[0]).toBe(50_000);
  });

  it('budgets are non-decreasing, end at the full budget, and track the learned rate', () => {
    const pacer = new LodPacer({ initialPointsPerMs: 2_000, firstPassMs: 200, minFirstPassPoints: 1_000 });
    const before = pacer.passBudgets(10_000_000)[0];
    for (let i = 0; i < 20; i++) pacer.observe(100_000, 1_000); // 100 points/ms: a slow network
    const passes = pacer.passBudgets(10_000_000);
    expect(passes[0]).toBeLessThan(before);
    for (let i = 1; i < passes.length; i++) expect(passes[i]).toBeGreaterThanOrEqual(passes[i - 1]);
    expect(passes.at(-1)).toBe(10_000_000);
  });
});

describe('shouldReplacePass', () => {
  it.each([
    ['nothing on screen yet', null, { viewEpoch: 1, points: 10, complete: false }, true],
    ['same view, more points', { viewEpoch: 3, points: 100, complete: true }, { viewEpoch: 3, points: 200, complete: true }, true],
    ['same view, fewer points', { viewEpoch: 3, points: 200, complete: true }, { viewEpoch: 3, points: 100, complete: true }, false],
    ['same view, same points', { viewEpoch: 3, points: 200, complete: true }, { viewEpoch: 3, points: 200, complete: true }, false],
    ['newer view, complete', { viewEpoch: 3, points: 900, complete: true }, { viewEpoch: 4, points: 100, complete: true }, true],
    ['newer view, still loading', { viewEpoch: 3, points: 900, complete: true }, { viewEpoch: 4, points: 100, complete: false }, false],
    ['stale view', { viewEpoch: 5, points: 100, complete: true }, { viewEpoch: 4, points: 900, complete: true }, false],
  ] as const)('%s', (_label, current, candidate, expected) => {
    expect(shouldReplacePass(current, candidate)).toBe(expected);
  });
});
