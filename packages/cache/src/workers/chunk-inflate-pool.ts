/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inflates a cache hit's compressed geometry chunks on a few workers, so the
 * deflate-raw decode (DecompressionStream plus its Blob/stream plumbing) does
 * not run on the main thread. Pass `pool.inflate` to `openGeometryChunksV13`.
 * Output is byte-identical: the workers run the same `inflateRaw`.
 *
 * Two kinds of failure, handled differently:
 * - The worker fails (it cannot start, crashes, sends an unreadable or
 *   wrong-length reply, or answers nothing for `stallMs` while it owes
 *   replies): the pool inflates on the calling thread from then on, including
 *   the requests that were in flight. A worker problem costs time, never the load.
 * - A worker's `inflateRaw` threw on a chunk: that one chunk is tried here.
 *   If it fails here too, the entry is corrupt: it and every remaining chunk
 *   reject at once with `CorruptChunkError`, nothing more is inflated, and the
 *   caller's corrupt-entry path (delete the entry, parse fresh) starts without
 *   delay. If it inflates here, the worker cannot inflate (its codec
 *   environment): the pool falls back as above, and the entry is kept.
 * - A chunk that does not inflate on the calling thread (after a fallback, or
 *   with no worker at all) is corrupt too, with the same `CorruptChunkError`.
 *
 * Workers start only on `start()` or the first compressed chunk: a
 * metadata-only entry, or one whose chunks are all stored raw, starts none.
 */

import { inflateRaw } from '../sections/geometry-codec.js';
import { decodeGeometryChunk, type ChunkDecode, type ChunkInflate } from '../sections/geometry-chunks.js';
import { GeometryChunkFlags, type GeometryChunkInfo } from '../types.js';
import type { MeshData } from '@ifc-lite/geometry';
import { GeometryCompressionSession, WorkerCodecError, type CompressionWorkerPort } from './geometry-compression-client.js';

/** A stored chunk that does not inflate: the cache entry is corrupt. */
export class CorruptChunkError extends Error {
  override name = 'CorruptChunkError';
}

/** The pool was closed (its load ended): in-flight and later requests reject with this, and nothing decodes here instead. */
export class ChunkPoolClosedError extends Error {
  override name = 'ChunkPoolClosedError';
}

/** `decodeOnWorkers` only: no worker can take the chunk (they failed or cannot start); decode it on demand instead. */
export class NoChunkWorkerError extends Error {
  override name = 'NoChunkWorkerError';
}

export interface ChunkInflatePoolOptions {
  /** Worker factory; the module worker by default. */
  createWorker?: () => CompressionWorkerPort;
  /** A worker owing replies that answers nothing for this long is treated as failed. */
  stallMs?: number;
}

/** No reply for this long while replies are owed: the worker is stuck (a chunk inflates in milliseconds). */
const STALL_MS = 5000;
/** A stall timer this late fired after a long main-thread task, which may have queued replies behind it. */
const LATE_TIMER_MS = 1000;

class Lane {
  readonly session: GeometryCompressionSession;
  private owed = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(createWorker: (() => CompressionWorkerPort) | undefined, private readonly stallMs: number) {
    this.session = new GeometryCompressionSession(createWorker);
  }

  async inflate(stored: Uint8Array, rawLength: number): Promise<Uint8Array> {
    this.owed++;
    this.arm();
    try {
      return await this.session.inflate(stored, rawLength);
    } finally {
      this.owed--;
      this.arm(true);
    }
  }

  async decode(stored: Uint8Array, info: GeometryChunkInfo, version: number): Promise<MeshData[]> {
    this.owed++;
    this.arm();
    try {
      return await this.session.decode(stored, (info.flags & GeometryChunkFlags.DeflateRaw) !== 0, info.uncompressedLength, info.meshCount, version, info.appearanceSources);
    } finally {
      this.owed--;
      this.arm(true);
    }
  }

  close(): void {
    this.disarm();
    this.session.close();
  }

  /** (Re)start the stall timer while replies are owed; a reply counts as progress. */
  private arm(progress = false): void {
    if (this.owed === 0 || this.session.failed) return this.disarm();
    if (this.timer !== null && !progress) return;
    this.disarm();
    const armedAt = performance.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      // Late: the main thread was busy, and replies may be queued behind this task. Look again.
      if (performance.now() - armedAt > this.stallMs + LATE_TIMER_MS) return this.arm(true);
      this.session.abort(new Error(`no reply for ${this.stallMs} ms`));
    }, this.stallMs);
  }

  private disarm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

export class ChunkInflatePool {
  private readonly lanes: Lane[];
  private next = 0;
  private fallback = false;
  private corrupt: CorruptChunkError | null = null;
  private closed = false;

  constructor(size: number, options: ChunkInflatePoolOptions = {}) {
    const stallMs = options.stallMs ?? STALL_MS;
    this.lanes = Array.from({ length: Math.max(1, Math.floor(size)) }, () => new Lane(options.createWorker, stallMs));
  }

  /** Start every worker now, so they boot while other work runs. */
  start(): this {
    if (this.fallback || this.corrupt || this.closed) return this;
    try {
      for (const lane of this.lanes) lane.session.start();
    } catch (error) {
      this.useFallback(error);
    }
    return this;
  }

