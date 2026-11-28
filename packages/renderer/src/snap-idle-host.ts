/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Idle-time scheduling for the screen-corner snap build (#11504). Candidate
 * building and screen-grid building run in `requestIdleCallback` slices (a
 * `setTimeout` slice where it does not exist), never inside a pointer move.
 */

export interface IdleSlice {
  /** Milliseconds this slice may still use. */
  timeRemaining(): number;
  /** True when the host ran the slice only because its timeout expired (the main thread was never idle). */
  didTimeout: boolean;
}

/** Where idle slices come from; tests inject a manual one. */
export interface IdleHost {
  /** Run `cb` once, no earlier than `afterMs`, when the main thread is idle. Returns a handle for `cancel`. */
  request(cb: (slice: IdleSlice) => void, afterMs?: number): unknown;
  cancel(handle: unknown): void;
}

/** Longest a fallback slice runs, and how long a slice waits for idle time before it is forced. */
const FALLBACK_SLICE_MS = 8;
const IDLE_TIMEOUT_MS = 250;

interface TimerHandle { timer?: ReturnType<typeof setTimeout>; idle?: number }

/** `requestIdleCallback` when the page has it, else a short `setTimeout` slice. */
export function browserIdleHost(): IdleHost {
  const g = globalThis as { requestIdleCallback?: (cb: (d: IdleSlice) => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
  const clock = () => performance.now();
  const run = (cb: (slice: IdleSlice) => void, handle: TimerHandle) => {
    if (g.requestIdleCallback) {
      handle.idle = g.requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS });
      return;
    }
    handle.timer = setTimeout(() => {
      const end = clock() + FALLBACK_SLICE_MS;
      cb({ timeRemaining: () => Math.max(0, end - clock()), didTimeout: false });
    }, 0);
    (handle.timer as { unref?: () => void }).unref?.();
  };
  return {
    request(cb, afterMs = 0) {
      const handle: TimerHandle = {};
      if (afterMs > 0) {
        handle.timer = setTimeout(() => run(cb, handle), afterMs);
        (handle.timer as { unref?: () => void }).unref?.();
      } else run(cb, handle);
      return handle;
    },
    cancel(h) {
      const handle = h as TimerHandle;
      if (handle.timer !== undefined) clearTimeout(handle.timer);
      if (handle.idle !== undefined) g.cancelIdleCallback?.(handle.idle);
    },
  };
}
