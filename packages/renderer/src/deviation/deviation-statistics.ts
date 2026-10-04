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
 *   (rank ⌈p·n⌉, the convention `frame-timing-stats.ts` uses), found by
 *   three-way quickselect on one float32 scratch copy of the valid |d|. Memory
 *   is 4 bytes per valid point, the same size as the GPU deviation buffer and
 *   bounded by the viewer's resident point cap. Selection is O(n) expected; a
 *   depth limit falls back to a native sort of the remaining range, so a
 *   pathological input stays O(n log n). The input array is never reordered.
 */

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
    /** The `maxRange` the compute pass clamped to, to count pegged points. */
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

export interface DeviationAssetSummary {
    expressId: number;
    modelIndex: number;
    statistics: DeviationStatistics;
}

/** Neumaier compensated sum: exact-to-rounding for mixed magnitudes. */
class CompensatedSum {
    private sum = 0;
    private compensation = 0;
    add(x: number): void {
        const t = this.sum + x;
        if (Math.abs(this.sum) >= Math.abs(x)) this.compensation += (this.sum - t) + x;
        else this.compensation += (x - t) + this.sum;
        this.sum = t;
    }
    value(): number {
        return this.sum + this.compensation;
    }
}

function checkMask(values: Float32Array, valid: ArrayLike<number> | undefined): void {
    if (valid && valid.length !== values.length) {
        throw new RangeError(`deviation statistics: mask length ${valid.length} != values length ${values.length}`);
    }
}

function checkTolerance(tolerance: number): void {
    if (!(tolerance >= 0) || !Number.isFinite(tolerance)) {
        throw new RangeError(`deviation statistics: tolerance must be a finite value ≥ 0, got ${tolerance}`);
    }
}

/** Valid points with |d| ≤ tolerance. O(n), no allocation. */
export function countWithinTolerance(values: Float32Array, tolerance: number, valid?: ArrayLike<number>): number {
    checkMask(values, valid);
    checkTolerance(tolerance);
    let count = 0;
    for (let i = 0; i < values.length; i++) {
        // NaN and ±Infinity fail the comparison on their own.
        if (Math.abs(values[i]) <= tolerance && (!valid || valid[i] !== 0)) count++;
    }
    return count;
}

/** Fixed-bin histogram over the ramp range. O(n), allocation = `bins`. */
export function deviationHistogram(
    values: Float32Array,
    range: DeviationHistogramRange,
    valid?: ArrayLike<number>,
): DeviationHistogram {
    checkMask(values, valid);
    const binner = createBinner(range);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v) && (!valid || valid[i] !== 0)) binner.add(v);
    }
    return binner.histogram;
}

function createBinner(range: DeviationHistogramRange): { histogram: DeviationHistogram; add(v: number): void } {
    const { center, halfRange, bins } = range;
    if (!(halfRange > 0) || !Number.isFinite(halfRange) || !Number.isFinite(center)) {
        throw new RangeError(`deviation histogram: halfRange must be finite and > 0, got ${halfRange}`);
    }
    if (!Number.isInteger(bins) || bins < 1) {
        throw new RangeError(`deviation histogram: bins must be a positive integer, got ${bins}`);
    }
    const min = center - halfRange;
    const max = center + halfRange;
    const binWidth = (2 * halfRange) / bins;
    const histogram: DeviationHistogram = { min, max, binWidth, counts: new Array<number>(bins).fill(0), below: 0, above: 0 };
    const last = bins - 1;
    return {
        histogram,
        add(v: number): void {
            if (v < min) histogram.below++;
            else if (v > max) histogram.above++;
            else histogram.counts[Math.min(last, Math.floor((v - min) / binWidth))]++;
        },
    };
}

/** Partially orders `a[lo..hi]` so `a[k]` holds the k-th smallest value. */
function select(a: Float32Array, lo: number, hi: number, k: number): void {
    let depth = 2 * Math.ceil(Math.log2(hi - lo + 2)) + 8;
    while (hi > lo) {
        if (depth-- === 0) {
            a.subarray(lo, hi + 1).sort();
            return;
        }
        // Median of three as the pivot value.
        const mid = lo + ((hi - lo) >> 1);
        const x = a[lo], y = a[mid], z = a[hi];
        const pivot = x < y ? (y < z ? y : x < z ? z : x) : (x < z ? x : y < z ? z : y);
        // Three-way partition: [lo, lt) < pivot, [lt, gt] == pivot, (gt, hi] > pivot.
        // Ties (a flat wall scanned at one offset) collapse in a single pass.
        let lt = lo, gt = hi, i = lo;
        while (i <= gt) {
            const v = a[i];
            if (v < pivot) {
                a[i++] = a[lt];
                a[lt++] = v;
            } else if (v > pivot) {
                a[i] = a[gt];
                a[gt--] = v;
            } else {
                i++;
            }
        }
        if (k < lt) hi = lt - 1;
        else if (k > gt) lo = gt + 1;
        else return;
    }
}

