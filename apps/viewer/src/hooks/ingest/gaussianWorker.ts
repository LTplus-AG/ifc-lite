// SPDX-License-Identifier: MPL-2.0
import type { GaussianDecoded } from './gaussianDecoded.js';

/** CPU decode only. Caller must still verify renderer readiness and load generation. */
export function decodeGaussianInWorker(file: File, signal: AbortSignal): Promise<GaussianDecoded> {
  if (signal.aborted) return Promise.reject(new DOMException('Gaussian load cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gaussianDecode.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error?: Error, value?: GaussianDecoded) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      clearTimeout(timeout);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const abort = () => finish(new DOMException('Gaussian load cancelled.', 'AbortError'));
    const timeout = setTimeout(() => finish(new Error('Gaussian decoding timed out.')), 120_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(new Error('Gaussian decoder worker failed.'));
    worker.onmessageerror = () => finish(new Error('Gaussian decoder transfer failed.'));
    worker.onmessage = (event: MessageEvent<{ ok: true; decoded: GaussianDecoded } | { ok: false; reason: string }>) => {
      if (signal.aborted) { abort(); return; }
      if (event.data.ok) finish(undefined, event.data.decoded);
      else finish(new Error(event.data.reason));
    };
    try { worker.postMessage(file); }
    catch (error) { finish(error instanceof Error ? error : new Error('Gaussian worker initialization failed.')); }
  });
}
