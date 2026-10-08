/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Linear passes behind the deviation summary statistics (#6872).
 *
 * Every figure is built from at most two O(n) passes over the readback, each
 * of which can run in one call or in time-boxed slices that yield to the
 * event loop, so a 25M-point cloud never blocks the main thread in one task.
 *
 * Exact percentiles without a copy: for a non-negative float32, the IEEE bit
 * pattern read as an unsigned integer is monotone in the value. So |d|'s
 * order statistics are the order statistics of `bits & 0x7fffffff`, found by
 * a two-level radix select: pass 1 counts the high 16 bits (65,536 bins), the
 * cumulative counts name the bucket holding each wanted rank, and pass 2
 * counts the low 16 bits of the values in just those (at most three)
 * buckets. Memory is four 256 KiB count tables, independent of n, and the
 * input is never reordered or copied.
 */

import type { DeviationHistogram, DeviationHistogramRange } from './deviation-statistics.js';

const ABS_MASK = 0x7fffffff;
/** |d| bit patterns at or above this are ±Infinity or NaN. */
const NON_FINITE = 0x7f800000;
const RADIX = 1 << 16;
const LOW_MASK = RADIX - 1;
/** Elements per slice between clock checks. */
const SLICE = 1 << 16;
/** Longest stretch of work before yielding, ms. */
const SLICE_BUDGET_MS = 8;

/** A pass over `[start, end)`, then an optional step once the pass is done. */
export interface Phase {
    scan(start: number, end: number): void;
    done?(): void;
}

export function runPhases(length: number, phases: readonly Phase[]): void {
    for (const phase of phases) {
        phase.scan(0, length);
        phase.done?.();
    }
}

/**
 * Yield through a MessageChannel task, not `scheduler.yield()`: that
 * continuation runs ahead of already-queued normal tasks, React renders
 * included, so a loop yielding through it still starves the UI (the same
 * reasoning as the IDS validator's yield).
 */
function yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            // An open port keeps a Node process alive.
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(null);
    });
}

/**
 * Run the phases in slices of at most ~{@link SLICE_BUDGET_MS} ms. Always
 * yields once before starting, so the caller's task (a click, a render)
 * finishes first and an abort raised in it is seen before any work.
 */
export async function runPhasesSliced(length: number, phases: readonly Phase[], signal?: AbortSignal): Promise<void> {
    await yieldToEventLoop();
    signal?.throwIfAborted();
    let sliceStart = performance.now();
    for (const phase of phases) {
        for (let start = 0; start < length;) {
            const end = Math.min(length, start + SLICE);
            phase.scan(start, end);
            start = end;
            if (performance.now() - sliceStart >= SLICE_BUDGET_MS) {
                await yieldToEventLoop();
                signal?.throwIfAborted();
                sliceStart = performance.now();
            }
        }
        phase.done?.();
    }
}

export function checkMask(values: Float32Array, valid: ArrayLike<number> | undefined): void {
    if (valid && valid.length !== values.length) {
        throw new RangeError(`deviation statistics: mask length ${valid.length} != values length ${values.length}`);
    }
}

export function checkTolerance(tolerance: number): void {
    if (!(tolerance >= 0) || !Number.isFinite(tolerance)) {
        throw new RangeError(`deviation statistics: tolerance must be a finite value ≥ 0, got ${tolerance}`);
    }
}

function bitsOf(values: Float32Array): Uint32Array {
    return new Uint32Array(values.buffer, values.byteOffset, values.length);
}

const bitCast = new Uint32Array(1);
const floatCast = new Float32Array(bitCast.buffer);
function floatFromBits(bits: number): number {
    bitCast[0] = bits;
    return floatCast[0];
}

/** Valid points with |d| ≤ tolerance. */
export class ToleranceCount implements Phase {
    count = 0;
    constructor(
        private readonly values: Float32Array,
        private readonly tolerance: number,
        private readonly valid?: ArrayLike<number>,
    ) {
        checkMask(values, valid);
        checkTolerance(tolerance);
    }
    scan(start: number, end: number): void {
        const { values, tolerance, valid } = this;
        let count = 0;
        for (let i = start; i < end; i++) {
            // NaN and ±Infinity fail the comparison on their own.
            if (Math.abs(values[i]) <= tolerance && (!valid || valid[i] !== 0)) count++;
        }
        this.count += count;
    }
}

/** Fixed bins over [center − h, center + h], the colour ramp's own range. */
export class HistogramBinner {
    readonly histogram: DeviationHistogram;
    private readonly last: number;
    constructor(range: DeviationHistogramRange) {
        const { center, halfRange, bins } = range;
        if (!(halfRange > 0) || !Number.isFinite(halfRange) || !Number.isFinite(center)) {
            throw new RangeError(`deviation histogram: halfRange must be finite and > 0, got ${halfRange}`);
        }
        if (!Number.isInteger(bins) || bins < 1) {
            throw new RangeError(`deviation histogram: bins must be a positive integer, got ${bins}`);
        }
        this.histogram = {
            min: center - halfRange, max: center + halfRange, binWidth: (2 * halfRange) / bins,
            counts: new Array<number>(bins).fill(0), below: 0, above: 0,
        };
        this.last = bins - 1;
    }
    /** `v` must be finite. */
    add(v: number): void {
        const h = this.histogram;
        if (v < h.min) h.below++;
        else if (v > h.max) h.above++;
        else h.counts[Math.min(this.last, Math.floor((v - h.min) / h.binWidth))]++;
    }
}

