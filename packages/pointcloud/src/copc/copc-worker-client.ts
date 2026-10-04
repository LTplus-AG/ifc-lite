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

/** Send one request, forwarding `signal` to the worker as `copc-cancel`. */
async function cancellable<T extends WorkerResponse>(
  session: WorkerSession,
  signal: AbortSignal | undefined,
  build: Parameters<WorkerSession['send']>[0],
): Promise<T> {
  signal?.throwIfAborted();
  let requestId = -1;
  const onAbort = () => session.notify({ kind: 'copc-cancel', targetRequestId: requestId });
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const resp = await session.send<T>(build, [], (id) => { requestId = id; });
    // A response racing the abort is discarded, as for stream chunks.
    signal?.throwIfAborted();
    return resp;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Open a COPC file in the decode worker and load its root hierarchy page. */
export async function openCopcWorkerReader(options: OpenCopcOptions): Promise<CopcWorkerReader> {
  const session = await getSharedSession(options.spawn ?? defaultSpawn);
  const opened = await cancellable<Extract<WorkerResponse, { kind: 'copc-opened' }>>(
    session,
    options.signal,
    (requestId) => ({ kind: 'copc-open', requestId, source: options.source, originOffset: options.originOffset }),
  );
  const sourceId = opened.sourceId;
  const hierarchy = new CopcHierarchy(options.hierarchyLimits ?? DEFAULT_COPC_HIERARCHY_LIMITS);
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
    const resp = await cancellable<Extract<WorkerResponse, { kind: 'copc-page' }>>(
      session,
      signal,
      (requestId) => ({ kind: 'copc-page', requestId, sourceId, page: ref }),
    );
    return resp.page;
  };
  const pageLoads = new Map<string, Promise<void>>();
  return {
    file: opened.file,
    hierarchy,
    originOffset: options.originOffset,
    readPage,
    loadPage(ref, signal) {
      const id = voxelKeyId(ref.key);
      const existing = pageLoads.get(id);
      if (existing) return existing;
      if (!hierarchy.pendingPages.has(id)) return Promise.resolve();
      const load = readPage(ref, signal)
        .then((page) => hierarchy.addPage(ref, page))
        .finally(() => pageLoads.delete(id));
      pageLoads.set(id, load);
      return load;
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
