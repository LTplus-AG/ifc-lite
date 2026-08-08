/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bounded "wait for the next frame".
 *
 * `requestAnimationFrame` is **not serviced while the document is hidden** —
 * the callback is queued and only runs when the tab is shown again. So a bare
 * `await new Promise(resolve => requestAnimationFrame(resolve))` inside an
 * async pipeline parks *for as long as the user stays on another tab*, which on
 * a long model load is routinely minutes and has been observed in field
 * telemetry at over a day.
 *
 * Every such wait in a background-capable pipeline must therefore be raced
 * against a timer. `useIDS` already did this by hand; this is the single home
 * for the pattern.
 *
 * The frame still wins whenever one arrives, so a visible tab behaves exactly
 * as it did before as long as `timeoutMs` is generous relative to a frame.
 *
 * Caveat, deliberately not worked around: browsers throttle timers in hidden
 * tabs (Chrome clamps to >=1s, and to ~1/minute after several minutes of
 * hiddenness). The fallback therefore bounds the stall rather than hitting
 * `timeoutMs` exactly — bounded-and-late is the goal, not precision.
 *
 * @param timeoutMs Upper bound on the wait. Must be > 0; a non-positive value
 *   would defeat the frame wait entirely and is rejected rather than silently
 *   turning every call site into "yield once".
 */
export function nextFrameOrTimeout(timeoutMs: number): Promise<void> {
  if (!(timeoutMs > 0)) {
    throw new RangeError(`nextFrameOrTimeout: timeoutMs must be > 0, got ${timeoutMs}`);
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, timeoutMs);
    // Read off globalThis so a non-DOM host (node tests, SSR) falls through to
    // the timer instead of throwing.
    const raf = (globalThis as typeof globalThis & {
      requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    }).requestAnimationFrame;
    if (typeof raf === 'function') raf(done);
  });
}
