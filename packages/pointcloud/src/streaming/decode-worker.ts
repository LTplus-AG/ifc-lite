/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Web Worker entry — owns one or more streaming sources, decodes off
 * the main thread, ships chunks back as transferable typed-array
 * buffers. Bundlers (Vite, esbuild) understand the
 * `new Worker(new URL(..., import.meta.url))` idiom and emit the worker
 * as its own chunk.
 *
 * Phase 1: LAS only. Phase 2 adds LAZ via `laz-perf`. The format switch
 * lives in `createSource` so the rest of the worker is format-agnostic.
 */

/// <reference lib="webworker" />

import type { StreamingPointSource } from './types.js';
import {
  chunkToWire,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.js';
import { LasStreamingSource } from './las-source.js';
import { LazStreamingSource } from './laz-source.js';
import { PlyStreamingSource } from './ply-source.js';
import { PcdStreamingSource } from './pcd-source.js';
import { E57StreamingSource } from './e57-source.js';
import { AsciiPointsStreamingSource } from './ascii-points-source.js';

declare const self: DedicatedWorkerGlobalScope;

interface OpenSource {
  source: StreamingPointSource;
  abort: AbortController;
}

const sources = new Map<number, OpenSource>();
let nextSourceId = 1;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.kind) {
    case 'open':
      void handleOpen(msg);
      return;
    case 'next':
      void handleNext(msg);
      return;
    case 'close':
      handleClose(msg.sourceId);
      return;
    case 'abort':
      handleAbort(msg.sourceId);
      return;
  }
};

async function handleOpen(msg: Extract<WorkerRequest, { kind: 'open' }>): Promise<void> {
  try {
    const source = createSource(msg.format, msg.blob, {
      label: msg.label,
      downsample: { stride: Math.max(1, msg.stride | 0) },
    });
    const abort = new AbortController();
    const info = await source.open(abort.signal);
    const sourceId = nextSourceId++;
    sources.set(sourceId, { source, abort });
    post({
      kind: 'opened',
      requestId: msg.requestId,
      sourceId,
      info,
    });
  } catch (err) {
    post({
      kind: 'error',
      requestId: msg.requestId,
      message: errMessage(err),
    });
  }
}

async function handleNext(msg: Extract<WorkerRequest, { kind: 'next' }>): Promise<void> {
  const open = sources.get(msg.sourceId);
  if (!open) {
    post({
      kind: 'error',
      requestId: msg.requestId,
      message: `Unknown sourceId ${msg.sourceId}`,
    });
    return;
  }
  try {
    const chunk = await open.source.next(msg.maxPoints, open.abort.signal);
    if (!chunk) {
      post({
        kind: 'chunk',
        requestId: msg.requestId,
        sourceId: msg.sourceId,
        chunk: null,
      });
      return;
    }
    const { payload, transfer } = chunkToWire(chunk);
    post(
      {
        kind: 'chunk',
        requestId: msg.requestId,
        sourceId: msg.sourceId,
        chunk: payload,
      },
      transfer,
    );
  } catch (err) {
    post({
      kind: 'error',
      requestId: msg.requestId,
      message: errMessage(err),
    });
  }
}

function handleClose(sourceId: number): void {
  const open = sources.get(sourceId);
  if (!open) return;
  try {
    open.abort.abort();
    open.source.close();
  } catch (err) {
    console.warn('[decode-worker] close failed:', errMessage(err));
  }
  sources.delete(sourceId);
}

function handleAbort(sourceId: number): void {
  const open = sources.get(sourceId);
  if (!open) return;
  open.abort.abort();
}

function createSource(
  format: 'las' | 'laz' | 'ply' | 'pcd' | 'e57' | 'pts' | 'xyz',
  blob: Blob,
  opts: { label?: string; downsample: { stride: number } },
): StreamingPointSource {
  if (format === 'las') return new LasStreamingSource(blob, opts);
  if (format === 'laz') return new LazStreamingSource(blob, opts);
  if (format === 'ply') return new PlyStreamingSource(blob, opts);
  if (format === 'pcd') return new PcdStreamingSource(blob, opts);
  if (format === 'e57') return new E57StreamingSource(blob, opts);
  if (format === 'pts') return new AsciiPointsStreamingSource(blob, 'pts', opts);
  if (format === 'xyz') return new AsciiPointsStreamingSource(blob, 'xyz', opts);
  throw new Error(`decode-worker: unknown format "${format}"`);
}

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
