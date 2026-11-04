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

import type { PointSourceInfo, StreamingPointSource } from './types.js';
import {
  chunkToWire,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.js';
import { normalizePointStride } from './stride.js';
// Format-specific decoders are lazy-imported in `createSource` below. That
// keeps the IIFE bundle this worker ships in (see scripts/build-worker-bundle.mjs)
// small — only the format the consumer actually opens gets pulled into the
// worker scope. Most importantly, the LAZ decoder (laz-perf, ~1 MB) doesn't
// get inlined into every consumer's bundle unless they actually decode .laz.

declare const self: DedicatedWorkerGlobalScope;

type OpenRequest = Extract<WorkerRequest, { kind: 'open' }>;

interface OpenSource {
  source: StreamingPointSource;
  abort: AbortController;
  /** The original request, so a source without its own `reopen()` can be rebuilt. */
  request: OpenRequest;
}

const sources = new Map<number, OpenSource>();
/** Aborts for `open` requests that have not answered yet, by requestId (#8777). */
const pendingOpens = new Map<number, AbortController>();
let nextSourceId = 1;

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.kind) {
    case 'open':
      void handleOpen(msg);
      return;
    case 'reopen':
      void handleReopen(msg);
      return;
    case 'abort-open':
      pendingOpens.get(msg.targetRequestId)?.abort();
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
    case 'copc-open':
    case 'copc-page':
    case 'copc-node':
    case 'copc-cancel':
      void handleCopc(msg);
      return;
  }
};

/** COPC readers are closed by the same `close` message as stream sources. */
let closeCopcSource: ((sourceId: number) => boolean) | undefined;

async function handleCopc(
  msg: Extract<WorkerRequest, { kind: 'copc-open' | 'copc-page' | 'copc-node' | 'copc-cancel' }>,
): Promise<void> {
  try {
    // Lazy like the format sources below: only COPC sessions load it.
    const host = await import('../copc/copc-worker-host.js');
    closeCopcSource = host.closeCopcSource;
    await host.handleCopcRequest(msg, post, () => nextSourceId++);
  } catch (err) {
    if (msg.kind !== 'copc-cancel') post({ kind: 'error', requestId: msg.requestId, message: errMessage(err) });
  }
}

async function handleOpen(msg: OpenRequest): Promise<void> {
  // Hoisted so the catch below can release a source that was created
  // (and possibly opened) but never made it into `sources` — see the
  // comment at the `post()` call.
  let opened: OpenSource | undefined;
  // Registered before the first await, so an `abort-open` that follows this
  // message always finds it, even mid-scan of a multi-GB file.
  const abort = new AbortController();
  pendingOpens.set(msg.requestId, abort);
  try {
    const source = await sourceFor(msg, normalizePointStride(msg.stride), msg.originOffset);
    const info = await source.open(abort.signal);
    opened = { source, abort, request: msg };
    const sourceId = nextSourceId++;
    // Report success to the client BEFORE registering the source. If
    // `post()` throws (e.g. a future `PointSourceInfo` field that isn't
    // structured-cloneable), the client never learns `sourceId` and can
    // therefore never send `close`/`abort` for it — so it must not be
    // reachable through `sources` either, or the underlying file
    // reader / native buffers would leak for the life of the worker.
    // The catch below releases `source` in that case.
    post({
      kind: 'opened',
      requestId: msg.requestId,
      sourceId,
      info,
    });
    sources.set(sourceId, opened);
    opened = undefined; // ownership transferred to `sources`
  } catch (err) {
    if (opened) {
      try {
        opened.abort.abort();
        opened.source.close();
      } catch (closeErr) {
        console.warn('[decode-worker] cleanup after failed open() post failed:', errMessage(closeErr));
      }
    }
    post({
      kind: 'error',
      requestId: msg.requestId,
      message: errMessage(err),
    });
  } finally {
    pendingOpens.delete(msg.requestId);
  }
}

