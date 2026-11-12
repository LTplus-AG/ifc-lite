/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a cache hit's geometry chunks inflate and decode: a `ChunkInflatePool`
 * of workers, started only for an entry that has geometry chunks (a
 * metadata-only entry starts none). The pool module is a lazy chunk, out of
 * the entry graph; if it cannot load, chunks decode on this thread as before.
 *
 * - One head: `head()` parses the entry's geometry head once, and both the
 *   caller and the prefetch read chunks through it, so every chunk's pooled
 *   appearance sources link to the same pool arrays (as a main-thread decode).
 * - Ahead of the caller: `prepare` (the header is read, the metadata has not
 *   decoded yet) starts decoding chunks on the workers. With the pool module
 *   already loaded (`warm()` at the start of the hit) the first chunks are
 *   posted synchronously, so the workers decode while this thread decodes the
 *   metadata. At most `PREFETCH_PER_WORKER` chunks per worker are in flight and
 *   at most `AHEAD_PER_WORKER` per worker ahead of the caller.
 * - Work ahead is worker-only (`decodeOnWorkers`). Once the workers fail, the
 *   prefetch stops and the caller decodes the rest on demand, paced by its own
 *   loop, as without workers.
 * - `close()` (the load ended: superseded, model removed or replaced, a
 *   failure) stops the workers; in-flight work rejects as an abort and nothing
 *   is decoded on this thread for it.
 */

import { decodeGeometryChunk, inflateRaw, openGeometryChunksV13, type ChunkDecode, type ChunkInflate, type GeometryHead } from '@ifc-lite/cache';
import type { ChunkInflatePool } from '@ifc-lite/cache/chunk-inflate-pool';
import type { MeshData } from '@ifc-lite/geometry';

/** Chunks in flight per worker. */
const PREFETCH_PER_WORKER = 2;
/** Chunks decoded ahead of the caller per worker, in flight or waiting to be taken: bounds the memory held ahead. */
const AHEAD_PER_WORKER = 4;

type PoolModule = typeof import('@ifc-lite/cache/chunk-inflate-pool');
const loadPoolModule = (): Promise<PoolModule> => import('@ifc-lite/cache/chunk-inflate-pool');
type ChunkHead = GeometryHead & { readChunk(index: number): Promise<MeshData[]> };

