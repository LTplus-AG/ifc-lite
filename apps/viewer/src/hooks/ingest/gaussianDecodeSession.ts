// SPDX-License-Identifier: MPL-2.0
import type { GaussianDecoded } from './gaussianDecoded.js';

/**
 * #9018 streaming decode protocol of the dedicated Gaussian worker. `open` reads the
 * capture once, validating every row, and replies with its summary (an `open` that
 * carries the summary of an earlier open of the same File skips that pass); each
 * `rows` request then decodes and transfers one bounded slice. Neither side ever
 * holds the whole capture: the worker range-reads the File one window at a time
 * (see gaussianDecodeStream), and the renderer places each slice and writes it
 * straight to the GPU.
 */
export type GaussianDecodeRequest =
  | { type: 'open'; file: File; summary?: GaussianCaptureSummary }
  | { type: 'rows'; start: number; count: number; recycle?: Record<string, Float32Array> };

/** Rows per `rows` request, and the worker's decode window (one window is normalized on the main thread at a time). */
export const GAUSSIAN_STREAM_ROWS = 16_384;

export interface GaussianCaptureSummary extends Pick<GaussianDecoded, 'count' | 'shDegree' | 'centerBounds' | 'decodeOrigin'> {
  /** Highest SH band holding a non-zero coefficient. */
  effectiveShDegree: 0 | 1 | 2 | 3;
  /** Largest |SH coefficient| (higher-order bands only). */
  maxAbsShCoefficient: number;
}

export type GaussianDecodeReply =
  | { ok: true; type: 'summary'; summary: GaussianCaptureSummary }
  | { ok: true; type: 'rows'; start: number; count: number; columns: Record<string, Float32Array> }
  | { ok: false; reason: string };

/** What the session needs of a streaming decoder (gaussianDecodeStream in production). */
export interface GaussianRowStream {
  readonly summary: GaussianCaptureSummary;
  rows(start: number, count: number): Promise<Record<string, Float32Array>>;
  /** Columns of an earlier reply the main thread transferred back, for reuse. */
  recycle?(columns: Readonly<Record<string, Float32Array>>): void;
  close(): Promise<void>;
}

/** The worker side: one capture per session. */
export function createGaussianDecodeSession(open: (file: File, summary?: GaussianCaptureSummary) => Promise<GaussianRowStream>) {
  let stream: GaussianRowStream | null = null;
  let opening = false;
  return async (request: GaussianDecodeRequest): Promise<{ reply: GaussianDecodeReply; transfer: Transferable[] }> => {
    try {
      if (request.type === 'open') {
        if (stream || opening) throw new Error('A Gaussian decode session opens one capture.');
        opening = true;
        stream = await open(request.file, request.summary);
        return { reply: { ok: true, type: 'summary', summary: stream.summary }, transfer: [] };
      }
      if (!stream) throw new Error('No Gaussian capture is open.');
      if (request.recycle && typeof request.recycle === 'object') stream.recycle?.(request.recycle);
      const { start, count } = request;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1 || start + count > stream.summary.count) {
        throw new Error('Gaussian row request outside the capture.');
      }
      const columns = await stream.rows(start, count);
      const transfer = [...new Set(Object.values(columns).map(column => column.buffer))];
      return { reply: { ok: true, type: 'rows', start, count, columns }, transfer };
    } catch (error) {
      return { reply: { ok: false, reason: error instanceof Error ? error.message : 'Gaussian decoding failed.' }, transfer: [] };
    }
  };
}

/** Exact effective SH degree and coefficient range of a decoded capture. */
export function summarizeGaussianDecoded(decoded: GaussianDecoded): GaussianCaptureSummary {
  const { count, shDegree, centerBounds, decodeOrigin, columns } = decoded;
  const basis = (shDegree + 1) ** 2 - 1;
  let effective = 0;
  let maxAbs = 0;
  for (let b = 0; b < basis; b++) {
    const band = Math.floor(Math.sqrt(b + 1));
    for (let axis = 0; axis < 3; axis++) {
      const column = columns[`f_rest_${axis * basis + b}`];
      for (let row = 0; row < count; row++) {
        const value = Math.abs(column[row]);
        if (value > maxAbs) maxAbs = value;
        if (value !== 0 && band > effective) effective = band;
      }
    }
  }
  return { count, shDegree, centerBounds, decodeOrigin, effectiveShDegree: effective as 0 | 1 | 2 | 3, maxAbsShCoefficient: maxAbs };
}