/** Histogram as a standalone pass. */
export class HistogramPass implements Phase {
    readonly binner: HistogramBinner;
    constructor(private readonly values: Float32Array, range: DeviationHistogramRange, private readonly valid?: ArrayLike<number>) {
        checkMask(values, valid);
        this.binner = new HistogramBinner(range);
    }
    scan(start: number, end: number): void {
        const { values, valid, binner } = this;
        for (let i = start; i < end; i++) {
            const v = values[i];
            if (Number.isFinite(v) && (!valid || valid[i] !== 0)) binner.add(v);
        }
    }
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

/** Nearest-rank index (0-based) of the `percent`-th percentile of n values. */
export function nearestRank(percent: number, n: number): number {
    return Math.min(n - 1, Math.max(0, Math.ceil((percent * n) / 100) - 1));
}

/** Percentiles of |d| reported, in percent. */
export const PERCENTILES = [50, 95, 99] as const;

export interface MomentOptions {
    valid?: ArrayLike<number>;
    tolerance?: number;
    /** Compared against `Math.fround(clipRange)`: the shader pegs in float32. */
    clipRange?: number;
    histogram?: DeviationHistogramRange;
}

/**
 * The two passes of a full summary: moments, extremes, counts and the
 * high-bits table first; then σ about the now-known mean, and the low bits
 * of the percentile buckets.
 */
export class StatisticsPasses {
    readonly phases: readonly Phase[];
    n = 0;
    within = 0;
    clipped = 0;
    min = Infinity;
    max = -Infinity;
    maxAbs = 0;
    mean = 0;
    readonly sum = new CompensatedSum();
    readonly sumAbs = new CompensatedSum();
    readonly sumSq = new CompensatedSum();
    readonly residual = new CompensatedSum();
    readonly binner: HistogramBinner | null;
    /** |d| for each of {@link PERCENTILES}, set after the second pass. */
    readonly percentiles: number[] = [];
    private readonly bits: Uint32Array;
    private readonly high = new Uint32Array(RADIX);
    private readonly clipAt: number | undefined;
    /** Per wanted rank: its high-bits bucket and the rank within that bucket. */
    private targets: Array<{ bucket: number; rank: number; low: Uint32Array }> = [];

    constructor(private readonly values: Float32Array, private readonly options: MomentOptions) {
        checkMask(values, options.valid);
        if (options.tolerance !== undefined) checkTolerance(options.tolerance);
        this.binner = options.histogram ? new HistogramBinner(options.histogram) : null;
        this.clipAt = options.clipRange === undefined ? undefined : Math.fround(options.clipRange);
        this.bits = bitsOf(values);
        this.phases = [
            { scan: (s, e) => this.scanMoments(s, e), done: () => this.plan() },
            { scan: (s, e) => this.scanResiduals(s, e), done: () => this.resolve() },
        ];
    }

    private scanMoments(start: number, end: number): void {
        const { values, bits, high, binner, sum, sumAbs, sumSq, clipAt } = this;
        const { valid } = this.options;
        // Absent options compare against NaN / +Infinity, so they never count.
        const tolerance = this.options.tolerance ?? Number.NaN;
        const clip = clipAt ?? Number.POSITIVE_INFINITY;
        let { n, min, max, maxAbs, within, clipped } = this;
        for (let i = start; i < end; i++) {
            const b = bits[i] & ABS_MASK;
            if (b >= NON_FINITE || (valid && valid[i] === 0)) continue;
            const v = values[i];
            const abs = Math.abs(v);
            n++;
            high[b >>> 16]++;
            sum.add(v);
            sumAbs.add(abs);
            sumSq.add(v * v);
            if (v < min) min = v;
            if (v > max) max = v;
            if (abs > maxAbs) maxAbs = abs;
            if (abs <= tolerance) within++;
            if (abs >= clip) clipped++;
            binner?.add(v);
        }
        Object.assign(this, { n, min, max, maxAbs, within, clipped });
    }

    /** Locate each wanted rank's high-bits bucket from the cumulative counts. */
    private plan(): void {
        const n = this.n;
        if (n === 0) return;
        this.mean = this.sum.value() / n;
        const lows = new Map<number, Uint32Array>();
        let bucket = 0;
        let below = 0;
        // Ranks ascend with the percentiles, so one forward walk serves all.
        for (const percent of PERCENTILES) {
            const rank = nearestRank(percent, n);
            while (below + this.high[bucket] <= rank) below += this.high[bucket++];
            let low = lows.get(bucket);
            if (!low) lows.set(bucket, low = new Uint32Array(RADIX));
            this.targets.push({ bucket, rank: rank - below, low });
        }
    }

    private scanResiduals(start: number, end: number): void {
        if (this.n === 0) return;
        const { values, bits, residual, mean } = this;
        const { valid } = this.options;
        // At most three distinct buckets; unused slots never match (> 0xffff).
        const [t0, t1, t2] = [0, 1, 2].map((k) => this.targets[k]);
        const b0 = t0.bucket, b1 = t1.bucket === b0 ? -1 : t1.bucket;
        const b2 = t2.bucket === b0 || t2.bucket === t1.bucket ? -1 : t2.bucket;
        const l0 = t0.low, l1 = t1.low, l2 = t2.low;
        for (let i = start; i < end; i++) {
            const b = bits[i] & ABS_MASK;
            if (b >= NON_FINITE || (valid && valid[i] === 0)) continue;
            const d = values[i] - mean;
            residual.add(d * d);
            const h = b >>> 16;
            if (h === b0) l0[b & LOW_MASK]++;
            else if (h === b1) l1[b & LOW_MASK]++;
            else if (h === b2) l2[b & LOW_MASK]++;
        }
    }

    private resolve(): void {
        for (const { bucket, rank, low } of this.targets) {
            let below = 0;
            let l = 0;
            while (below + low[l] <= rank) below += low[l++];
            this.percentiles.push(floatFromBits((bucket << 16) | l));
        }
    }
}