function rankOf(p: number, n: number): number {
    return Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
}

export function computeDeviationStatistics(
    values: Float32Array,
    options: DeviationStatisticsOptions = {},
): DeviationStatistics {
    const { valid, tolerance, clipRange } = options;
    checkMask(values, valid);
    if (tolerance !== undefined) checkTolerance(tolerance);
    const binner = options.histogram ? createBinner(options.histogram) : null;

    // Pass 1: moments, extremes, counts, histogram, and the |d| scratch copy.
    const scratch = new Float32Array(valid ? countValid(values, valid) : values.length);
    const sum = new CompensatedSum();
    const sumAbs = new CompensatedSum();
    const sumSq = new CompensatedSum();
    let n = 0;
    let within = 0;
    let clipped = 0;
    let min = Infinity;
    let max = -Infinity;
    let maxAbs = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v) || (valid && valid[i] === 0)) continue;
        const abs = Math.abs(v);
        scratch[n++] = abs;
        sum.add(v);
        sumAbs.add(abs);
        sumSq.add(v * v);
        if (v < min) min = v;
        if (v > max) max = v;
        if (abs > maxAbs) maxAbs = abs;
        if (tolerance !== undefined && abs <= tolerance) within++;
        if (clipRange !== undefined && abs >= clipRange) clipped++;
        binner?.add(v);
    }

    const withinTolerance = tolerance === undefined
        ? null
        : { tolerance, count: within, share: n > 0 ? within / n : null };
    const histogram = binner?.histogram ?? null;
    if (n === 0) {
        return {
            count: values.length, validCount: 0, clippedCount: 0,
            min: null, max: null, mean: null, meanAbs: null, rms: null, stdDev: null,
            p50Abs: null, p95Abs: null, p99Abs: null, maxAbs: null,
            withinTolerance, histogram,
        };
    }

    // Pass 2: σ from squared residuals, not E[d²] − mean², which cancels.
    const mean = sum.value() / n;
    const residual = new CompensatedSum();
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v) || (valid && valid[i] === 0)) continue;
        residual.add((v - mean) * (v - mean));
    }

    // Exact percentiles, highest first: everything ≤ the p99 element sits in
    // [0, k99) afterwards, so each later selection runs on a shrinking prefix
    // that excludes (and so cannot move) the element already placed.
    const work = n === scratch.length ? scratch : scratch.subarray(0, n);
    const k99 = rankOf(0.99, n);
    const k95 = rankOf(0.95, n);
    const k50 = rankOf(0.5, n);
    select(work, 0, n - 1, k99);
    if (k95 < k99) select(work, 0, k99 - 1, k95);
    if (k50 < k95) select(work, 0, k95 - 1, k50);

    return {
        count: values.length,
        validCount: n,
        clippedCount: clipped,
        min,
        max,
        mean,
        meanAbs: sumAbs.value() / n,
        rms: Math.sqrt(sumSq.value() / n),
        stdDev: Math.sqrt(residual.value() / n),
        p50Abs: work[k50],
        p95Abs: work[k95],
        p99Abs: work[k99],
        maxAbs,
        withinTolerance,
        histogram,
    };
}

function countValid(values: Float32Array, valid: ArrayLike<number>): number {
    let n = 0;
    for (let i = 0; i < values.length; i++) if (valid[i] !== 0 && Number.isFinite(values[i])) n++;
    return n;
}

/** Per-asset statistics over each asset's slice of one readback array. */
export function summarizeDeviationAssets(
    distances: DeviationDistances,
    options: Omit<DeviationStatisticsOptions, 'valid'> = {},
): DeviationAssetSummary[] {
    return distances.assets.map((asset) => ({
        expressId: asset.expressId,
        modelIndex: asset.modelIndex,
        statistics: computeDeviationStatistics(
            distances.values.subarray(asset.offset, asset.offset + asset.count),
            options,
        ),
    }));
}
