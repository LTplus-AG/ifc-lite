/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Summary statistics over a BIM ↔ scan deviation readback (#6872).
 *
 * Pure functions of a `Float32Array` of signed distances in metres (one per
 * scan point, positive = outside the surface), plus an optional validity
 * mask. A value is VALID when the mask (if any) is non-zero AND the value is
 * finite: NaN and ±Infinity never enter a moment, a percentile or a count.
 *
 * Accuracy:
 * - Sums use Neumaier (improved Kahan) compensated summation in float64, and
 *   the standard deviation is a second pass over (d − mean)², so neither the
 *   mean nor σ loses digits to cancellation on large clouds.
 * - Percentiles of |d| are EXACT nearest-rank order statistics
 *   (rank ⌈p·n⌉, the convention `frame-timing-stats.ts` uses), found by a
 *   two-pass radix select on the float32 bit patterns
 *   (`deviation-statistics-kernel.ts`): O(n) worst case, a fixed 1 MiB of
 *   count tables whatever n is, and the input is never copied or reordered.
 *
 * Main thread: every figure is at most two linear passes. The `…Async`
 * variants run those passes in slices of a few milliseconds that yield to
 * the event loop, so a 25M-point summary never blocks one task for long, and
 * take an `AbortSignal` so a superseded request stops early. The viewer only
 * uses those; the synchronous {@link computeDeviationStatistics} suits a
 * worker, a CLI or a test.
 */

import {
    HistogramPass,
    StatisticsPasses,
    ToleranceCount,
    runPhases,
    runPhasesSliced,
} from './deviation-statistics-kernel.js';

/** A bin layout that lines up with the deviation colour ramp. */
export interface DeviationHistogramRange {
    /** Ramp centre in metres (`deviationRange.centerOffset`). */
    center: number;
    /** Ramp half-width in metres; bins span [center − h, center + h]. */
    halfRange: number;
    /** Number of equal-width bins. */
    bins: number;
}

export interface DeviationHistogram {
    /** Lower edge of the first bin, metres. */
    min: number;
    /** Upper edge of the last bin (inclusive), metres. */
    max: number;
    binWidth: number;
    /** Valid points per bin, low → high. */
    counts: number[];
    /** Valid points below `min` / above `max` (the ramp's saturated ends). */
    below: number;
    above: number;
}

export interface DeviationToleranceShare {
    tolerance: number;
    /** Valid points with |d| ≤ tolerance. */
    count: number;
    /** `count / validCount`; null when no point is valid. */
    share: number | null;
}

export interface DeviationStatistics {
    /** Every input point, valid or not. */
    count: number;
    /** Points that are unmasked and finite; every other figure is over these. */
    validCount: number;
    /** Valid points with |d| ≥ `clipRange` (pegged by the compute clip). */
    clippedCount: number;
    min: number | null;
    max: number | null;
    /** Signed mean. */
    mean: number | null;
    meanAbs: number | null;
    rms: number | null;
    /** Population standard deviation of the signed values. */
    stdDev: number | null;
    p50Abs: number | null;
    p95Abs: number | null;
    p99Abs: number | null;
    maxAbs: number | null;
    withinTolerance: DeviationToleranceShare | null;
    histogram: DeviationHistogram | null;
}

export interface DeviationStatisticsOptions {
    /** Per-point validity; zero excludes the point. Must match `values.length`. */
    valid?: ArrayLike<number>;
    /** Report the share of points with |d| ≤ tolerance (metres, ≥ 0). */
    tolerance?: number;
    /**
     * The `maxRange` the compute pass clamped to, to count pegged points. The
     * shader pegs at the float32 value, so the comparison is against
     * `Math.fround(clipRange)`: 0.7 m pegs at 0.699999988 m.
     */
    clipRange?: number;
    histogram?: DeviationHistogramRange;
}

/** One scan asset's slice of a shared readback array. */
export interface DeviationAssetRange {
    expressId: number;
    modelIndex: number;
    offset: number;
    count: number;
}

/** Every computed point's signed distance, grouped by scan asset. */
export interface DeviationDistances {
    values: Float32Array;
    assets: DeviationAssetRange[];
}

/** Cancellation for the sliced `…Async` variants. */
export interface DeviationAsyncOptions {
    /** Aborting rejects with the signal's reason at the next slice boundary. */
    signal?: AbortSignal;
}

export interface DeviationAssetSummary {
    expressId: number;
    modelIndex: number;
    statistics: DeviationStatistics;
}

function statisticsOf(passes: StatisticsPasses, count: number, tolerance: number | undefined): DeviationStatistics {
    const { n } = passes;
    const withinTolerance = tolerance === undefined
        ? null
        : { tolerance, count: passes.within, share: n > 0 ? passes.within / n : null };
    const histogram = passes.binner?.histogram ?? null;
    if (n === 0) {
        return {
            count, validCount: 0, clippedCount: 0,
            min: null, max: null, mean: null, meanAbs: null, rms: null, stdDev: null,
            p50Abs: null, p95Abs: null, p99Abs: null, maxAbs: null,
            withinTolerance, histogram,
        };
    }
    const [p50Abs, p95Abs, p99Abs] = passes.percentiles;
    return {
        count,
        validCount: n,
        clippedCount: passes.clipped,
        min: passes.min,
        max: passes.max,
        mean: passes.mean,
        meanAbs: passes.sumAbs.value() / n,
        rms: Math.sqrt(passes.sumSq.value() / n),
        // σ from squared residuals about the mean, not E[d²] − mean², which cancels.
        stdDev: Math.sqrt(passes.residual.value() / n),
        p50Abs,
        p95Abs,
        p99Abs,
        maxAbs: passes.maxAbs,
        withinTolerance,
        histogram,
    };
}

/** Full summary in one synchronous call: two O(n) passes, no copy. */
export function computeDeviationStatistics(
    values: Float32Array,
    options: DeviationStatisticsOptions = {},
): DeviationStatistics {
    const passes = new StatisticsPasses(values, options);
    runPhases(values.length, passes.phases);
    return statisticsOf(passes, values.length, options.tolerance);
}

/** {@link computeDeviationStatistics} in time-boxed slices that yield to the event loop. */
export async function computeDeviationStatisticsAsync(
    values: Float32Array,
    options: DeviationStatisticsOptions & DeviationAsyncOptions = {},
): Promise<DeviationStatistics> {
    const passes = new StatisticsPasses(values, options);
    await runPhasesSliced(values.length, passes.phases, options.signal);
    return statisticsOf(passes, values.length, options.tolerance);
}

/** Valid points with |d| ≤ tolerance: one O(n) pass in yielding slices, no allocation. */
export async function countWithinToleranceAsync(
    values: Float32Array,
    tolerance: number,
    options: { valid?: ArrayLike<number> } & DeviationAsyncOptions = {},
): Promise<number> {
    const pass = new ToleranceCount(values, tolerance, options.valid);
    await runPhasesSliced(values.length, [pass], options.signal);
    return pass.count;
}

/** Fixed-bin histogram over the ramp range: one O(n) pass in yielding slices. */
export async function deviationHistogramAsync(
    values: Float32Array,
    range: DeviationHistogramRange,
    options: { valid?: ArrayLike<number> } & DeviationAsyncOptions = {},
): Promise<DeviationHistogram> {
    const pass = new HistogramPass(values, range, options.valid);
    await runPhasesSliced(values.length, [pass], options.signal);
    return pass.binner.histogram;
}

/** Per-asset statistics over each asset's slice of one readback array, in yielding slices. */
export async function summarizeDeviationAssetsAsync(
    distances: DeviationDistances,
    options: Omit<DeviationStatisticsOptions, 'valid'> & DeviationAsyncOptions = {},
): Promise<DeviationAssetSummary[]> {
    const summaries: DeviationAssetSummary[] = [];
    for (const asset of distances.assets) {
        summaries.push({
            expressId: asset.expressId,
            modelIndex: asset.modelIndex,
            statistics: await computeDeviationStatisticsAsync(
                distances.values.subarray(asset.offset, asset.offset + asset.count),
                options,
            ),
        });
    }
    return summaries;
}
