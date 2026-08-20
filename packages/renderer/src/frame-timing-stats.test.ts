/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { nsToMs, computeDurationStats } from './frame-timing-stats.js';

describe('nsToMs', () => {
  it('converts an exact 1ms span', () => {
    assert.strictEqual(nsToMs(0n, 1_000_000n), 1);
  });

  it('converts a non-round, asymmetric span (catches a dropped /1e6 or a swapped operand order)', () => {
    // 12_345_678 ns = 12.345678 ms. Non-round and asymmetric: an off-by-one
    // in the divisor (e.g. /1e3 or /1e9) or a start/end swap both produce a
    // visibly wrong number, not a coincidentally-passing one.
    assert.strictEqual(nsToMs(1_000_000_000n, 1_012_345_678n), 12.345678);
  });

  it('uses (end - start), not the raw start value', () => {
    // A large absolute start timestamp (as a real GPU clock produces) must
    // not leak into the result — only the delta (3_500_000 ns = 3.5 ms)
    // matters, even though the start value alone is ~500 seconds.
    const start = 500_000_000_000_000n;
    const end = start + 3_500_000n;
    assert.strictEqual(nsToMs(start, end), 3.5);
  });
});

describe('computeDurationStats', () => {
  it('returns the explicit empty-sample shape for zero frames, not zeros', () => {
    const stats = computeDurationStats([]);
    assert.deepStrictEqual(stats, {
      count: 0,
      min: null,
      median: null,
      p95: null,
      max: null,
      mean: null,
    });
  });

  it('computes min/median/p95/max/mean for a single sample', () => {
    const stats = computeDurationStats([7.25]);
    assert.deepStrictEqual(stats, {
      count: 1,
      min: 7.25,
      median: 7.25,
      p95: 7.25,
      max: 7.25,
      mean: 7.25,
    });
  });

  it('computes exact statistics over a known, non-round, asymmetric sample', () => {
    // 11 values, deliberately unsorted, non-round, no two equal — every
    // statistic below has exactly one correct value, so a wrong coefficient
    // or an off-by-one rank shows up as a wrong number, not a coincidence.
    const durations = [8.1, 41.7, 3.3, 12.9, 6.6, 22.4, 5.05, 9.9, 15.15, 4.4, 30.3];
    const stats = computeDurationStats(durations);

    // sorted: 3.3, 4.4, 5.05, 6.6, 8.1, 9.9, 12.9, 15.15, 22.4, 30.3, 41.7
    assert.strictEqual(stats.count, 11);
    assert.strictEqual(stats.min, 3.3);
    assert.strictEqual(stats.max, 41.7);
    // median: nearest-rank(0.5) over 11 -> ceil(0.5*11)-1 = 5 -> index 5 -> 9.9
    assert.strictEqual(stats.median, 9.9);
    // p95: ceil(0.95*11)-1 = ceil(10.45)-1 = 11-1 = 10 -> index 10 -> 41.7
    assert.strictEqual(stats.p95, 41.7);
    const sum = 8.1 + 41.7 + 3.3 + 12.9 + 6.6 + 22.4 + 5.05 + 9.9 + 15.15 + 4.4 + 30.3;
    assert.ok(Math.abs((stats.mean ?? NaN) - sum / 11) < 1e-9);
  });

  it('p95 picks a mid-sample rank (not always the max) for a larger, unevenly spread sample', () => {
    // 20 samples: 19 tightly clustered "normal" frames and 1 extreme
    // outlier. p95's rank (ceil(0.95*20)-1 = 18, i.e. the 19th of 20 sorted
    // values) lands on the second-highest value, NOT the max outlier — this
    // is exactly the case that would silently break if p95 were
    // accidentally implemented as "always index length-1".
    const normal = [8.0, 8.1, 8.05, 7.95, 8.2, 7.9, 8.15, 8.0, 8.05, 7.85, 8.25, 8.1, 7.9, 8.05, 8.0, 8.1, 7.95, 8.2, 8.0];
    const outlier = 250.0;
    const stats = computeDurationStats([...normal, outlier]);
    assert.strictEqual(stats.count, 20);
    assert.strictEqual(stats.max, 250.0);
    // second-highest normal value is 8.25
    assert.strictEqual(stats.p95, 8.25);
    assert.notStrictEqual(stats.p95, stats.max);
  });

  it('does not mutate the input array (sorts a copy)', () => {
    const input = [3.3, 1.1, 2.2];
    const originalOrder = [...input];
    computeDurationStats(input);
    assert.deepStrictEqual(input, originalOrder);
  });
});
