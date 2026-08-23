/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createCpuFrameTicker } from './frame-timing-cpu.js';
import { computeDurationStats } from './frame-timing-stats.js';

describe('createCpuFrameTicker', () => {
  it('records no deltas after a single tick (needs a boundary on both sides)', () => {
    const ticker = createCpuFrameTicker();
    ticker.tick(1000);
    assert.deepStrictEqual(ticker.deltasMs(), []);
  });

  it('computes exact, non-round, asymmetric inter-frame deltas from synthetic timestamps', () => {
    // Values chosen exactly representable in binary floating point (eighths
    // of a millisecond) so the subtraction is exact — no epsilon fuzz needed
    // to tell a correct delta from a wrong one.
    const ticker = createCpuFrameTicker();
    ticker.tick(1000.25);
    ticker.tick(1008.375); // +8.125
    ticker.tick(1013.125); // +4.75
    ticker.tick(1054.375); // +41.25
    assert.deepStrictEqual(ticker.deltasMs(), [8.125, 4.75, 41.25]);
  });

  it('feeds straight into the shared stats primitive (same DurationStats shape as GPU-queries mode)', () => {
    const ticker = createCpuFrameTicker();
    // Eighths of a millisecond again, for exact subtraction: deltas are
    // 8.125, 4.75, 41.25.
    for (const t of [0, 8.125, 12.875, 54.125]) ticker.tick(t);
    const stats = computeDurationStats(ticker.deltasMs());
    assert.strictEqual(stats.count, 3);
    assert.strictEqual(stats.max, 41.25);
  });

  it('deltasMs() returns a snapshot — mutating the returned array does not affect the ticker', () => {
    const ticker = createCpuFrameTicker();
    ticker.tick(0);
    ticker.tick(5);
    const snapshot = ticker.deltasMs();
    snapshot.push(999);
    assert.deepStrictEqual(ticker.deltasMs(), [5]);
  });
});
