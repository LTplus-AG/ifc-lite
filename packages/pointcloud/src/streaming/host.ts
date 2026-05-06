/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host-side helper that drives a `StreamingPointSource` to completion,
 * applies a memory-cap downsampling policy, and emits decoded chunks
 * to a callback.
 *
 * Renderers consume this directly: pass `onChunk` as your "upload to
 * GPU" callback and the host takes care of pacing, abort, and the
 * end-of-stream `onComplete` notification.
 */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';
import {
  createDecodeWorkerSource,
  type CreateDecodeWorkerSourceOptions,
  type DecodeWorkerFormat,
} from './worker-client.js';
import type { PointSourceInfo, StreamingPointSource } from './types.js';

export interface StreamPointCloudOptions {
  /** Source format. */
  format: DecodeWorkerFormat;
  /** File or remote-fetched blob. */
  blob: Blob;
  /** Optional label (filename, URL) for diagnostics. */
  label?: string;

  /**
   * Soft memory cap measured in points. When the source declares more
   * than this, the host applies stride-based downsampling so the chunks
   * fit. Default: 25 million (~600 MB GPU at the 24-byte/point format).
   */
  maxPointsInMemory?: number;
  /** Hard size ceiling — if `blob.size` exceeds, the call rejects. */
  maxFileSize?: number;
  /** Points per chunk during streaming decode. Default: 200_000. */
  chunkSize?: number;

  /** Called once after the source's header parses. */
  onOpen?: (info: PointSourceInfo & { stride: number }) => void;
  /** Called for each decoded chunk. */
  onChunk: (chunk: DecodedPointChunk) => void;
  /** Periodic progress signal in 0..1. */
  onProgress?: (loaded: number, total: number) => void;
  /** Called once with the aggregated bbox once the stream finishes. */
  onComplete?: (bbox: PointCloudBBox, totalEmitted: number) => void;
  /** Called if the source errors mid-stream. */
  onError?: (err: Error) => void;

  /** Abort signal for the whole stream. */
  signal?: AbortSignal;
  /** Override the source factory (used by tests). */
  createSource?: (opts: CreateDecodeWorkerSourceOptions) => StreamingPointSource;
}

const DEFAULT_MAX_POINTS = 25_000_000;
const DEFAULT_MAX_FILE = 4 * 1024 * 1024 * 1024; // 4 GB
const DEFAULT_CHUNK = 200_000;

export interface StreamHandle {
  /** Cancel pending and future decode work. */
  cancel(): void;
  /** Resolves once the stream finishes successfully or is cancelled. */
  done: Promise<void>;
}

export function streamPointCloud(opts: StreamPointCloudOptions): StreamHandle {
  const maxPoints = opts.maxPointsInMemory ?? DEFAULT_MAX_POINTS;
  const maxFile = opts.maxFileSize ?? DEFAULT_MAX_FILE;
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  // chunkSize <= 0 would let the source.next() loop emit empty chunks
  // forever without advancing its cursor. Fail loudly so callers can't
  // accidentally lock up the worker.
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    throw new Error(`streamPointCloud: chunkSize must be a positive finite number (got ${chunkSize})`);
  }

  const localAbort = new AbortController();
  const composed = composeAbort(opts.signal, localAbort.signal);

  const done = (async () => {
    if (opts.blob.size > maxFile) {
      throw new Error(
        `Point cloud rejected: file is ${(opts.blob.size / 1e6).toFixed(0)} MB, ` +
        `exceeds maxFileSize ${(maxFile / 1e6).toFixed(0)} MB`,
      );
    }

    const probeFactory = opts.createSource ?? createDecodeWorkerSource;
    let source: ReturnType<typeof probeFactory> | undefined;
    let totalEmitted = 0;
    let bboxMin: [number, number, number] = [Infinity, Infinity, Infinity];
    let bboxMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let info: PointSourceInfo | null = null;

    try {
      // First open with stride=1 to learn the true point count, then
      // re-open with the right stride if we need to downsample.
      let stride = 1;
      source = probeFactory({
        format: opts.format,
        blob: opts.blob,
        label: opts.label,
        stride: 1,
      });
      info = await source.open(composed);

      if (info.totalPointCount > maxPoints) {
        stride = Math.ceil(info.totalPointCount / maxPoints);
        source.close();
        source = probeFactory({
          format: opts.format,
          blob: opts.blob,
          label: opts.label,
          stride,
        });
        info = await source.open(composed);
      }

      opts.onOpen?.({ ...info, stride });

      while (true) {
        if (composed.aborted) break;
        const chunk = await source.next(chunkSize, composed);
        if (!chunk) break;
        opts.onChunk(chunk);
        totalEmitted += chunk.pointCount;
        if (chunk.bbox.min[0] < bboxMin[0]) bboxMin[0] = chunk.bbox.min[0];
        if (chunk.bbox.min[1] < bboxMin[1]) bboxMin[1] = chunk.bbox.min[1];
        if (chunk.bbox.min[2] < bboxMin[2]) bboxMin[2] = chunk.bbox.min[2];
        if (chunk.bbox.max[0] > bboxMax[0]) bboxMax[0] = chunk.bbox.max[0];
        if (chunk.bbox.max[1] > bboxMax[1]) bboxMax[1] = chunk.bbox.max[1];
        if (chunk.bbox.max[2] > bboxMax[2]) bboxMax[2] = chunk.bbox.max[2];
        opts.onProgress?.(totalEmitted, info.totalPointCount);
      }
    } finally {
      // Catches probe + open + onOpen + decode failures uniformly so
      // worker-backed sources don't leak the decoder on bad files.
      source?.close();
    }

    if (!composed.aborted && info) {
      const bbox: PointCloudBBox = Number.isFinite(bboxMin[0])
        ? { min: bboxMin, max: bboxMax }
        : info.bbox;
      opts.onComplete?.(bbox, totalEmitted);
    }
  })().catch((err) => {
    if (composed.aborted) return; // expected on cancel
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    throw err;
  });

  return {
    cancel: () => localAbort.abort(),
    done,
  };
}

function composeAbort(...signals: Array<AbortSignal | undefined>): AbortSignal {
  // Native AbortSignal.any was added in widely-shipping browsers in 2024.
  // Use the polyfilled fallback so tests in older Node still work.
  const filtered = signals.filter((s): s is AbortSignal => s !== undefined);
  if (filtered.length === 0) return new AbortController().signal;
  if (filtered.length === 1) return filtered[0];
  // Avoid `as any` per repo TypeScript rules — narrow to a concrete shape.
  type AbortSignalCtorWithAny = typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  const anyApi = (AbortSignal as AbortSignalCtorWithAny).any;
  if (typeof anyApi === 'function') return anyApi(filtered);
  const ctrl = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
