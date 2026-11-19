/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * On-demand readback from the live-geometry backing.
 *
 * - Decoded chunks are retained by BYTES. A leased chunk is never evicted
 *   while leased, so a lease may exceed the budget transiently; it is trimmed
 *   when the last lease is released. Unleased chunks are evicted oldest first.
 * - All-model consumers iterate chunk by chunk (`meshes()`), holding one
 *   chunk's lease at a time, instead of concatenating the model.
 * - Every read is fenced: a backing replaced, invalidated or disposed while a
 *   read awaits IndexedDB fails with `StaleGeometryGenerationError` and its
 *   result never enters the cache, so stale geometry cannot reappear.
 * - Cancellation is an AbortSignal, checked around every await; an aborted
 *   read releases what it acquired. An IndexedDB request itself cannot be
 *   cancelled; its result is discarded.
 * - Canonical sources decoded once are shared by identity with any other
 *   chunk decoded while they are alive (weakly), as on the live model.
 */

import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { CHUNKS, SHARDS, SOURCES, type BackingDatabase } from './backing-database';
import type { BackingDirectory, Vec3 } from './backing-directory';
import { decodeMeshRecord, recordArrayBytes, type TextureBitmapTable } from './mesh-record';
import type { BackingWriter, ChunkRecord } from './backing-writer';
import type { ShardRecord } from './shard-record';

export const DEFAULT_DECODED_CACHE_BYTES = 32 * 1024 * 1024;

export class StaleGeometryGenerationError extends Error {
  constructor(message = 'The backed geometry generation was replaced while it was read') {
    super(message);
    this.name = 'StaleGeometryGenerationError';
  }
}

export class GeometryNotBackedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeometryNotBackedError';
  }
}

export interface MeshLease {
  readonly meshes: readonly MeshData[];
  /** Idempotent. Lets the reader evict the decoded chunks again. */
  release(): void;
}

export interface ReadOptions { signal?: AbortSignal }

interface Decoded { index: number; meshes: MeshData[]; bytes: number; leases: number }

export class BackingReader {
  private readonly budget: number;
  private readonly decoded = new Map<number, Decoded>();
  private readonly loading = new Map<number, Promise<Decoded>>();
  private readonly sources = new Map<number, WeakRef<Uint32Array>>();

  constructor(
    private readonly db: BackingDatabase,
    private readonly backingId: string,
    private readonly directory: BackingDirectory,
    private readonly writer: BackingWriter,
    private readonly bitmaps: TextureBitmapTable,
    /** False once this backing generation is no longer the model's current one. */
    private readonly current: () => boolean,
    decodedCacheBytes = DEFAULT_DECODED_CACHE_BYTES,
  ) {
    if (!Number.isSafeInteger(decodedCacheBytes) || decodedCacheBytes < 0) {
      throw new RangeError('Decoded backing cache bytes must be a non-negative safe integer');
    }
    this.budget = decodedCacheBytes;
  }

  /** Decoded bytes currently retained, leased or not. */
  get retainedBytes(): number {
    let bytes = 0;
    for (const entry of this.decoded.values()) bytes += entry.bytes;
    return bytes;
  }

  private fence(signal: AbortSignal | undefined): void {
    signal?.throwIfAborted();
    if (!this.current()) throw new StaleGeometryGenerationError();
  }

  private async decode(index: number, signal: AbortSignal | undefined): Promise<Decoded> {
    const entry = this.directory.chunks[index];
    if (!entry) throw new GeometryNotBackedError(`Chunk ${index} is not sealed yet`);
    await this.writer.whenDurable('chunk', index);
    this.fence(signal);
    const key = [this.db.session, this.backingId, index];
    const requested: number[] = [];
    // Pin live weak-cache hits across the transaction completion await too.
    const loaded = new Map<number, Uint32Array>();
    const { record, fetched } = await this.db.read([CHUNKS, SOURCES], (tx) => {
      const request = tx.objectStore(CHUNKS).get(key);
      const fetched = new Map<number, unknown>();
      request.onsuccess = () => {
        const record = request.result as ChunkRecord | undefined;
        for (const mesh of record?.meshes ?? []) {
          const source = mesh.appearance?.source;
          if (!source || !('pooled' in source)) continue;
          const id = source.pooled;
          if (requested.includes(id) || loaded.has(id)) continue;
          const existing = this.sources.get(id)?.deref();
          if (existing) {
            loaded.set(id, existing);
            continue;
          }
          requested.push(id);
          const sourceRequest = tx.objectStore(SOURCES).get([this.db.session, this.backingId, id]);
          sourceRequest.onsuccess = () => { fetched.set(id, sourceRequest.result); };
        }
      };
      return () => ({ record: request.result as ChunkRecord | undefined, fetched });
    });
    this.fence(signal);
    if (!record) throw new GeometryNotBackedError(`Backed chunk ${index} is missing from storage`);
    for (const id of requested) {
      const indices = fetched.get(id);
      if (!(indices instanceof Uint32Array)) throw new GeometryNotBackedError(`Canonical source ${id} of chunk ${index} is missing`);
      this.sources.set(id, new WeakRef(indices));
      loaded.set(id, indices);
    }
    const pinned = loaded;
    const context = {
      source: (id: number) => {
        const indices = pinned.get(id) ?? this.sources.get(id)?.deref();
        if (!indices) throw new GeometryNotBackedError(`Canonical source ${id} was not loaded`);
        pinned.set(id, indices);
        return indices;
      },
      bitmap: (textureId: number) => this.bitmaps.get(textureId),
    };
    const meshes = record.meshes.map((mesh) => decodeMeshRecord(mesh, context));
    let bytes = 0;
    for (const mesh of record.meshes) bytes += recordArrayBytes(mesh);
    for (const indices of pinned.values()) bytes += indices.byteLength;
    return { index, meshes, bytes, leases: 0 };
  }

