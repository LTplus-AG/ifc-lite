/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CPU-side frame-delta fallback for when the `'timestamp-query'` adapter
 * feature is unavailable (see `decideTimingMode` in `frame-timing.ts`).
 *
 * This measures a DIFFERENT thing than GPU timestamp queries: the wall-clock
 * gap between successive `tick()` calls on the CPU, which includes JS work,
 * any main-thread contention, and the browser's own frame pacing — not just
 * GPU pass execution. It is reported through the same `TimingMode ===
 * 'cpu-fallback'` label everywhere (see `frame-timing.ts`'s `TimingMode`
 * doc) specifically so it is never mistaken for a `gpu-queries` number.
 *
 * Thin on purpose: the only thing here that touches a clock is `tick()`.
 * The accumulated deltas are plain numbers fed straight into
 * `computeDurationStats` (`frame-timing-stats.ts`), the same pure statistics
 * GPU-queries mode uses.
 */

export interface CpuFrameTicker {
  /** Records one frame boundary. Call once per frame, at the same point each time (e.g. the top of `render()`). */
  tick(nowMs: number): void;
  /** Every recorded inter-frame delta (ms), oldest first. Empty until at least two `tick()` calls have been made. */
  deltasMs(): number[];
}

/**
 * Creates a `CpuFrameTicker`. The clock read (`performance.now()` in a real
 * caller) happens OUTSIDE this module — `tick(nowMs)` takes the timestamp as
 * a parameter rather than reading a clock itself, so this module has no
 * dependency on real elapsed time and its own tests (see
 * `frame-timing-cpu.test.ts`) can feed synthetic values deterministically.
 */
export function createCpuFrameTicker(): CpuFrameTicker {
  let lastMs: number | null = null;
  const deltas: number[] = [];

  return {
    tick(nowMs: number): void {
      if (lastMs !== null) deltas.push(nowMs - lastMs);
      lastMs = nowMs;
    },
    deltasMs(): number[] {
      return deltas.slice();
    },
  };
}
