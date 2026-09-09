/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import {
  PDF_LIMITS,
  PdfAppearanceError,
  type PdfJob,
  type PdfJobResult,
  type PdfWorkerRequest,
  type PdfWorkerResponse,
} from './types.js';
export interface PdfWorker {
  onmessage: ((event: MessageEvent<PdfWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: PdfWorkerRequest): void;
  terminate(): void;
}
export interface PdfWorkerClient {
  run(
    source: Uint8Array,
    job: PdfJob,
    options?: { signal?: AbortSignal; password?: string },
  ): Promise<PdfJobResult>;
  cancel(): void;
  dispose(): void;
}
export function createPdfWorkerClient(
  options: { workerFactory?: () => PdfWorker; timeoutMs?: number } = {},
): PdfWorkerClient {
  const timeout = options.timeoutMs ?? PDF_LIMITS.timeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new PdfAppearanceError('budget', 'Invalid PDF job timeout.');
  const factory =
    options.workerFactory ??
    (() =>
      new Worker(new URL('./pdf.worker.ts', import.meta.url), {
        type: 'module',
      }));
  let sequence = 0,
    disposed = false,
    abortCurrent: (() => void) | undefined;
  const cancelled = () =>
    new PdfAppearanceError('cancelled', 'PDF import cancelled.');
  return {
    cancel() {
      abortCurrent?.();
    },
    dispose() {
      disposed = true;
      abortCurrent?.();
    },
    run(source, job, { signal, password } = {}) {
      abortCurrent?.();
      if (disposed || signal?.aborted) return Promise.reject(cancelled());
      if (!source.length || source.length > PDF_LIMITS.maxBytes)
        return Promise.reject(
          new PdfAppearanceError(
            'budget',
            'Choose a PDF no larger than 64 MiB.',
          ),
        );
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        let worker: PdfWorker;
        try {
          worker = factory();
        } catch (error) {
          reject(
            new PdfAppearanceError(
              'unsupported',
              `Cannot start PDF worker: ${String(error)}`,
            ),
          );
          return;
        }
        let settled = false,
          timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error, result?: PdfJobResult) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          worker.terminate();
          if (id === sequence) abortCurrent = undefined;
          if (error) reject(error);
          else resolve(result!);
        };
        const abort = () => finish(cancelled());
        abortCurrent = abort;
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(
          () =>
            finish(
              new PdfAppearanceError(
                'budget',
                'PDF page processing timed out. Choose a smaller document or crop.',
              ),
            ),
          timeout,
        );
        worker.onmessage = (event) => {
          const response = event.data;
          if (!response || response.id !== id || id !== sequence || settled)
            return;
          if ('error' in response) {
            finish(
              new PdfAppearanceError(
                response.error.code,
                response.error.message,
              ),
            );
            return;
          }
          if (!response.result || response.result.kind !== job.kind) {
            finish(
              new PdfAppearanceError(
                'render',
                'The PDF worker returned an unexpected result.',
              ),
            );
            return;
          }
          finish(undefined, response.result);
        };
        worker.onerror = (event) =>
          finish(
            new PdfAppearanceError(
              'render',
              event.message || 'The PDF worker stopped unexpectedly.',
            ),
          );
        worker.onmessageerror = () =>
          finish(
            new PdfAppearanceError(
              'render',
              'The PDF worker returned unreadable page data.',
            ),
          );
        try {
          worker.postMessage({ id, source, job, password });
        } catch (error) {
          finish(new PdfAppearanceError('render', String(error)));
        }
        if (signal?.aborted) abort();
      });
    },
  };
}
