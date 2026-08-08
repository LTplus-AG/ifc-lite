/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Race a `requestAnimationFrame` wait against a timeout, for the "let this
 * paint before doing heavy/blocking work" pattern used at several points on
 * the load and clash-run paths.
 *
 * Browsers throttle or fully suspend rAF callbacks while
 * `document.visibilityState === 'hidden'` — they queue and only run once the
 * tab is shown again. A bare `await new Promise(r => requestAnimationFrame(r))`
 * on a pipeline that must complete (finalize a load, flip a "running" flag
 * back off, close WASM handles) therefore hangs indefinitely if the user
 * switches tabs mid-run (#2385). Racing against a short timeout bounds the
 * wait without changing anything for the common, visible-tab case: rAF still
 * wins the race there (it fires within one frame, well under the timeout),
 * so the paint that callers rely on still happens first.
 *
 * NOT for waits that must guarantee a frame was actually PRESENTED before
 * reading the canvas (e.g. immediately before `captureScreenshot()`) —
 * timing those out would read a stale, not-yet-composited canvas. Those
 * sites (useClash's BCF snapshot loop, useIDS's entity-snapshot capture)
 * intentionally stay on a bare, unbounded rAF.
 *
 * @param frames - `1` waits for the next animation frame; `2` waits two
 *   frames deep (`requestAnimationFrame(() => requestAnimationFrame(done))`),
 *   matching call sites that want a frame after the frame after the
 *   triggering render.
 * @param timeoutMs - fallback delay in case no rAF is serviced in time
 *   (hidden tab). Deps are injected so this is exercisable under the Node
 *   test runner without a DOM/rAF (same pattern as `cacheTier.ts`).
 */
export interface FrameOrTimeoutDeps {
  requestFrame: (cb: () => void) => unknown;
  setTimeoutFn: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn: (id: unknown) => void;
}

const browserDeps: FrameOrTimeoutDeps = {
  requestFrame: (cb) => globalThis.requestAnimationFrame(cb),
  setTimeoutFn: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeoutFn: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function waitForFrameOrTimeout(
  frames: 1 | 2 = 1,
  timeoutMs = 200,
  deps: FrameOrTimeoutDeps = browserDeps,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      deps.clearTimeoutFn(timer);
      resolve();
    };
    const timer = deps.setTimeoutFn(done, timeoutMs);
    if (frames === 2) {
      deps.requestFrame(() => deps.requestFrame(done));
    } else {
      deps.requestFrame(done);
    }
  });
}
