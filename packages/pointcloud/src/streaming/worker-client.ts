/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread client for the decode worker.
 *
 * Wraps the postMessage protocol behind a `Promise`-based API and exposes
 * a `StreamingPointSource`-shaped facade that hosts (e.g. the viewer
 * ingest) can drive without knowing a worker exists.
 *
 * Spawn modes:
 *
 * 1. **Published consumer (zero-config).** At publish time
 *    `scripts/build-worker-bundle.mjs` bundles `decode-worker.ts` plus its
 *    transitive deps as an IIFE and writes the bundle into
 *    `dist/streaming/inline-worker.js` as an `INLINE_WORKER_CODE` string.
 *    `defaultSpawn` dynamically imports that module and spawns the worker
 *    from a `Blob` URL — no `type: 'module'`, no `import.meta.url`
 *    resolution. Works against Vite's default `worker.format: 'iife'`
 *    setting that previously errored on the ES module worker (#666).
 *
 * 2. **Workspace dev.** Inside the monorepo, the viewer's vite.config aliases
 *    `@ifc-lite/pointcloud` to `src/`, where `inline-worker.ts` is a
 *    placeholder that exports `null`. `defaultSpawn` detects the null and
 *    falls back to the `new Worker(new URL('./decode-worker.ts', import.meta.url),
 *    { type: 'module' })` idiom that Vite's `worker-import-meta-url` plugin
 *    handles natively. HMR + source maps keep working.
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
  /**
   * Override the worker constructor — useful for tests or custom bundlers.
   * May return a Worker synchronously or a Promise resolving to one; the
   * client handles both. Sync callbacks remain the common case and stay
   * type-compatible with the previous signature.
   */
  spawn?: () => Worker | Promise<Worker>;
}

async function defaultSpawn(): Promise<Worker> {
  // Prefer the published inline bundle. The dynamic import resolves to a
  // non-null `INLINE_WORKER_CODE` only in the published dist; in the
  // workspace src tree (and in unit tests) it resolves to `null` and we
  // fall through to the `new URL(...)` spawn path.
  const { INLINE_WORKER_CODE } = await import('./inline-worker.js');
  if (INLINE_WORKER_CODE) {
    const blob = new Blob([INLINE_WORKER_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, { name: 'ifclite-pointcloud-decode' });
    // The Worker ctor reads the URL synchronously, so revoking right after
    // is safe and avoids leaking ~tens of MB of Blob URLs per spawn over a
    // long-running session.
    queueMicrotask(() => URL.revokeObjectURL(url));
    return worker;
  }

  // Dev fallback — Vite's `worker-import-meta-url` plugin handles this.
  return new Worker(new URL('./decode-worker.ts', import.meta.url), {
    type: 'module',
    name: 'ifclite-pointcloud-decode',
  });
}

/** Pool a single worker per page; the host can spawn additional workers
 *  with `createDecodeWorkerSource({ spawn })` when concurrent decoding is
 *  desirable (e.g. multiple federated scans). */
let sharedWorkerPromise: Promise<Worker> | null = null;

function getSharedWorker(spawn: () => Worker | Promise<Worker>): Promise<Worker> {
  if (!sharedWorkerPromise) {
    sharedWorkerPromise = Promise.resolve(spawn());
  }
  return sharedWorkerPromise;
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

let sharedSessionPromise: Promise<WorkerSession> | null = null;

function getSharedSession(spawn: () => Worker | Promise<Worker>): Promise<WorkerSession> {
  if (!sharedSessionPromise) {
    sharedSessionPromise = getSharedWorker(spawn).then((worker) => new WorkerSession(worker));
  }
  return sharedSessionPromise;
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
  // Defer the actual spawn (and the dynamic import of the inline bundle)
  // until the first `open()` call. Hosts that construct a source eagerly
  // but only sometimes open it don't pay for the worker chunk.
  const sessionPromise = getSharedSession(opts.spawn ?? defaultSpawn);
  let sourceId: number | null = null;
  let info: PointSourceInfo | null = null;

  return {
    async open(signal?: AbortSignal): Promise<PointSourceInfo> {
      if (info) return info;
      abortIfAborted(signal);
      const session = await sessionPromise;
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
      const session = await sessionPromise;
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
        const id = sourceId;
        // Fire-and-forget — close() stays sync for callers. The session
        // promise is always already resolved here because close() can only
        // be reached after open() awaited it.
        void sessionPromise.then((session) => session.notify({ kind: 'close', sourceId: id }));
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
