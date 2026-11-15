// SPDX-License-Identifier: MPL-2.0
import { normalizeGaussianAttributes, type GaussianRowSource } from '@ifc-lite/renderer';
import type { GaussianDecoded } from './gaussianDecoded.js';
import type { GaussianCaptureSummary, GaussianDecodeReply, GaussianDecodeRequest } from './gaussianDecodeSession.js';

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

/** Rows of one capture per read, pulled from a dedicated worker (#9018). */
export const GAUSSIAN_STREAM_ROWS = 32_768;

/** A capture's summary plus its canonical rows: every read decodes the file again in a fresh worker. */
export interface GaussianCaptureRows extends GaussianCaptureSummary {
  rows: GaussianRowSource;
  /** Ends the decode kept open for the first read, if that read never happens. */
  close(): void;
}

interface StreamWorker { summary: GaussianCaptureSummary; next(start: number, count: number): Promise<Record<string, Float32Array>>; close(): void }

function openStreamWorker(file: File, signal?: AbortSignal): Promise<StreamWorker> {
  if (signal?.aborted) return Promise.reject(new DOMException('Gaussian load cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gaussianDecode.worker.ts', import.meta.url), { type: 'module' });
    let closed = false;
    let pending: { resolve(value: GaussianDecodeReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
    const fail = (error: Error) => { const p = pending; pending = null; if (p) { clearTimeout(p.timer); p.reject(error); } close(); };
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      if (pending) { clearTimeout(pending.timer); pending.reject(new DOMException('Gaussian decode closed.', 'AbortError')); pending = null; }
    };
    const abort = () => fail(new DOMException('Gaussian load cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = () => fail(new Error('Gaussian decoder worker failed.'));
    worker.onmessageerror = () => fail(new Error('Gaussian decoder transfer failed.'));
    worker.onmessage = (event: MessageEvent<GaussianDecodeReply>) => {
      const p = pending; pending = null;
      if (!p) return;
      clearTimeout(p.timer);
      if (event.data.ok) p.resolve(event.data);
      else { p.reject(new Error(event.data.reason)); close(); }
    };
    const request = (message: GaussianDecodeRequest, ms: number) => new Promise<GaussianDecodeReply>((ok, ko) => {
      if (closed) { ko(new DOMException('Gaussian decode closed.', 'AbortError')); return; }
      pending = { resolve: ok, reject: ko, timer: setTimeout(() => fail(new Error('Gaussian decoding timed out.')), ms) };
      try { worker.postMessage(message); } catch (error) { fail(error instanceof Error ? error : new Error('Gaussian worker initialization failed.')); }
    });
    request({ type: 'open', file }, 120_000).then((reply) => {
      if (reply.type !== 'summary') throw new Error('Gaussian decoder replied out of order.');
      resolve({
        summary: reply.summary,
        next: async (start, count) => {
          const rows = await request({ type: 'rows', start, count }, 30_000);
          if (rows.type !== 'rows' || rows.start !== start || rows.count !== count) throw new Error('Gaussian decoder replied out of order.');
          return rows.columns;
        },
        close,
      });
    }, (error: unknown) => { close(); reject(error); });
  });
}

/**
 * Open a capture for the renderer. The first read reuses the decode that produced
 * the summary; later reads (re-placement, repack, device recovery) decode the file
 * again. No read keeps more than one slice of rows on the main thread.
 */
export async function openGaussianCaptureRows(file: File, signal?: AbortSignal): Promise<GaussianCaptureRows> {
  let first: StreamWorker | null = await openStreamWorker(file, signal);
  const summary = first.summary;
  const rows: GaussianRowSource = {
    count: summary.count, sphericalHarmonicsDegree: summary.shDegree,
    effectiveShDegree: summary.effectiveShDegree, maxAbsShCoefficient: summary.maxAbsShCoefficient,
    async read(visit, readSignal) {
      const stream = first ?? await openStreamWorker(file, readSignal);
      first = null;
      try {
        for (let start = 0; start < summary.count; start += GAUSSIAN_STREAM_ROWS) {
          readSignal?.throwIfAborted();
          const count = Math.min(GAUSSIAN_STREAM_ROWS, summary.count - start);
          const columns = await stream.next(start, count);
          await visit(normalizeGaussianAttributes({ count, shDegree: summary.shDegree, columns }), start);
        }
      } finally { stream.close(); }
    },
  };
  return { ...summary, rows, close: () => { first?.close(); first = null; } };
}
