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

import { GeometryChunkFlags, inflateRaw, openGeometryChunksV13, type ChunkInflate } from '@ifc-lite/cache';
import type { ChunkInflatePool } from '@ifc-lite/cache/chunk-inflate-pool';

type PoolModule = typeof import('@ifc-lite/cache/chunk-inflate-pool');
const loadPoolModule = (): Promise<PoolModule> => import('@ifc-lite/cache/chunk-inflate-pool');

export interface CacheChunkInflater {
  /** Call with the entry's geometry section once its header is read: starts the workers if any chunk is compressed. */
  prepare(cacheBuffer: ArrayBuffer, geometrySectionOffset: number | undefined, version: number): void;
  readonly inflate: ChunkInflate;
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
  return {
    prepare(cacheBuffer, offset, version) {
      if (offset === undefined || closed) return;
      const { chunks } = openGeometryChunksV13(cacheBuffer, offset, version);
      if (chunks.some((c) => c.flags & GeometryChunkFlags.DeflateRaw)) void open();
    },
    // The first compressed chunk opens the pool when `prepare` did not.
    inflate: async (stored, rawLength) => {
      const ready = closed ? null : await open();
      return ready ? ready.inflate(stored, rawLength) : inflateRaw(stored);
    },
    close() {
      closed = true;
      void pool?.then((p) => p?.close());
    },
  };
}
