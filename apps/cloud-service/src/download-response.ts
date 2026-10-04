/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DownloadFile } from './download-file.js';
/** Abort owns cleanup even when a browser never begins reading the response. */
export function downloadResponse(file: DownloadFile, signal: AbortSignal, done: () => void): Response {
  const reader = file.stream.getReader(); let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      signal.removeEventListener('abort', abort);
      try { await reader.cancel(); }
      finally {
        try { reader.releaseLock(); await file.dispose(); }
        finally { done(); }
      }
    })(); return cleanupPromise;
  };
  const abort = () => { void cleanup().catch(() => console.warn('Cloud download cleanup failed')); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted(); const next = await reader.read();
        if (next.done) { await cleanup(); controller.close(); } else controller.enqueue(next.value);
      } catch (error) { await cleanup(); controller.error(error); }
    }, cancel: cleanup,
  });
  return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size), 'Cache-Control': 'no-store' } });
}
