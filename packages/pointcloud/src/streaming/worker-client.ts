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

/**
 * Reset hook for the module-level cache. Exported only for tests so the
 * "construction does not trigger spawn" and "rejected cache is cleared"
 * regression tests can start from a known clean slate.
 *
 * @internal
 */
export function __resetSharedSessionForTests(): void {
  sharedSessionPromise = null;
}

function getSharedSession(spawn: () => Worker | Promise<Worker>): Promise<WorkerSession> {
  if (sharedSessionPromise) return sharedSessionPromise;
  // Wrap in an async IIFE so sync throws from a custom `spawn` callback
  // route through the same catch path as async rejections — without this,
  // a synchronous throw would propagate before we attached the
  // cache-reset handler below.
  const p = (async () => {
    const worker = await spawn();
    return new WorkerSession(worker);
  })();
  // Clear the cache on rejection so consumers can recover. Without this,
  // a single failure (CSP blocks `blob:` workers, no `Worker` global at
  // SSR, the inline-worker dynamic import fails) would poison every
  // subsequent `createDecodeWorkerSource()` call — even ones using the
  // documented custom-`spawn` escape hatch.
  //
  // Critical: `.catch` is attached as a side handler (we don't return its
  // result), so the rejection still propagates to whichever `await` is
  // waiting on `p`. We only erase the module-level reference.
  p.catch(() => {
    if (sharedSessionPromise === p) sharedSessionPromise = null;
  });
  sharedSessionPromise = p;
  return p;
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
  // Truly lazy — no spawn, no inline-worker import, no Worker global
  // touch at construction time. Hosts that build a source speculatively
  // but never open it don't pay for the worker bundle; SSR/test paths
  // that import this file but never call `open()` don't crash on a
  // missing `Worker` constructor.
  //
  // The per-source `sessionPromise` is a captured reference so `close()`
  // doesn't have to reach back into the module-level cache (which the
  // failure-reset above may have cleared by the time close() runs).
  let sessionPromise: Promise<WorkerSession> | null = null;
  const ensureSession = (): Promise<WorkerSession> => {
    if (!sessionPromise) {
      sessionPromise = getSharedSession(opts.spawn ?? defaultSpawn);
    }
    return sessionPromise;
  };
  let sourceId: number | null = null;
  let info: PointSourceInfo | null = null;

  return {
    async open(signal?: AbortSignal): Promise<PointSourceInfo> {
      if (info) return info;
      abortIfAborted(signal);
      const session = await ensureSession();
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
      const session = await ensureSession();
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
      if (sourceId !== null && sessionPromise) {
        const id = sourceId;
        // Fire-and-forget — close() stays sync for callers. We only enter
        // this branch if `open()` previously assigned `sourceId`, which
        // means `sessionPromise` is already resolved (open awaited it).
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
