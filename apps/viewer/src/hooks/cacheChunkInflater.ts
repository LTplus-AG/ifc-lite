/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a cache hit's compressed geometry chunks inflate: a `ChunkInflatePool`
 * of workers, loaded and started only for an entry that has compressed chunks.
 * A metadata-only entry, or one whose chunks are all stored raw, loads no pool
 * module and starts no worker. The pool module is a lazy chunk, out of the
 * entry graph; if it cannot load, chunks inflate on this thread.
 */

import { decodeGeometryChunk, inflateRaw, openGeometryChunksV13, type ChunkDecode, type ChunkInflate } from '@ifc-lite/cache';
import type { ChunkInflatePool } from '@ifc-lite/cache/chunk-inflate-pool';
import type { MeshData } from '@ifc-lite/geometry';

/** Chunks in flight per worker while the metadata decodes: enough to keep each busy, few enough to bound memory. */
const PREFETCH_PER_WORKER = 2;

type PoolModule = typeof import('@ifc-lite/cache/chunk-inflate-pool');
const loadPoolModule = (): Promise<PoolModule> => import('@ifc-lite/cache/chunk-inflate-pool');

export interface CacheChunkInflater {
  /** Call with the entry's geometry section once its header is read: starts the workers if it has any chunk. */
  prepare(cacheBuffer: ArrayBuffer, geometrySectionOffset: number | undefined, version: number): void;
  readonly inflate: ChunkInflate;
  /** Inflate and decode a whole chunk on a worker (main-thread decode when the pool is unavailable). */
  readonly decode: ChunkDecode;
  close(): void;
}

/** Workers inflating a hit's chunks: a few, leaving cores for the main thread and the GPU process. */
function chunkInflateWorkers(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  return Math.max(1, Math.min(4, cores - 2));
}

export function createCacheChunkInflater(load: () => Promise<PoolModule> = loadPoolModule, workers = chunkInflateWorkers()): CacheChunkInflater {
  let pool: Promise<ChunkInflatePool | null> | null = null;
  let closed = false;
  const open = () => pool ??= load().then(({ ChunkInflatePool: Pool }) => {
    const created = new Pool(workers);
    return closed ? (created.close(), null) : created.start();
  }, (error: unknown) => {
    console.warn('[cache] chunk inflate pool did not load; inflating on this thread', error);
    return null;
  });
  // Chunks decoding ahead, by the chunk's offset in the entry: started when the header is read, so
  // the workers decode while this thread decodes the metadata; `decode` hands them out in order.
  const ahead = new Map<number, Promise<MeshData[]>>();
  /** Chunks the caller asked for before the prefetch reached them: never decoded twice. */
  const asked = new Set<number>();
  const prefetch = async (cacheBuffer: ArrayBuffer, offset: number, version: number): Promise<void> => {
    const ready = await open();
    if (!ready || closed) return; // no workers: decode on demand, on this thread, as before
    const head = openGeometryChunksV13(cacheBuffer, offset, version, { decode: ready.decode });
    let nextIndex = 0;
    const startNext = (): void => {
      while (nextIndex < head.chunks.length && asked.has(head.chunks[nextIndex].byteOffset)) nextIndex++;
      if (closed || nextIndex >= head.chunks.length) return;
      const index = nextIndex++;
      const decoded = head.readChunk(index);
      decoded.then(startNext, () => {}); // a rejection (close, corrupt entry) is handed to `decode`'s caller
      ahead.set(head.chunks[index].byteOffset, decoded);
    };
    for (let i = 0; i < PREFETCH_PER_WORKER * workers; i++) startNext();
  };
  return {
    prepare(cacheBuffer, offset, version) {
      if (offset === undefined || closed) return;
      // Every chunk decodes on a worker now (compressed or not): start them for any geometry.
      const { chunks } = openGeometryChunksV13(cacheBuffer, offset, version);
      if (chunks.length > 0) void prefetch(cacheBuffer, offset, version);
    },
    // The first compressed chunk opens the pool when `prepare` did not.
    inflate: async (stored, rawLength) => {
      const ready = closed ? null : await open();
      return ready ? ready.inflate(stored, rawLength) : inflateRaw(stored);
    },
    decode: async (stored, info, version) => {
      const decoded = ahead.get(info.byteOffset);
      if (decoded) { ahead.delete(info.byteOffset); return decoded; }
      asked.add(info.byteOffset);
      const ready = closed ? null : await open();
      return ready ? ready.decode(stored, info, version) : decodeGeometryChunk(stored, info, version);
    },
    close() {
      closed = true;
      ahead.clear();
      void pool?.then((p) => p?.close());
    },
  };
}
