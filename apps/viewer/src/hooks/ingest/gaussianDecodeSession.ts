// SPDX-License-Identifier: MPL-2.0
import type { GaussianDecoded } from './gaussianDecoded.js';

/**
 * #9018 streaming decode protocol of the dedicated Gaussian worker. `open` decodes
 * the capture once inside the worker and replies with its summary; each `rows`
 * request then transfers one bounded slice of the decoded columns. The main thread
 * pulls slices one at a time, so it never holds the whole capture: the renderer
 * places each slice and writes it straight to the GPU.
 */
export type GaussianDecodeRequest =
  | { type: 'open'; file: File }
  | { type: 'rows'; start: number; count: number };

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

/** The worker side: one capture per session. */
export function createGaussianDecodeSession(decode: (file: File) => Promise<GaussianDecoded>) {
  let decoded: GaussianDecoded | null = null;
  return async (request: GaussianDecodeRequest): Promise<{ reply: GaussianDecodeReply; transfer: Transferable[] }> => {
    try {
      if (request.type === 'open') {
        if (decoded) throw new Error('A Gaussian decode session opens one capture.');
        decoded = await decode(request.file);
        return { reply: { ok: true, type: 'summary', summary: summarizeGaussianDecoded(decoded) }, transfer: [] };
      }
      if (!decoded) throw new Error('No Gaussian capture is open.');
      const { start, count } = request;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1 || start + count > decoded.count) {
        throw new Error('Gaussian row request outside the capture.');
      }
      const columns: Record<string, Float32Array> = {};
      for (const [name, column] of Object.entries(decoded.columns)) columns[name] = column.slice(start, start + count);
      return { reply: { ok: true, type: 'rows', start, count, columns }, transfer: Object.values(columns).map(column => column.buffer) };
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
