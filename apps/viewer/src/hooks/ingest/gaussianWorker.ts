// SPDX-License-Identifier: MPL-2.0
import { normalizeGaussianAttributes, type GaussianRowSource, type NormalizedGaussianAttributes } from '@ifc-lite/renderer';
import type { GaussianDecoded } from './gaussianDecoded.js';
import { GAUSSIAN_STREAM_ROWS, type GaussianCaptureSummary, type GaussianDecodeReply, type GaussianDecodeRequest } from './gaussianDecodeSession.js';

export { GAUSSIAN_STREAM_ROWS };

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

/** A capture's summary plus its canonical rows: every later read streams the file again in a fresh worker. */
export interface GaussianCaptureRows extends GaussianCaptureSummary {
  rows: GaussianRowSource;
  /** Ends the decode kept open for the first read, if that read never happens. */
  close(): void;
}

type GaussianDecodeOk = Extract<GaussianDecodeReply, { ok: true }>;

interface StreamWorker {
  summary: GaussianCaptureSummary;
  /** `spent`: the previous reply's columns, transferred back so neither side allocates per slice. */
  next(start: number, count: number, spent?: Record<string, Float32Array>): Promise<Record<string, Float32Array>>;
  close(): void;
}

function openStreamWorker(file: File, signal?: AbortSignal, known?: GaussianCaptureSummary): Promise<StreamWorker> {
  if (signal?.aborted) return Promise.reject(new DOMException('Gaussian load cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./gaussianDecode.worker.ts', import.meta.url), { type: 'module' });
    let closed = false;
    let pending: { resolve(value: GaussianDecodeOk): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;
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
      const reply = event.data;
      if (reply.ok) p.resolve(reply);
      else { p.reject(new Error(reply.reason)); close(); }
    };
    const request = (message: GaussianDecodeRequest, ms: number, transfer: Transferable[] = []) => new Promise<GaussianDecodeOk>((ok, ko) => {
      if (closed) { ko(new DOMException('Gaussian decode closed.', 'AbortError')); return; }
      pending = { resolve: ok, reject: ko, timer: setTimeout(() => fail(new Error('Gaussian decoding timed out.')), ms) };
      try { worker.postMessage(message, { transfer }); } catch (error) { fail(error instanceof Error ? error : new Error('Gaussian worker initialization failed.')); }
    });
    request({ type: 'open', file, ...(known ? { summary: known } : {}) }, 120_000).then((reply) => {
      if (reply.type !== 'summary') throw new Error('Gaussian decoder replied out of order.');
      resolve({
        summary: reply.summary,
        next: async (start, count, spent) => {
          const transfer = spent ? [...new Set(Object.values(spent).map(column => column.buffer as ArrayBuffer))] : [];
          const rows = await request({ type: 'rows', start, count, ...(spent ? { recycle: spent } : {}) }, 30_000, transfer);
          if (rows.type !== 'rows' || rows.start !== start || rows.count !== count) throw new Error('Gaussian decoder replied out of order.');
          return rows.columns;
        },
        close,
      });
    }, (error: unknown) => { close(); reject(error); });
  });
}

/**
 * Open a capture for the renderer. The first read reuses the worker that validated
 * and summarized the capture; later reads (re-placement, repack, device recovery)
 * stream the file again in a fresh worker, skipping the summary pass. Neither the
 * worker nor the main thread holds more than one slice of rows.
 */
export async function openGaussianCaptureRows(file: File, signal?: AbortSignal): Promise<GaussianCaptureRows> {
  let first: StreamWorker | null = await openStreamWorker(file, signal);
  const summary = first.summary;
  const rows: GaussianRowSource = {
    count: summary.count, sphericalHarmonicsDegree: summary.shDegree,
    effectiveShDegree: summary.effectiveShDegree, maxAbsShCoefficient: summary.maxAbsShCoefficient,
    async read(visit, readSignal) {
      const reused = first;
      first = null;
      const stream = reused ?? await openStreamWorker(file, readSignal, summary);
      // The first worker was opened before this read: make it observe this read's signal too.
      const abort = () => stream.close();
      if (reused) readSignal?.addEventListener('abort', abort, { once: true });
      // One slice's arrays on the main thread at a time: the decoded columns go back to the
      // worker with the next request, and the normalized rows are rewritten in place (the
      // visitor copies what it keeps), so streaming a capture allocates no per-slice garbage.
      let normalized: NormalizedGaussianAttributes | undefined;
      let spent: Record<string, Float32Array> | undefined;
      try {
        for (let start = 0; start < summary.count; start += GAUSSIAN_STREAM_ROWS) {
          readSignal?.throwIfAborted();
          const count = Math.min(GAUSSIAN_STREAM_ROWS, summary.count - start);
          const columns = await stream.next(start, count, spent);
          normalized = normalizeGaussianAttributes({ count, shDegree: summary.shDegree, columns }, normalized);
          spent = columns;
          await visit(normalized, start);
          readSignal?.throwIfAborted(); // a visitor may abort, also during the last window
        }
      } finally {
        readSignal?.removeEventListener('abort', abort);
        stream.close();
      }
    },
  };
  return { ...summary, rows, close: () => { first?.close(); first = null; } };
}
