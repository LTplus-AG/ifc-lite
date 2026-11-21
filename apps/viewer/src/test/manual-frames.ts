/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Animation frames a test runs by hand. Eased work (wheel zoom, #9507) then
 * settles when the test says so, in a known number of frames, instead of after
 * a real-time wait that a slow CI runner can outlast.
 *
 *   const frames = installManualFrames();
 *   canvas.dispatchEvent(wheel);   // the first slice lands in the event
 *   frames.flush();                // the rest of the ease, every queued frame
 *   frames.restore();
 */

export interface ManualFrames {
  /** Runs queued frames, and the frames they queue, until none is left. Returns how many ran. */
  flush(limit?: number): number;
  /** Runs one frame: the callbacks queued now, not the ones they queue. Returns how many ran. */
  step(): number;
  /** Frames queued and not yet run. */
  pending(): number;
  restore(): void;
}

export function installManualFrames(): ManualFrames {
  const savedRequest = globalThis.requestAnimationFrame;
  const savedCancel = globalThis.cancelAnimationFrame;
  const queue = new Map<number, FrameRequestCallback>();
  let next = 0;
  globalThis.requestAnimationFrame = (callback) => { queue.set(++next, callback); return next; };
  globalThis.cancelAnimationFrame = (handle) => { queue.delete(handle); };
  const step = () => {
    let ran = 0;
    const now = performance.now(); // one frame, one timestamp, as in a browser
    for (const handle of [...queue.keys()]) {
      const callback = queue.get(handle);
      if (!callback) continue; // cancelled by an earlier callback in this frame
      queue.delete(handle);
      callback(now);
      ran++;
    }
    return ran;
  };
  return {
    flush(limit = 10_000) {
      let ran = 0;
      while (queue.size > 0) {
        if (ran + queue.size > limit) throw new Error(`more than ${limit} frame callbacks run or queued: something re-queues forever`);
        ran += step();
      }
      return ran;
    },
    step,
    pending: () => queue.size,
    restore() {
      globalThis.requestAnimationFrame = savedRequest;
      globalThis.cancelAnimationFrame = savedCancel;
    },
  };
}
