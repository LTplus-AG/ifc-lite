/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const pending = new Set<() => void>();

/** Start already-captured writes before replacing a model or hiding the tab. */
export function flushDeferredCacheWrites(): void {
  for (const start of [...pending]) start();
}

export interface CacheWriteScheduler {
  idle(start: () => void): () => void;
  leaving(start: () => void): () => void;
}

const browserScheduler: CacheWriteScheduler = {
  idle(start) {
    // A bounded task fallback also runs in browsers without idle callbacks.
    const timer = setTimeout(start, 1000);
    const idle = typeof requestIdleCallback === 'function' ? requestIdleCallback(start, { timeout: 1000 }) : null;
    return () => {
      clearTimeout(timer);
      if (idle !== null) cancelIdleCallback(idle);
    };
  },
  leaving(start) {
    const hidden = () => { if (document.visibilityState === 'hidden') start(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', start);
    if (document.visibilityState === 'hidden') queueMicrotask(start);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', start);
    };
  },
};

/** Never cancel a cache write just because the next model supersedes its load. */
export function deferCacheWrite(write: () => Promise<unknown>, scheduler = browserScheduler): Promise<void> {
  return new Promise((resolve, reject) => {
    let started = false;
    let cancelIdle = () => {};
    let cancelLeaving = () => {};
    const start = () => {
      if (started) return;
      started = true;
      pending.delete(start);
      cancelIdle();
      cancelLeaving();
      // Invoke synchronously on pagehide/navigation, before replacing source.
      try { Promise.resolve(write()).then(() => resolve(), reject); }
      catch (error) { reject(error); }
    };
    pending.add(start);
    cancelIdle = scheduler.idle(start);
    cancelLeaving = scheduler.leaving(start);
  });
}