export interface CacheChunkInflater {
  /** Load the pool module now (no worker yet): call when the hit starts, so `prepare` can post its first chunks at once. */
  warm(): void;
  /** Call with the entry's geometry section once its header is read: starts the workers and the work ahead, for any chunk. */
  prepare(cacheBuffer: ArrayBuffer, geometrySectionOffset: number | undefined, version: number): void;
  /** The entry's geometry head, parsed once and shared with the prefetch; read the hit's chunks through it. */
  head(cacheBuffer: ArrayBuffer, geometrySectionOffset: number, version: number): ChunkHead;
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

const isNamed = (error: unknown, name: string): boolean => error instanceof Error && error.name === name;

export function createCacheChunkInflater(load: () => Promise<PoolModule> = loadPoolModule, workers = chunkInflateWorkers()): CacheChunkInflater {
  let closed = false;
  let poolModule: PoolModule | null = null;
  let moduleLoad: Promise<PoolModule | null> | null = null;
  /** `undefined`: not created yet; `null`: unavailable (module did not load, or closed first). */
  let pool: ChunkInflatePool | null | undefined;
  const loadModule = (): Promise<PoolModule | null> => moduleLoad ??= load().then((module) => (poolModule = module), (error: unknown) => {
    console.warn('[cache] chunk inflate pool did not load; inflating on this thread', error);
    return null;
  });
  /** The pool, created at once when its module is loaded. */
  const poolNow = (): ChunkInflatePool | null | undefined => {
    if (pool !== undefined || !poolModule) return pool;
    if (closed) return (pool = null);
    pool = new poolModule.ChunkInflatePool(workers).start();
    return pool;
  };
  const open = async (): Promise<ChunkInflatePool | null> => {
    const now = poolNow();
    if (now !== undefined) return now;
    await loadModule();
    return poolNow() ?? null;
  };

  let shared: { buffer: ArrayBuffer; offset: number; version: number; head: ChunkHead } | null = null;
  // Chunks decoded ahead, by the chunk's offset in the section.
  const ahead = new Map<number, Promise<MeshData[]>>();
  /** Chunks the caller asked for before the prefetch reached them: never decoded twice. */
  const asked = new Set<number>();
  let taken = 0;
  let prefetching: ChunkInflatePool | null = null;
  let startNext: () => void = () => {};

  /** What `head().readChunk` decodes with: the work ahead goes to the workers only; the caller takes it or decodes on demand. */
  const decodeFor: ChunkDecode = async (stored, info, version) => {
    if (prefetching) return prefetching.decodeOnWorkers(stored, info, version);
    taken++;
    const decoded = ahead.get(info.byteOffset);
    if (decoded) {
      ahead.delete(info.byteOffset);
      startNext();
      try {
        return await decoded;
      } catch (error) {
        // A corrupt entry or a closed load ends here; a chunk no worker could take decodes on demand below.
        if (isNamed(error, 'CorruptChunkError') || isNamed(error, 'ChunkPoolClosedError')) throw error;
      }
    } else {
      asked.add(info.byteOffset);
      startNext();
    }
    const ready = closed ? null : await open();
    return ready ? ready.decode(stored, info, version) : decodeGeometryChunk(stored, info, version);
  };

  const head = (cacheBuffer: ArrayBuffer, offset: number, version: number): ChunkHead => {
    if (shared && shared.buffer === cacheBuffer && shared.offset === offset && shared.version === version) return shared.head;
    shared = { buffer: cacheBuffer, offset, version, head: openGeometryChunksV13(cacheBuffer, offset, version, { decode: decodeFor }) };
    return shared.head;
  };

  const beginPrefetch = (ready: ChunkInflatePool | null, chunks: ChunkHead): void => {
    if (!ready || closed || ready.inflatingHere) return; // no workers: the caller decodes on demand, as before
    let nextIndex = 0;
    let inFlight = 0;
    startNext = () => {
      while (!closed && !ready.inflatingHere && inFlight < PREFETCH_PER_WORKER * workers) {
        while (nextIndex < chunks.chunks.length && asked.has(chunks.chunks[nextIndex].byteOffset)) nextIndex++;
        if (nextIndex >= chunks.chunks.length || nextIndex - taken >= AHEAD_PER_WORKER * workers) return;
        const index = nextIndex++;
        inFlight++;
        prefetching = ready;
        const decoded = chunks.readChunk(index);
        prefetching = null;
        ahead.set(chunks.chunks[index].byteOffset, decoded);
        // A rejection (closed, corrupt, no worker) is handed to the caller that takes this chunk.
        decoded.then(() => { inFlight--; startNext(); }, () => { inFlight--; });
      }
    };
    startNext();
  };

  return {
    warm() {
      if (!closed) void loadModule();
    },
    prepare(cacheBuffer, offset, version) {
      if (offset === undefined || closed) return;
      const chunks = head(cacheBuffer, offset, version);
      if (chunks.chunks.length === 0) return;
      const now = poolNow();
      if (now !== undefined) beginPrefetch(now, chunks); // module loaded: post the first chunks before the metadata decodes
      else void open().then((ready) => beginPrefetch(ready, chunks));
    },
    head,
    // The first compressed chunk opens the pool when `prepare` did not.
    inflate: async (stored, rawLength) => {
      const ready = closed ? null : await open();
      return ready ? ready.inflate(stored, rawLength) : inflateRaw(stored);
    },
    decode: decodeFor,
    close() {
      closed = true;
      ahead.clear();
      if (pool) pool.close();
      else void moduleLoad?.then(() => { pool?.close(); });
    },
  };
}
