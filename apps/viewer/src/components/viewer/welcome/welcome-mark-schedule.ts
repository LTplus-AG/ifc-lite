/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When the start screen's 3D mark may start (see `ViewportWelcome`).
 *
 * With `requestIdleCallback`: the first idle period, at most `timeoutMs`
 * later on a busy page. Without it (Safari): the main thread is sampled with
 * a 50 ms timer, and the mark starts after two samples in a row that ran on
 * time (no task held the thread for more than `LATE_MS`). A busy page keeps
 * the mark waiting until `timeoutMs`; a quiet page starts it after ~100 ms.
 * A plain wall-clock timer would start it in the middle of whatever the page
 * was doing at that moment.
 */

export interface IdleHost {
  requestIdleCallback?: (cb: () => void, options: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (cb: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  now: () => number;
}

export const SAMPLE_MS = 50;
export const LATE_MS = 15;
const QUIET_SAMPLES = 2;

const windowHost = (): IdleHost => ({
  requestIdleCallback: typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback.bind(window) : undefined,
  cancelIdleCallback: typeof window.cancelIdleCallback === 'function' ? window.cancelIdleCallback.bind(window) : undefined,
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (h) => window.clearTimeout(h),
  now: () => performance.now(),
});

/** Run `cb` once the main thread is quiet (bounded by `timeoutMs`); returns a cancel. */
export function whenQuiet(cb: () => void, timeoutMs: number, host: IdleHost = windowHost()): () => void {
  if (host.requestIdleCallback) {
    const handle = host.requestIdleCallback(cb, { timeout: timeoutMs });
    return () => host.cancelIdleCallback?.(handle);
  }
  const start = host.now();
  let quiet = 0;
  let handle = 0;
  const sample = (due: number) => {
    handle = host.setTimeout(() => {
      const t = host.now();
      quiet = t - due <= LATE_MS ? quiet + 1 : 0;
      if (quiet >= QUIET_SAMPLES || t - start >= timeoutMs) cb();
      else sample(t + SAMPLE_MS);
    }, SAMPLE_MS);
  };
  sample(start + SAMPLE_MS);
  return () => host.clearTimeout(handle);
}
