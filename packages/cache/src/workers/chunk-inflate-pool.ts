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
 *
 * Workers start only on `start()` or the first compressed chunk: a
 * metadata-only entry, or one whose chunks are all stored raw, starts none.
 */

import { inflateRaw } from '../sections/geometry-codec.js';
import type { ChunkInflate } from '../sections/geometry-chunks.js';
import { GeometryCompressionSession, WorkerCodecError, type CompressionWorkerPort } from './geometry-compression-client.js';

/** A stored chunk that does not inflate: the cache entry is corrupt. */
export class CorruptChunkError extends Error {
  override name = 'CorruptChunkError';
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

  constructor(size: number, options: ChunkInflatePoolOptions = {}) {
    const stallMs = options.stallMs ?? STALL_MS;
    this.lanes = Array.from({ length: Math.max(1, Math.floor(size)) }, () => new Lane(options.createWorker, stallMs));
  }

  /** Start every worker now, so they boot while other work runs. */
  start(): this {
    if (this.fallback || this.corrupt) return this;
    try {
      for (const lane of this.lanes) lane.session.start();
    } catch (error) {
      this.useFallback(error);
    }
    return this;
  }

  readonly inflate: ChunkInflate = async (stored, rawLength) => {
    if (this.corrupt) throw this.corrupt;
    if (!this.fallback) {
      const lane = this.lanes[this.next++ % this.lanes.length];
      try {
        return await lane.inflate(stored, rawLength);
      } catch (error) {
        if (this.corrupt) throw this.corrupt;
        if (error instanceof WorkerCodecError) return this.confirmHere(stored, error);
        this.useFallback(error);
      }
    }
    return inflateRaw(stored);
  };

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

  close(): void {
    for (const lane of this.lanes) lane.close();
  }

  private markCorrupt(error: Error): CorruptChunkError {
    this.corrupt ??= new CorruptChunkError(`a geometry chunk did not inflate here or on a worker; the cache entry is corrupt (${error.message})`);
    this.close(); // the other workers' requests reject now, as corrupt (checked first above)
    return this.corrupt;
  }

  private useFallback(error: unknown): void {
    if (this.fallback) return;
    this.fallback = true;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[cache] chunk inflate worker failed (${reason}); inflating the remaining chunks on this thread`);
    this.close();
  }
}