  readonly inflate: ChunkInflate = async (stored, rawLength) => {
    if (this.closed) throw new ChunkPoolClosedError('chunk inflate pool closed');
    if (this.corrupt) throw this.corrupt;
    if (!this.fallback) {
      const lane = this.lanes[this.next++ % this.lanes.length];
      try {
        return await lane.inflate(stored, rawLength);
      } catch (error) {
        // Closed while in flight (the load ended): an abort, not a worker failure; nothing inflates here.
        if (this.closed) throw new ChunkPoolClosedError('chunk inflate pool closed');
        if (this.corrupt) throw this.corrupt;
        if (error instanceof WorkerCodecError) return this.confirmHere(stored, error);
        this.useFallback(error);
      }
    }
    let raw: Uint8Array;
    try {
      raw = await inflateRaw(stored);
    } catch (error) {
      // Here, without a worker to blame: the data does not inflate, the entry is corrupt.
      throw this.markCorrupt(error instanceof Error ? error : new Error(String(error)));
    }
    if (this.corrupt) throw this.corrupt; // another chunk found the entry corrupt meanwhile
    return raw;
  };

  /**
   * Inflate (when compressed) AND decode a whole chunk on a worker; pass it as `decode` to
   * `openGeometryChunksV13`. The same failure rules as `inflate`: a worker failure decodes this and
   * the remaining chunks here (as without workers); a chunk the worker could not decode is decoded
   * here to tell a corrupt entry (`CorruptChunkError`) from a worker that cannot decode.
   *
   * The meshes' arrays are views into shared arena blocks (`ChunkDecodeOptions.sharedArena`), on a
   * worker or here: never transfer or reinterpret their `.buffer`; copy (`array.slice()`) first.
   */
  readonly decode: ChunkDecode = async (stored, info, version) => {
    if (this.closed) throw new ChunkPoolClosedError('chunk inflate pool closed');
    if (this.corrupt) throw this.corrupt;
    if (!this.fallback) {
      const lane = this.lanes[this.next++ % this.lanes.length];
      try {
        return await lane.decode(stored, info, version);
      } catch (error) {
        // Closed while in flight (the load ended): an abort, not a worker failure; nothing decodes here.
        if (this.closed) throw new ChunkPoolClosedError('chunk inflate pool closed');
        if (this.corrupt) throw this.corrupt;
        if (error instanceof WorkerCodecError) return this.confirmDecodeHere(stored, info, version, error);
        this.useFallback(error);
      }
    }
    let meshes: Awaited<ReturnType<ChunkDecode>>;
    try {
      meshes = await decodeGeometryChunk(stored, info, version, { sharedArena: true }); // as the workers decode
    } catch (error) {
      throw this.markCorrupt(error instanceof Error ? error : new Error(String(error)));
    }
    if (this.corrupt) throw this.corrupt; // another chunk found the entry corrupt meanwhile
    return meshes;
  };

  /**
   * Decode a chunk on a worker, never on the calling thread: for work ahead of the consumer (the
   * cache hit's prefetch). It rejects with `NoChunkWorkerError` when no worker can take it (they
   * failed or cannot start: the pool switches to calling-thread decoding as `decode` would) and on a
   * worker codec error, so the consumer decodes that chunk on demand, paced by its own loop, where
   * `decode`'s rules apply (including `CorruptChunkError`).
   */
  readonly decodeOnWorkers: ChunkDecode = async (stored, info, version) => {
    if (this.closed) throw new ChunkPoolClosedError('chunk inflate pool closed');
    if (this.corrupt) throw this.corrupt;
    if (this.fallback) throw new NoChunkWorkerError('no chunk worker');
    const lane = this.lanes[this.next++ % this.lanes.length];
    try {
      return await lane.decode(stored, info, version);
    } catch (error) {
      if (this.closed) throw new ChunkPoolClosedError('chunk inflate pool closed');
      if (this.corrupt) throw this.corrupt;
      if (!(error instanceof WorkerCodecError)) this.useFallback(error);
      throw new NoChunkWorkerError(error instanceof Error ? error.message : String(error));
    }
  };

  private async confirmDecodeHere(stored: Uint8Array, info: GeometryChunkInfo, version: number, workerError: Error): Promise<MeshData[]> {
    let meshes: MeshData[];
    try {
      meshes = await decodeGeometryChunk(stored, info, version, { sharedArena: true }); // as the workers decode
    } catch {
      throw this.markCorrupt(workerError);
    }
    if (this.corrupt) throw this.corrupt;
    this.useFallback(workerError);
    return meshes;
  }

  /** A chunk the worker's codec refused: corrupt if it fails here too, else the worker cannot inflate. */
  private async confirmHere(stored: Uint8Array, workerError: Error): Promise<Uint8Array> {
    let raw: Uint8Array;
    try {
      raw = await inflateRaw(stored);
    } catch {
      throw this.markCorrupt(workerError);
    }
    if (this.corrupt) throw this.corrupt;
    this.useFallback(workerError);
    return raw;
  }

  /** True once a worker failed and chunks inflate on the calling thread. */
  get inflatingHere(): boolean { return this.fallback; }

  /** End the pool (its load ended): workers stop, and pending and later requests reject with `ChunkPoolClosedError`. */
  close(): void {
    this.closed = true;
    this.stopLanes();
  }

  /** True once `close()` ran. */
  get isClosed(): boolean { return this.closed; }

  private stopLanes(): void {
    for (const lane of this.lanes) lane.close();
  }

  private markCorrupt(error: Error): CorruptChunkError {
    this.corrupt ??= new CorruptChunkError(`a geometry chunk did not inflate here or on a worker; the cache entry is corrupt (${error.message})`);
    this.stopLanes(); // the other workers' requests reject now, as corrupt (checked first above)
    return this.corrupt;
  }

  private useFallback(error: unknown): void {
    if (this.fallback) return;
    this.fallback = true;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[cache] chunk inflate worker failed (${reason}); inflating the remaining chunks on this thread`);
    this.stopLanes();
  }
}
