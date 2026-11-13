/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "The settled scene has been drawn": the one wait that post-load work runs
 * behind, so it cannot take the main thread before the viewport has drawn the
 * scene the load just finished. Settle consumers reach it through
 * `afterSceneSettled` / `whenSceneSettled` (scene-settled.ts); the load window
 * (hooks/loadWindow.ts) uses it for its releases.
 *
 * A settled scene is final, but not yet drawn: the animation loop draws it in a
 * later animation frame, and can hold a requested draw back while the GPU still
 * owes frames (useAnimationLoop's frame pacer). Work started by a timer in
 * between ran first. On Holter the 100 ms settle poll landed 1-4 ms after
 * finalize and ran the cache write's encode (80-200 ms) before the frame that
 * shows the model; a load window release could run the panels' render
 * (~160 ms) the same way.
 *
 * The wait ends, and its work then runs in a task of its own, when:
 * - the viewport submitted a live frame after the call (live-frame-count.ts,
 *   counted by viewport-capture's `noteLiveFrameSubmitted`), or
 * - two animation frames in a row passed with no draw pending: what is on screen
 *   is already final, or there is no device to draw with; or
 * - `SETTLED_FRAME_BACKSTOP_MS` passed: frames stop in a hidden tab, and a draw
 *   that stays pending without a frame ever being submitted must not hold the
 *   work for good.
 */

import { getGlobalRenderer } from '@/hooks/useBCF';
import { liveFrameCount } from './live-frame-count';

export const SETTLED_FRAME_BACKSTOP_MS = 1_000;
/** Animation frames with nothing pending that count as "drawn". */
const IDLE_FRAMES = 2;

/** The viewer's next animation frame; a timer where the host has none. */
export function viewerRequestFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
}

export interface SettledFrameDeps {
  /** Live viewport frames submitted so far. */
  frameCount: () => number;
  /** The viewport has a draw it has not submitted yet. */
  drawPending: () => boolean;
  requestFrame: (fn: () => void) => void;
  /** Arm a timer; returns its cancel. */
  setTimer: (fn: () => void, ms: number) => () => void;
}

/** Run `fn` in a task once the settled scene has been drawn (see above); returns a cancel. Runs at most once. */
export type AfterSettledFrame = (fn: () => void) => () => void;

export function createAfterSettledFrame(deps: SettledFrameDeps): AfterSettledFrame {
  return (fn) => {
    const start = deps.frameCount();
    let done = false;
    let idleFrames = 0;
    let cancelBackstop = (): void => {};
    const finish = (): void => { done = true; cancelBackstop(); };
    const run = (): void => {
      if (done) return;
      finish();
      fn();
    };
    const check = (): void => {
      if (done) return;
      idleFrames = deps.drawPending() ? 0 : idleFrames + 1;
      // A task of its own: not inside the animation frame that drew the scene.
      if (deps.frameCount() > start || idleFrames >= IDLE_FRAMES) deps.setTimer(run, 0);
      else deps.requestFrame(check);
    };
    cancelBackstop = deps.setTimer(run, SETTLED_FRAME_BACKSTOP_MS);
    if (!done) deps.requestFrame(check);
    return finish;
  };
}

function viewerDrawPending(): boolean {
  const renderer = getGlobalRenderer();
  // No renderer or no device: nothing can be drawn, so nothing is pending.
  if (!renderer?.getGPUDevice?.()) return false;
  return renderer.peekRenderRequest?.() ?? false;
}

/** The viewer's wait, on the viewport's animation loop. */
export const afterSettledFrame: AfterSettledFrame = createAfterSettledFrame({
  frameCount: liveFrameCount,
  drawPending: viewerDrawPending,
  requestFrame: viewerRequestFrame,
  setTimer: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
});
