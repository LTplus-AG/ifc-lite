/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Progressive-refinement pacing for LOD streaming (#6869). Pure: callers
 * pass in measured durations; nothing here reads a clock.
 *
 * After a camera move the first pass should land quickly, so its point
 * budget is sized to a time budget (default 200 ms) from a learned read
 * rate (points decoded and uploaded per millisecond). The estimate is an
 * asymmetric EMA: it drops fast when reads get slower (a congested network
 * should shrink the next first pass at once) and rises slowly when they get
 * faster (one cache-warm read must not inflate it). Each sample is first
 * clipped to `[rate / clipRatio, rate * clipRatio]`, so a single outlier, a
 * stall in a background tab or a near-zero duration, moves the estimate by
 * a bounded step.
 */

export interface LodPacerOptions {
  /** Target duration of the first pass, ms. Default 200. */
  firstPassMs?: number;
  /** Prior read rate before any observation, points/ms. Default 1000. */
  initialPointsPerMs?: number;
  /** Floor for the first pass so it is never empty. Default 50 000. */
  minFirstPassPoints?: number;
  /** EMA weight when a sample is slower than the estimate. Default 0.5. */
  fallAlpha?: number;
  /** EMA weight when a sample is faster than the estimate. Default 0.1. */
  riseAlpha?: number;
  /** Outlier clip factor around the current estimate. Default 4. */
  clipRatio?: number;
}

export class LodPacer {
  private rate: number;
  private readonly firstPassMs: number;
  private readonly minFirstPassPoints: number;
  private readonly fallAlpha: number;
  private readonly riseAlpha: number;
  private readonly clipRatio: number;

  constructor(options: LodPacerOptions = {}) {
    this.rate = Math.max(1e-6, options.initialPointsPerMs ?? 1_000);
    this.firstPassMs = Math.max(1, options.firstPassMs ?? 200);
    this.minFirstPassPoints = Math.max(1, Math.floor(options.minFirstPassPoints ?? 50_000));
    this.fallAlpha = options.fallAlpha ?? 0.5;
    this.riseAlpha = options.riseAlpha ?? 0.1;
    this.clipRatio = Math.max(1, options.clipRatio ?? 4);
  }

  /** Current read-rate estimate, points per millisecond. */
  get pointsPerMs(): number {
    return this.rate;
  }

  /** Record that `points` were read in `elapsedMs`. Uninformative samples are ignored. */
  observe(points: number, elapsedMs: number): void {
    if (!(points > 0) || !(elapsedMs > 0) || !Number.isFinite(points) || !Number.isFinite(elapsedMs)) return;
    const sample = Math.min(this.rate * this.clipRatio, Math.max(this.rate / this.clipRatio, points / elapsedMs));
    const alpha = sample < this.rate ? this.fallAlpha : this.riseAlpha;
    this.rate += alpha * (sample - this.rate);
  }

  /**
   * Point budgets for the passes of one refinement, ascending, ending at
   * `fullBudget`: a time-boxed first pass, then the full budget.
   */
  passBudgets(fullBudget: number): number[] {
    const full = Math.max(0, Math.floor(fullBudget));
    const first = Math.max(this.minFirstPassPoints, Math.floor(this.rate * this.firstPassMs));
    return first >= full ? [full] : [first, full];
  }
}

/** What a finished (or in-flight) pass would put on screen. */
export interface LodPassQuality {
  /** Increments with every camera change; a pass belongs to one view. */
  viewEpoch: number;
  points: number;
  /** Every node of the pass is resident. */
  complete: boolean;
}

/**
 * Replace what is on screen only with something better: a pass for the
 * same view with more points, or a COMPLETE pass for a newer view. A newer
 * view's partial pass waits, so the screen never trades a full picture for
 * a half-loaded one; a stale view never replaces a newer one.
 */
export function shouldReplacePass(current: LodPassQuality | null, candidate: LodPassQuality): boolean {
  if (!current) return true;
  if (candidate.viewEpoch < current.viewEpoch) return false;
  if (candidate.viewEpoch > current.viewEpoch) return candidate.complete;
  return candidate.points > current.points;
}
