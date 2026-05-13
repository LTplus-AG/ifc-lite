/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread client for the decode worker.
 *
 * Wraps the postMessage protocol behind a `Promise`-based API and
 * exposes a `StreamingPointSource`-shaped facade that hosts (e.g.
 * the viewer ingest) can drive without knowing a worker exists.
 *
 * The worker URL is constructed via `new URL(..., import.meta.url)` —
 * Vite, webpack 5, esbuild, and Rollup all bundle it correctly when the
 * `new Worker(url, { type: 'module' })` form is used.
 */

import type { DecodedPointChunk } from '../types.js';
import {
  chunkFromWire,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.js';
import type {
  PointSourceInfo,
  StreamingPointSource,
} from './types.js';

export type DecodeWorkerFormat = 'las' | 'laz' | 'ply' | 'pcd' | 'e57' | 'pts' | 'xyz';

export interface DecodeWorkerOptions {
  /** Override the worker constructor — useful for tests or custom bundlers. */
  spawn?: () => Worker;
}

/** Pool a single worker per page; the host can spawn additional workers
 *  with `createDecodeWorkerSource({ spawn })` when concurrent decoding is
 *  desirable (e.g. multiple federated scans). */
let sharedWorker: Worker | null = null;

function defaultSpawn(): Worker {
  // The bare-`.js` form works against the built dist but Vite's
  // worker-import-meta-url plugin can't resolve it through the source
  // alias used in the viewer dev build. Geometry uses `.worker.ts` for
  // the same reason — Vite happily rewrites the suffix on dist builds.
  return new Worker(new URL('./decode-worker.ts', import.meta.url), {
    type: 'module',
    name: 'ifclite-pointcloud-decode',
  });
}

function getSharedWorker(spawn: () => Worker): Worker {
  if (!sharedWorker) {
    sharedWorker = spawn();
  }
  return sharedWorker;
}

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (err: Error) => void;
}

/** Variants that need a response (open / next). */
type RequestWithReply = Extract<WorkerRequest, { requestId: number }>;

class WorkerSession {
  private requests = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private listener: (event: MessageEvent<WorkerResponse>) => void;

  constructor(public readonly worker: Worker) {
    this.listener = (event) => {
      const msg = event.data;
      if (!('requestId' in msg)) return;
      const pending = this.requests.get(msg.requestId);
      if (!pending) return;
      this.requests.delete(msg.requestId);
      if (msg.kind === 'error') {
        pending.reject(new Error(msg.message));
      } else {
        pending.resolve(msg);
      }
    };
    worker.addEventListener('message', this.listener);
  }

  /** Send a request that expects a single response by `requestId`. */
  send<T extends WorkerResponse>(
    build: (requestId: number) => RequestWithReply,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const requestId = this.nextRequestId++;
    const req = build(requestId);
    return new Promise<T>((resolve, reject) => {
      this.requests.set(requestId, {
        resolve: (resp) => resolve(resp as T),
        reject,
      });
      this.worker.postMessage(req, transfer);
    });
  }

  /** Send a fire-and-forget message (close / abort). */
  notify(req: WorkerRequest): void {
    this.worker.postMessage(req);
  }
}

let sharedSession: WorkerSession | null = null;

function getSharedSession(spawn: () => Worker): WorkerSession {
  if (!sharedSession) {
    sharedSession = new WorkerSession(getSharedWorker(spawn));
  }
  return sharedSession;
}

export interface CreateDecodeWorkerSourceOptions extends DecodeWorkerOptions {
  format: DecodeWorkerFormat;
  blob: Blob;
  label?: string;
  /** stride>1 → drop every Nth point on decode for memory bounds. */
  stride?: number;
}

/**
 * Build a `StreamingPointSource` that runs decode work in the shared
 * worker. The caller drives `open()` / `next()` / `close()` exactly
 * like the in-process `LasStreamingSource`.
 */
export function createDecodeWorkerSource(
  opts: CreateDecodeWorkerSourceOptions,
): StreamingPointSource {
  const session = getSharedSession(opts.spawn ?? defaultSpawn);
  let sourceId: number | null = null;
  let info: PointSourceInfo | null = null;

  return {
    async open(signal?: AbortSignal): Promise<PointSourceInfo> {
      if (info) return info;
      abortIfAborted(signal);
      const resp = await session.send<Extract<WorkerResponse, { kind: 'opened' }>>(
        (requestId) => ({
          kind: 'open',
          requestId,
          format: opts.format,
          blob: opts.blob,
          label: opts.label,
          stride: Math.max(1, opts.stride ?? 1),
        }),
      );
      sourceId = resp.sourceId;
      info = resp.info;
      return info;
    },
    async next(maxPoints: number, signal?: AbortSignal): Promise<DecodedPointChunk | null> {
      if (sourceId === null) {
        throw new Error('decode-worker source not opened');
      }
      abortIfAborted(signal);
      const id = sourceId;
      // Propagate aborts that fire WHILE the worker is decoding —
      // without this, cancel() returns immediately to the caller but
      // the worker keeps grinding on a soon-to-be-discarded chunk.
      const abortListener = () => {
        session.notify({ kind: 'abort', sourceId: id });
      };
      signal?.addEventListener('abort', abortListener, { once: true });
      try {
        const resp = await session.send<Extract<WorkerResponse, { kind: 'chunk' }>>(
          (requestId) => ({
            kind: 'next',
            requestId,
            sourceId: id,
            maxPoints,
          }),
        );
        // Race: if the signal fired *while* the worker was finishing a
        // chunk, the response can still arrive after the host has
        // moved on. Treat a late completion as cancelled so the host's
        // `onChunk` doesn't run after `cancel()` returned to the caller.
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (!resp.chunk) return null;
        return chunkFromWire(resp.chunk);
      } finally {
        signal?.removeEventListener('abort', abortListener);
      }
    },
    close(): void {
      if (sourceId !== null) {
        session.notify({ kind: 'close', sourceId });
        sourceId = null;
      }
      // Clear cached open()-result too so a subsequent open() actually
      // re-opens the worker source instead of returning stale info
      // alongside a now-null sourceId (which would make next() throw
      // "decode-worker source not opened").
      info = null;
    },
  };
}

function abortIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}
