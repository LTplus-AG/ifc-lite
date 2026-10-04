/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Summary statistics for the BIM ↔ scan deviation readback (#6872).
 *
 * Every expectation here is either analytic (a distribution whose
 * percentiles, mean and RMS have a closed form) or an independent oracle
 * (a full numeric sort of the same float32 values), never a re-run of the
 * implementation under test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    computeDeviationStatistics,
    countWithinTolerance,
    deviationHistogram,
    summarizeDeviationAssets,
} from './deviation/deviation-statistics.js';

/** Deterministic 32-bit LCG (Numerical Recipes constants), uniform in [0, 1). */
function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

/** Nearest-rank percentile oracle: full sort of |d|, rank ceil(p·n). */
function oraclePercentile(values: Float32Array, p: number): number {
    const abs = Float32Array.from(values, Math.abs).sort();
    return abs[Math.max(0, Math.ceil(p * abs.length) - 1)];
}

const f32 = Math.fround;

describe('deviation summary statistics (#6872)', () => {
    it('matches the analytic moments and percentiles of a uniform |d| ladder with mixed signs', () => {
        // |d| takes every value s·k/n for k = 1..n exactly once, signs and
        // order scrambled. Nearest-rank pXX of |d| is s·ceil(XX/100·n)/n;
        // mean|d| = s(n+1)/2n; RMS = s·sqrt((n+1)(2n+1)/6n²).
        const n = 10_000;
        const s = 0.08;
        const rand = lcg(6872);
        const values = new Float32Array(n);
        for (let k = 1; k <= n; k++) values[k - 1] = (rand() < 0.5 ? -1 : 1) * (s * k) / n;
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [values[i], values[j]] = [values[j], values[i]];
        }
        const stats = computeDeviationStatistics(values);
        assert.equal(stats.count, n);
        assert.equal(stats.validCount, n);
        assert.equal(stats.p50Abs, f32((s * Math.ceil(0.5 * n)) / n));
        assert.equal(stats.p95Abs, f32((s * Math.ceil(0.95 * n)) / n));
        assert.equal(stats.p99Abs, f32((s * Math.ceil(0.99 * n)) / n));
        assert.equal(stats.maxAbs, f32(s));
        const rel = (actual: number | null, expected: number) => Math.abs((actual ?? NaN) - expected) / expected;
        assert.ok(rel(stats.meanAbs, (s * (n + 1)) / (2 * n)) < 1e-6, `meanAbs ${stats.meanAbs}`);
        assert.ok(rel(stats.rms, s * Math.sqrt(((n + 1) * (2 * n + 1)) / (6 * n * n))) < 1e-6, `rms ${stats.rms}`);
        // Mixed signs: the signed mean is far below the mean of |d|, and the
        // population identity rms² = σ² + mean² holds.
        assert.ok(Math.abs(stats.mean ?? NaN) < (stats.meanAbs ?? 0) / 4);
        const identity = (stats.stdDev ?? NaN) ** 2 + (stats.mean ?? NaN) ** 2;
        assert.ok(Math.abs(identity - (stats.rms ?? NaN) ** 2) < 1e-12);
    });

    it('reports a constant cloud with zero spread and every percentile equal to the value', () => {
        const stats = computeDeviationStatistics(new Float32Array(257).fill(0.003));
        const v = f32(0.003);
        assert.equal(stats.min, v);
        assert.equal(stats.max, v);
        assert.equal(stats.mean, v);
        assert.equal(stats.meanAbs, v);
        assert.equal(stats.rms, v);
        assert.equal(stats.stdDev, 0);
        assert.equal(stats.p50Abs, v);
        assert.equal(stats.p95Abs, v);
        assert.equal(stats.p99Abs, v);
        assert.equal(stats.maxAbs, v);
    });

    it('reports a single negative value as its own magnitude for every |d| statistic', () => {
        const stats = computeDeviationStatistics(new Float32Array([-0.004]));
        const v = f32(0.004);
        assert.equal(stats.min, -v);
        assert.equal(stats.max, -v);
        assert.equal(stats.mean, -v);
        assert.equal(stats.stdDev, 0);
        assert.equal(stats.p50Abs, v);
        assert.equal(stats.p99Abs, v);
        assert.equal(stats.maxAbs, v);
        assert.equal(stats.withinTolerance, null);
    });

    it('returns nulls, not zeros, when nothing was measured: empty input and all-NaN input', () => {
        for (const values of [new Float32Array(0), new Float32Array([NaN, NaN, NaN])]) {
            const stats = computeDeviationStatistics(values, {
                tolerance: 0.01,
                histogram: { center: 0, halfRange: 0.05, bins: 4 },
            });
            assert.equal(stats.count, values.length);
            assert.equal(stats.validCount, 0);
            for (const key of ['min', 'max', 'mean', 'meanAbs', 'rms', 'stdDev', 'p50Abs', 'p95Abs', 'p99Abs', 'maxAbs'] as const) {
                assert.equal(stats[key], null, key);
            }
            assert.deepEqual(stats.withinTolerance, { tolerance: 0.01, count: 0, share: null });
            assert.deepEqual([...(stats.histogram?.counts ?? [])], [0, 0, 0, 0]);
        }
    });

    it('excludes ±Infinity and masked-out points instead of letting them poison the moments', () => {
        const values = new Float32Array([Infinity, -Infinity, 0.01, -0.03, 0.5, NaN]);
        const valid = new Uint8Array([1, 1, 1, 1, 0, 1]);
        const stats = computeDeviationStatistics(values, { valid });
        assert.equal(stats.count, 6);
        assert.equal(stats.validCount, 2);
        assert.equal(stats.min, f32(-0.03));
        assert.equal(stats.max, f32(0.01));
        assert.ok(Math.abs((stats.mean ?? NaN) - (f32(0.01) + f32(-0.03)) / 2) < 1e-12);
        assert.equal(stats.maxAbs, f32(0.03));
        assert.throws(() => computeDeviationStatistics(values, { valid: new Uint8Array(2) }), /mask length/);
    });

    it('uses compensated summation: a large cancelling pair does not swallow a small value', () => {
        // Naive float64 summation gives 1e30 + 1 = 1e30, then 0 → mean 0.
        const big = f32(1e30);
        const stats = computeDeviationStatistics(new Float32Array([big, 1, -big]));
        assert.ok(Math.abs((stats.mean ?? NaN) - 1 / 3) < 1e-12, `mean ${stats.mean}`);
    });

    it('counts |d| ≤ tolerance inclusively and reports the share of valid points', () => {
        const values = new Float32Array([-0.02, -0.01, 0.01, 0.03, NaN]);
        const stats = computeDeviationStatistics(values, { tolerance: 0.01 });
        assert.deepEqual(stats.withinTolerance, { tolerance: 0.01, count: 2, share: 0.5 });
        assert.equal(countWithinTolerance(values, 0.02), 3);
        assert.equal(countWithinTolerance(values, 0), 0);
        // Mixed-sign nearest-rank percentiles of |d| = [0.01, 0.01, 0.02, 0.03].
        assert.equal(stats.p50Abs, f32(0.01));
        assert.equal(stats.p95Abs, f32(0.03));
        assert.equal(stats.mean, (f32(-0.02) + f32(-0.01) + f32(0.01) + f32(0.03)) / 4);
    });

    it('counts points past ±maxRange that the compute shader pegged at the clip', () => {
        const stats = computeDeviationStatistics(new Float32Array([1, -1, 0.2, 0.999]), { clipRange: 1 });
        assert.equal(stats.clippedCount, 2);
        assert.equal(computeDeviationStatistics(new Float32Array([1])).clippedCount, 0);
    });

    it('bins the histogram over the colour ramp range [center − h, center + h] with out-of-range tails', () => {
        // Binary-exact values, so no float32 rounding lands on a bin edge.
        const values = new Float32Array([-2, -0.5, -0.49, -0.001, 0, 0.24, 0.26, 0.5, 3, NaN]);
        const histogram = deviationHistogram(values, { center: 0, halfRange: 0.5, bins: 4 });
        assert.equal(histogram.min, -0.5);
        assert.equal(histogram.max, 0.5);
        assert.deepEqual([...histogram.counts], [2, 1, 2, 2]);
        assert.equal(histogram.below, 1);
        assert.equal(histogram.above, 1);
        // Every valid point lands in exactly one place.
        const binned = histogram.counts.reduce((a, b) => a + b, 0) + histogram.below + histogram.above;
        assert.equal(binned, 9);
        const shifted = deviationHistogram(values, { center: 1, halfRange: 0.5, bins: 2 });
        assert.equal(shifted.min, 0.5);
        assert.deepEqual([shifted.below, ...shifted.counts, shifted.above], [7, 1, 0, 1]);
        assert.throws(() => deviationHistogram(values, { center: 0, halfRange: 0, bins: 4 }), /halfRange/);
        assert.throws(() => deviationHistogram(values, { center: 0, halfRange: 1, bins: 0 }), /bins/);
    });

    it('summarises each scan asset over its own range of one shared readback array', () => {
        const values = new Float32Array([0.01, -0.02, NaN, 0.5, 0.4]);
        const rows = summarizeDeviationAssets({
            values,
            assets: [
                { expressId: 7, modelIndex: 0, offset: 0, count: 3 },
                { expressId: 8, modelIndex: 1, offset: 3, count: 2 },
            ],
        }, { tolerance: 0.45 });
        assert.deepEqual(rows.map((row) => [row.expressId, row.statistics.validCount, row.statistics.maxAbs]),
            [[7, 2, f32(0.02)], [8, 2, f32(0.5)]]);
        assert.equal(rows[1].statistics.withinTolerance?.share, 0.5);
    });

    it('selects exactly the same order statistics as a full sort on random data', () => {
        const rand = lcg(42);
        const values = new Float32Array(200_003);
        // Heavy ties plus a long tail, the shape that breaks naive partitions.
        for (let i = 0; i < values.length; i++) {
            const u = rand();
            values[i] = u < 0.3 ? 0.002 : (rand() - 0.5) * 0.1 / (0.05 + u);
        }
        const before = values.slice();
        const stats = computeDeviationStatistics(values);
        assert.equal(stats.p50Abs, oraclePercentile(values, 0.5));
        assert.equal(stats.p95Abs, oraclePercentile(values, 0.95));
        assert.equal(stats.p99Abs, oraclePercentile(values, 0.99));
        // Selection runs on a scratch copy: the caller's readback is untouched.
        assert.ok(Buffer.from(values.buffer).equals(Buffer.from(before.buffer)));
    });

    it('handles 5M points exactly within a time and memory budget', () => {
        const n = 5_000_000;
        const rand = lcg(5_000_000);
        const values = new Float32Array(n);
        for (let i = 0; i < n; i++) values[i] = (rand() - 0.5) * 0.1;
        globalThis.gc?.();
        const before = process.memoryUsage();
        const t0 = performance.now();
        const stats = computeDeviationStatistics(values, {
            tolerance: 0.025,
            histogram: { center: 0, halfRange: 0.05, bins: 20 },
        });
        const elapsed = performance.now() - t0;
        const after = process.memoryUsage();
        // One float32 scratch copy of |d| (20 MB at 5M) is the design budget;
        // allow the same again for allocator slack, never a float64 copy.
        const grown = (after.arrayBuffers - before.arrayBuffers) + (after.heapUsed - before.heapUsed);
        assert.ok(grown < 2 * 4 * n, `grew ${(grown / 1e6).toFixed(1)} MB`);
        assert.ok(elapsed < 3000, `took ${elapsed.toFixed(0)} ms`);
        // Uniform on [-0.05, 0.05): |d| is uniform on [0, 0.05).
        assert.ok(Math.abs((stats.p95Abs ?? NaN) - 0.0475) < 1e-4);
        assert.ok(Math.abs((stats.withinTolerance?.share ?? NaN) - 0.5) < 1e-3);
        assert.equal(stats.histogram?.counts.reduce((a, b) => a + b, 0), n);
        assert.equal(stats.p99Abs, oraclePercentile(values, 0.99));
    });
});
