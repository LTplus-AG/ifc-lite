/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread COPC client (#6869). Range reads and LAZ decoding run in the
 * shared decode worker; the hierarchy lives here, next to the LOD selection
 * that walks it. Each page/node read is individually cancellable, so a
 * camera move can drop fetches it no longer wants.
 */

import { chunkFromWire, type CopcSourceDescriptor, type WorkerResponse } from '../streaming/protocol.js';
import { defaultSpawn, getSharedSession, type DecodeWorkerOptions, type WorkerSession } from '../streaming/worker-client.js';
import type { DecodedPointChunk } from '../types.js';
import { voxelKeyId, type CopcFileInfo } from './copc-info.js';
import {
  CopcHierarchy,
  DEFAULT_COPC_HIERARCHY_LIMITS,
  type CopcHierarchyLimits,
  type CopcHierarchyPage,
  type CopcNodeEntry,
  type CopcPageRef,
} from './copc-hierarchy.js';

export interface OpenCopcOptions extends DecodeWorkerOptions {
  source: CopcSourceDescriptor;
  /** Native offset subtracted in f64 before narrowing to f32 (#1804). */
  originOffset?: readonly [number, number, number];
  hierarchyLimits?: CopcHierarchyLimits;
  signal?: AbortSignal;
}

export interface CopcWorkerReader {
  readonly file: CopcFileInfo;
  /** Root page loaded on open; further pages via `loadPage`. */
  readonly hierarchy: CopcHierarchy;
  readonly originOffset?: readonly [number, number, number];
  /** Read and parse a page without admitting it (see `loadPendingCopcPages`). */
  readPage(ref: CopcPageRef, signal?: AbortSignal): Promise<CopcHierarchyPage>;
  /** Read a pending page and admit it to `hierarchy`; concurrent calls share one read. */
  loadPage(ref: CopcPageRef, signal?: AbortSignal): Promise<void>;
  /** Fetch and decode one node, keeping every `stride`-th point. */
  readNode(node: CopcNodeEntry, options?: { stride?: number; signal?: AbortSignal }): Promise<DecodedPointChunk>;
  close(): void;
}

/**
 * Send one request, forwarding `signal` to the worker as `copc-cancel`. A
 * response that races the abort is discarded, as for stream chunks;
 * `onDiscard` releases anything it carried (an opened reader's sourceId).
 */
async function cancellable<T extends WorkerResponse>(
  session: WorkerSession,
  signal: AbortSignal | undefined,
  build: Parameters<WorkerSession['send']>[0],
  onDiscard?: (resp: T) => void,
): Promise<T> {
  signal?.throwIfAborted();
  let requestId = -1;
  const onAbort = () => session.notify({ kind: 'copc-cancel', targetRequestId: requestId });
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await session.send<T>(build, [], (id) => { requestId = id; });
    if (signal?.aborted) {
      onDiscard?.(resp);
      signal.throwIfAborted();
    }
    return resp;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

interface SharedPageLoad {
  promise: Promise<void>;
  waiters: number;
  abort: AbortController;
}

/** Wait for `shared`, rejecting early (for this caller only) when `signal` aborts. */
function joinSharedLoad(shared: SharedPageLoad, signal: AbortSignal | undefined, onAllGone: () => void): Promise<void> {
  shared.waiters++;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const leave = (): boolean => {
      if (settled) return false;
      settled = true;
      shared.waiters--;
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    function onAbort(): void {
      if (!leave()) return;
      if (shared.waiters === 0) onAllGone();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      () => { if (leave()) resolve(); },
      (err: unknown) => { if (leave()) reject(err); },
    );
  });
}

/** Open a COPC file in the decode worker and load its root hierarchy page. */
export async function openCopcWorkerReader(options: OpenCopcOptions): Promise<CopcWorkerReader> {
  const session = await getSharedSession(options.spawn ?? defaultSpawn);
  const limits = options.hierarchyLimits ?? DEFAULT_COPC_HIERARCHY_LIMITS;
  const opened = await cancellable<Extract<WorkerResponse, { kind: 'copc-opened' }>>(
    session,
    options.signal,
    (requestId) => ({
      kind: 'copc-open', requestId, source: options.source, originOffset: options.originOffset, maxPageBytes: limits.maxPageBytes,
    }),
    // Opened in the worker just as the caller gave up: nobody else knows
    // this sourceId, so close it here or the reader lives forever.
    (late) => session.notify({ kind: 'close', sourceId: late.sourceId }),
  );
  const sourceId = opened.sourceId;
  const hierarchy = new CopcHierarchy(limits);
  const rootRef = { offset: opened.file.info.rootHierOffset, byteSize: opened.file.info.rootHierSize };
  try {
    hierarchy.addPage(rootRef, opened.rootPage);
  } catch (err) {
    session.notify({ kind: 'close', sourceId });
    throw err;
  }
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error('COPC reader is closed');
  };
  const readPage = async (ref: CopcPageRef, signal?: AbortSignal): Promise<CopcHierarchyPage> => {
    assertOpen();
    const maxBytes = hierarchy.remainingPageBytes;
    const resp = await cancellable<Extract<WorkerResponse, { kind: 'copc-page' }>>(
      session,
      signal,
      (requestId) => ({ kind: 'copc-page', requestId, sourceId, page: ref, maxBytes }),
    );
    return resp.page;
  };
  const pageLoads = new Map<string, SharedPageLoad>();
  return {
    file: opened.file,
    hierarchy,
    originOffset: options.originOffset,
    readPage,
    loadPage(ref, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      const id = voxelKeyId(ref.key);
      let shared = pageLoads.get(id);
      if (!shared) {
        if (!hierarchy.pendingPages.has(id)) return Promise.resolve();
        try {
          hierarchy.assertCanLoad(ref);
        } catch (err) {
          return Promise.reject(err);
        }
        // One read per page, owned by no single caller: each waiter races
        // its own signal, and the read is cancelled only when all have gone.
        const abort = new AbortController();
        const load: SharedPageLoad = { promise: Promise.resolve(), waiters: 0, abort };
        load.promise = readPage(ref, abort.signal)
          .then((page) => {
            if (hierarchy.pendingPages.has(id)) hierarchy.addPage(ref, page);
          })
          .finally(() => {
            if (pageLoads.get(id) === load) pageLoads.delete(id);
          });
        // Waiters observe the outcome; this keeps an all-abandoned load quiet.
        load.promise.catch(() => undefined);
        pageLoads.set(id, load);
        shared = load;
      }
      const joined = shared;
      return joinSharedLoad(joined, signal, () => {
        // Forget it first so a later caller starts afresh instead of joining a cancelled read.
        if (pageLoads.get(id) === joined) pageLoads.delete(id);
        joined.abort.abort();
      });
    },
    async readNode(node, opts = {}) {
      assertOpen();
      const resp = await cancellable<Extract<WorkerResponse, { kind: 'chunk' }>>(
        session,
        opts.signal,
        (requestId) => ({ kind: 'copc-node', requestId, sourceId, node, stride: Math.max(1, Math.floor(opts.stride ?? 1)) }),
      );
      if (!resp.chunk) throw new Error('COPC: worker returned no chunk for a node');
      return chunkFromWire(resp.chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      session.notify({ kind: 'close', sourceId });
    },
  };
}
