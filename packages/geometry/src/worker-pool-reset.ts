/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

let nextReset = 0;
export interface GeometryWorkerResetMessage { type: 'pool-reset'; token: number }

/** Fail closed on errors, timeout, or an unmeasured heap. The old load handler is detached. */
export function resetGeometryWorker(worker: Worker, timeoutMs: number, signal?: AbortSignal): Promise<number | null> {
  const token = ++nextReset;
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (heap: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      resolve(heap);
    };
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish(null), timeoutMs);
    worker.onerror = () => finish(null);
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      const reply = data as { type?: unknown; token?: unknown; wasmHeapBytes?: unknown } | null;
      if (reply?.type === 'error') return finish(null);
      if (reply?.type !== 'pool-reset-done' || reply.token !== token) return;
      const heap = reply.wasmHeapBytes;
      finish(typeof heap === 'number' && Number.isSafeInteger(heap) && heap > 0 ? heap : null);
    };
    try { worker.postMessage({ type: 'pool-reset', token } satisfies GeometryWorkerResetMessage); }
    catch (error) {
      console.warn('[pool] reset dispatch failed:', error);
      finish(null);
    }
  });
}
