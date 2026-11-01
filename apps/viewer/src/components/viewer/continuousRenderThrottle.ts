/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adaptive cap on the continuous-render cadence (interaction + inertia).
 *
 * The cap follows the MEASURED main-thread cost of recent frames
 * (`FrameStats.cpuMs`: encode and submit, not the swap-chain wait), so a
 * heavy model keeps the main thread responsive while a GPU-bound frame is
 * left to `GpuFramePacer`. The cost ladder (cap 25 ms above 14 ms, 33 ms
 * above 26 ms, released below 10 ms) is unchanged.
 *
 * What changed is how a cap meets the display. The old gate,
 * `now - lastRender < cap`, rounds every cap UP to the next whole vsync: on
 * a 60 Hz rAF grid both 25 ms and 33 ms yielded exactly 30 fps, and rAF
 * jitter made 33 ms flap between 30 and 20 fps. Here a cap becomes a whole
 * number of refresh intervals (`cap / refresh`, rounded), and a frame renders
 * once `elapsed >= (k - 0.5) * refresh`: half a frame of slack on each side,
 * so jitter cannot flip the decision. On 60 Hz the 25 ms tier no longer
 * throttles at all (k = 1) and 33 ms stays 30 fps (k = 2); on 120 Hz they
 * are 40 and 30 fps.
 */

const DEFAULT_REFRESH_MS = 1000 / 60;
/** Refresh estimate clamp: 250 Hz .. 20 Hz. */
const REFRESH_MIN_MS = 4;
const REFRESH_MAX_MS = 50;
/** rAF deltas kept for the refresh estimate (window minimum). */
const REFRESH_WINDOW = 8;
/**
 * Rounding bias toward the faster cadence, in refresh intervals. A 25 ms cap
 * at 60 Hz is 1.5 frames exactly, and the window-minimum refresh estimate
 * sits slightly below the true interval under jitter, so plain rounding
 * would settle that tie on the slower cadence.
 */
const ROUND_BIAS = 0.1;

export class ContinuousRenderThrottle {
  private emaCostMs: number | null = null;
  private capMs = 0;
  private readonly deltas: number[] = [];
  private refreshMs = DEFAULT_REFRESH_MS;

  private pendingCostMs = 0;

  /**
   * Feed every rAF delta, rendered or not. The refresh interval is the
   * minimum of a short window, so a long frame (a stall, a GC) never
   * inflates it; a delta that mostly covered the previous frame's own render
   * is skipped, since it measures that cost rather than the display.
   */
  noteFrameInterval(deltaMs: number): void {
    const coveredByRender = this.pendingCostMs > deltaMs * 0.5;
    this.pendingCostMs = 0;
    if (!Number.isFinite(deltaMs) || deltaMs <= 0 || coveredByRender) return;
    this.deltas.push(deltaMs);
    if (this.deltas.length > REFRESH_WINDOW) this.deltas.shift();
    let min = Infinity;
    for (const d of this.deltas) if (d < min) min = d;
    this.refreshMs = Math.min(Math.max(min, REFRESH_MIN_MS), REFRESH_MAX_MS);
  }

  /** Feed the main-thread cost of each rendered frame. */
  noteRenderCost(costMs: number): void {
    if (!Number.isFinite(costMs) || costMs < 0) return;
    this.pendingCostMs = costMs;
    const ema = this.emaCostMs === null ? costMs : costMs * 0.2 + this.emaCostMs * 0.8;
    this.emaCostMs = ema;
    // Hysteresis ladder: engage above, release below, hold in between, so
    // the cadence does not flap around a band edge mid-gesture.
    if (ema >= 26) {
      this.capMs = 33;
    } else if (ema >= 14) {
      if (this.capMs !== 33 || ema < 20) this.capMs = 25;
    } else if (ema <= 10) {
      this.capMs = 0;
    }
  }

  /** Refresh intervals per rendered frame under the current cap (1 = every frame). */
  framesPerRender(): number {
    if (this.capMs === 0) return 1;
    return Math.max(1, Math.floor(this.capMs / this.refreshMs + 0.5 - ROUND_BIAS));
  }

  /** Whether a continuous frame `elapsedMs` after the last render may render. */
  allows(elapsedMs: number): boolean {
    const k = this.framesPerRender();
    return k === 1 || elapsedMs >= (k - 0.5) * this.refreshMs;
  }

  /** The intended cadence while throttled (0 = every frame), for the effects governor. */
  intervalMs(): number {
    const k = this.framesPerRender();
    return k === 1 ? 0 : k * this.refreshMs;
  }
}
