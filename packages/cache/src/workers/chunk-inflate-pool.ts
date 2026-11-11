/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inflates a cache hit's compressed geometry chunks on a few workers, so the
 * deflate-raw decode (DecompressionStream plus its Blob/stream plumbing) does
 * not run on the main thread. Pass `pool.inflate` to `openGeometryChunksV13`.
 * Output is byte-identical: the workers run the same `inflateRaw`. Once any
 * worker fails, the pool inflates on the calling thread from then on, so a
 * worker problem costs time, never the load.
 */

import { inflateRaw } from '../sections/geometry-codec.js';
import type { ChunkInflate } from '../sections/geometry-chunks.js';
import { GeometryCompressionSession, type CompressionWorkerPort } from './geometry-compression-client.js';

export class ChunkInflatePool {
  private readonly sessions: GeometryCompressionSession[];
  private next = 0;
  private fallback = false;

  constructor(size: number, createWorker?: () => CompressionWorkerPort) {
    this.sessions = Array.from({ length: Math.max(1, Math.floor(size)) }, () => new GeometryCompressionSession(createWorker));
  }

  /** Start every worker now, so they boot while the entry's metadata decodes. */
  start(): this {
    try {
      for (const session of this.sessions) session.start();
    } catch (error) {
      this.useFallback(error);
    }
    return this;
  }

  readonly inflate: ChunkInflate = async (stored, rawLength) => {
    if (!this.fallback) {
      const session = this.sessions[this.next++ % this.sessions.length];
      try {
        return await session.inflate(stored, rawLength);
      } catch (error) {
        this.useFallback(error);
      }
    }
    return inflateRaw(stored);
  };

  /** True once a worker failed and chunks inflate on the calling thread. */
  get inflatingHere(): boolean { return this.fallback; }

  close(): void {
    for (const session of this.sessions) session.close();
  }

  private useFallback(error: unknown): void {
    if (this.fallback) return;
    this.fallback = true;
    console.warn('[cache] chunk inflate worker unavailable; inflating on this thread', error);
    this.close();
  }
}