/**
 * Restart a source at a new stride and origin. A source with `reopen()` keeps
 * what its `open()` learnt (PLY keeps its bounds scan); any other is rebuilt
 * from the original request, as a close plus a fresh open would. On failure
 * the source is released, and the client forgets its id.
 */
async function handleReopen(msg: Extract<WorkerRequest, { kind: 'reopen' }>): Promise<void> {
  const open = sources.get(msg.sourceId);
  if (!open) {
    post({ kind: 'error', requestId: msg.requestId, message: `Unknown sourceId ${msg.sourceId}` });
    return;
  }
  const stride = normalizePointStride(msg.stride);
  try {
    let info: PointSourceInfo;
    if (open.source.reopen) {
      info = await open.source.reopen({ stride, originOffset: msg.originOffset }, open.abort.signal);
    } else {
      open.source.close();
      open.source = await sourceFor(open.request, stride, msg.originOffset);
      info = await open.source.open(open.abort.signal);
    }
    // A `close` that arrived mid-reopen has already dropped this entry.
    if (sources.get(msg.sourceId) !== open) throw new DOMException('Aborted', 'AbortError');
    post({ kind: 'opened', requestId: msg.requestId, sourceId: msg.sourceId, info });
  } catch (err) {
    if (sources.get(msg.sourceId) === open) handleClose(msg.sourceId);
    else open.source.close();
    post({ kind: 'error', requestId: msg.requestId, message: errMessage(err) });
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
  if (closeCopcSource?.(sourceId)) return;
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

/** The source an `open` request names, at the given stride and origin. */
function sourceFor(
  request: OpenRequest,
  stride: number,
  originOffset: readonly [number, number, number] | undefined,
): Promise<StreamingPointSource> {
  return createSource(request.format, request.blob, { label: request.label, downsample: { stride }, originOffset });
}

/**
 * Dispatch to the format-specific streaming source. Each format is dynamically
 * imported so the worker's IIFE bundle (see scripts/build-worker-bundle.mjs)
 * stays small — the published `worker-client.js` only inlines the worker shell
 * + protocol code. The LAZ branch (`laz-perf` ~1 MB) only loads when a .laz
 * file is opened. Format ↔ chunk module is a one-time cost per session.
 */
async function createSource(
  format: 'las' | 'laz' | 'ply' | 'pcd' | 'e57' | 'pts' | 'xyz',
  blob: Blob,
  opts: {
    label?: string;
    downsample: { stride: number };
    /** See `decodeLasPoints`'s `originOffset` param (issue #1804) — every
     *  format source consumes it, subtracting in f64 before narrowing to
     *  f32 (extended to E57/PLY/PCD/PTS/XYZ alongside the original
     *  LAS/LAZ support). */
    originOffset?: readonly [number, number, number];
  },
): Promise<StreamingPointSource> {
  switch (format) {
    case 'las': {
      const { LasStreamingSource } = await import('./las-source.js');
      return new LasStreamingSource(blob, opts);
    }
    case 'laz': {
      const { LazStreamingSource } = await import('./laz-source.js');
      return new LazStreamingSource(blob, opts);
    }
    case 'ply': {
      const { PlyStreamingSource } = await import('./ply-source.js');
      return new PlyStreamingSource(blob, opts);
    }
    case 'pcd': {
      const { PcdStreamingSource } = await import('./pcd-source.js');
      return new PcdStreamingSource(blob, opts);
    }
    case 'e57': {
      const { E57StreamingSource } = await import('./e57-source.js');
      return new E57StreamingSource(blob, opts);
    }
    case 'pts': {
      const { AsciiPointsStreamingSource } = await import('./ascii-points-source.js');
      return new AsciiPointsStreamingSource(blob, 'pts', opts);
    }
    case 'xyz': {
      const { AsciiPointsStreamingSource } = await import('./ascii-points-source.js');
      return new AsciiPointsStreamingSource(blob, 'xyz', opts);
    }
    default:
      throw new Error(`decode-worker: unknown format "${format}"`);
  }
}

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
