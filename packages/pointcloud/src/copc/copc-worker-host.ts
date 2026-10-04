/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Worker-side COPC handlers (#6869). The decode worker forwards every
 * `copc-*` request here. Readers are kept per `sourceId`; every page/node
 * request gets its own AbortController so the LOD driver can cancel a
 * fetch the camera no longer needs (`copc-cancel`).
 */

import { BlobByteSource } from '../streaming/blob-source.js';
import { HttpRangeSource } from '../streaming/http-range-source.js';
import { chunkToWire, type CopcSourceDescriptor, type WorkerRequest, type WorkerResponse } from '../streaming/protocol.js';
import type { RangeByteSource } from '../streaming/types.js';
import { CopcReader } from './copc-reader.js';

type Post = (msg: WorkerResponse, transfer?: Transferable[]) => void;
type CopcRequest = Extract<WorkerRequest, { kind: 'copc-open' | 'copc-page' | 'copc-node' | 'copc-cancel' }>;

const readers = new Map<number, { reader: CopcReader; closed: AbortController }>();
const inFlight = new Map<number, AbortController>();

async function openSource(desc: CopcSourceDescriptor, signal: AbortSignal): Promise<RangeByteSource> {
  if (desc.kind === 'blob') return new BlobByteSource(desc.blob);
  return HttpRangeSource.open(desc.url, { headers: desc.headers, signal });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Handle one COPC request; `allocateId` hands out ids shared with the stream sources. */
export async function handleCopcRequest(msg: CopcRequest, post: Post, allocateId: () => number): Promise<void> {
  if (msg.kind === 'copc-cancel') {
    inFlight.get(msg.targetRequestId)?.abort();
    return;
  }
  const abort = new AbortController();
  inFlight.set(msg.requestId, abort);
  try {
    if (msg.kind === 'copc-open') {
      const source = await openSource(msg.source, abort.signal);
      const reader = await CopcReader.open(source, { originOffset: msg.originOffset, signal: abort.signal });
      const rootPage = await reader.readPage(reader.rootPageRef, abort.signal);
      const sourceId = allocateId();
      // Same ordering as the stream sources: report first, register after,
      // so a failed post cannot leave an unreachable reader behind.
      post({ kind: 'copc-opened', requestId: msg.requestId, sourceId, file: reader.file, rootPage });
      readers.set(sourceId, { reader, closed: new AbortController() });
      return;
    }
    const entry = readers.get(msg.sourceId);
    if (!entry) throw new Error(`Unknown COPC sourceId ${msg.sourceId}`);
    const signal = AbortSignal.any([abort.signal, entry.closed.signal]);
    if (msg.kind === 'copc-page') {
      const page = await entry.reader.readPage(msg.page, signal);
      post({ kind: 'copc-page', requestId: msg.requestId, page });
      return;
    }
    const chunk = await entry.reader.readNode(msg.node, { stride: msg.stride, signal });
    const { payload, transfer } = chunkToWire(chunk);
    post({ kind: 'chunk', requestId: msg.requestId, sourceId: msg.sourceId, chunk: payload }, transfer);
  } catch (err) {
    post({ kind: 'error', requestId: msg.requestId, message: errorMessage(err) });
  } finally {
    inFlight.delete(msg.requestId);
  }
}

/** Close a COPC reader; returns false when `sourceId` is not one. */
export function closeCopcSource(sourceId: number): boolean {
  const entry = readers.get(sourceId);
  if (!entry) return false;
  entry.closed.abort();
  readers.delete(sourceId);
  return true;
}
