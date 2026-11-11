/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The lazily loaded half of the warm shell (warm-shell.ts): whether to mount
 * it early, when, and when its renderer is ready.
 */

import { readPerfFlag } from '@/lib/perf/flags';
import { mayWarmUp, scheduleWhenIdle } from '@/lib/warm-runtime-gate';

/**
 * Call `mount` at the next idle period on a visible tab, or settle at once when
 * this browser must not warm up. Returns a cancel function.
 */
export function scheduleWarmShell(mount: () => void, settle: () => void): () => void {
  if (!mayWarmUp(readPerfFlag('warmShell'))) {
    settle();
    return () => {};
  }
  return scheduleWhenIdle(mount);
}

/**
 * Settle once the warm shell's renderer has initialised (its debug hooks
 * install on init). Settled means no more idle boot work is coming, not that
 * it succeeded: a renderer that has not initialised after ~10 s of frames is
 * reported and stops holding boot (the viewport shows its own init error, and
 * the scoreboard records renderer readiness separately).
 */
export function settleWhenRendererReady(settle: () => void): void {
  let frames = 0;
  const poll = () => {
    if (typeof (globalThis as { __ifc_lite_render_stats__?: unknown }).__ifc_lite_render_stats__ === 'function') {
      settle();
      return;
    }
    if (++frames > 600) {
      console.warn('[warm-shell] renderer not initialised after ~10 s; boot no longer waits for it');
      settle();
      return;
    }
    requestAnimationFrame(poll);
  };
  poll();
}