  private async acquire(index: number, signal: AbortSignal | undefined): Promise<Decoded> {
    this.fence(signal);
    let entry = this.decoded.get(index);
    if (!entry) {
      let pending = this.loading.get(index);
      if (!pending) {
        // Shared by concurrent readers, so it must not carry one caller's signal.
        pending = this.decode(index, undefined);
        this.loading.set(index, pending);
        const settled = () => { if (this.loading.get(index) === pending) this.loading.delete(index); };
        pending.then(settled, settled);
      }
      const loaded = await pending;
      this.fence(signal);
      entry = this.decoded.get(index);
      if (!entry) {
        entry = loaded;
        this.decoded.set(index, entry);
      }
    } else {
      // Refresh recency.
      this.decoded.delete(index);
      this.decoded.set(index, entry);
    }
    entry.leases++;
    return entry;
  }

  private release(entry: Decoded): void {
    entry.leases--;
    this.trim();
  }

  private trim(): void {
    let bytes = this.retainedBytes;
    for (const [index, entry] of this.decoded) {
      if (bytes <= this.budget) break;
      if (entry.leases > 0) continue;
      this.decoded.delete(index);
      bytes -= entry.bytes;
    }
  }

  /** Lease the given chunks together; all or nothing. */
  async leaseChunks(indices: readonly number[], options: ReadOptions = {}): Promise<MeshLease> {
    this.fence(options.signal);
    const held: Decoded[] = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const entry of held) this.release(entry);
    };
    try {
      for (const index of indices) held.push(await this.acquire(index, options.signal));
    } catch (error) {
      release();
      throw error;
    }
    return { meshes: held.flatMap((entry) => entry.meshes), release };
  }

  /** Every backed flat mesh of one entity (as owner or colour-merged host). */
  async leaseEntity(expressId: number, options: ReadOptions = {}): Promise<MeshLease> {
    const lease = await this.leaseChunks(this.directory.chunksOf(expressId), options);
    const meshes = lease.meshes.filter((mesh) => mesh.expressId === expressId || mesh.entityIds?.includes(expressId));
    return { meshes, release: lease.release };
  }

  /** Stream every backed flat mesh, optionally limited to chunks meeting a box. */
  async *meshes(options: ReadOptions & { bounds?: { min: Vec3; max: Vec3 } } = {}): AsyncGenerator<readonly MeshData[]> {
    const indices = options.bounds
      ? this.directory.chunksIntersecting(options.bounds.min, options.bounds.max)
      : this.directory.chunks.map((chunk) => chunk.index);
    for (const index of indices) {
      const entry = await this.acquire(index, options.signal);
      try {
        yield entry.meshes;
      } finally {
        this.release(entry);
      }
      this.fence(options.signal);
    }
  }

  /** Stream every backed instanced shard (templates and occurrences). */
  async *instancedShards(options: ReadOptions = {}): AsyncGenerator<DecodedInstancedShard> {
    for (const shard of this.directory.shards) {
      await this.writer.whenDurable('shard', shard.index);
      this.fence(options.signal);
      const key = [this.db.session, this.backingId, shard.index];
      const record = await this.db.read([SHARDS], (tx) => {
        const request = tx.objectStore(SHARDS).get(key);
        return () => request.result as ShardRecord | undefined;
      });
      this.fence(options.signal);
      if (!record) throw new GeometryNotBackedError(`Backed instanced shard ${shard.index} is missing from storage`);
      yield record;
    }
  }

  /** Drop every unleased decoded chunk (memory pressure or disposal). */
  clear(): void {
    for (const [index, entry] of this.decoded) if (entry.leases === 0) this.decoded.delete(index);
  }
}
