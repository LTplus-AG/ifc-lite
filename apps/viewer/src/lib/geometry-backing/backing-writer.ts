/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bounded append queue from the streaming consumer into the backing database.
 *
 * - `append` copies meshes into chunk records and returns once the encoded but
 *   uncommitted bytes fit the queue bound: backpressure on the producer, so a
 *   slow disk cannot grow an unbounded second copy in memory.
 * - A chunk is acknowledged only when its transaction completes. Its canonical
 *   sources are written in the same transaction, so no committed chunk can
 *   reference a missing source.
 * - Any failure (quota, abort, closed connection, encode refusal) makes the
 *   writer terminally failed: queued chunks are dropped, every waiter rejects,
 *   and nothing is retried. The caller keeps its CPU arrays; a failed backing
 *   is never complete, so it can never justify releasing them.
 */

import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { CHUNKS, SHARDS, SOURCES, type BackingDatabase } from './backing-database';
import { BackingDirectory, ChunkBuilder, meshFrameBounds, type RecordState } from './backing-directory';
import { encodeMeshRecord, type MeshRecord, type PendingSource, type SourcePool, type TextureBitmapTable } from './mesh-record';
import { encodeShardRecord } from './shard-record';

export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
export const DEFAULT_QUEUE_BYTES = 64 * 1024 * 1024;

export interface BackingWriterOptions {
  /** A chunk is sealed once its stored bytes reach this. */
  chunkBytes?: number;
  /** Encoded-but-uncommitted bytes above which `append` waits. */
  queueBytes?: number;
}

export interface ChunkRecord { meshes: MeshRecord[] }

export class GeometryBackingFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GeometryBackingFailedError';
  }
}

interface Job { kind: 'chunk' | 'shard'; index: number; bytes: number; stores: string[]; write(tx: IDBTransaction): void }
interface Waiter { resolve(): void; reject(error: Error): void }

function positiveBytes(value: number | undefined, fallback: number, what: string): number {
  const bytes = value ?? fallback;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError(`${what} must be a positive safe integer`);
  return bytes;
}

export class BackingWriter {
  private readonly chunkBytes: number;
  private readonly queueBytes: number;
  private builder = new ChunkBuilder();
  private records: MeshRecord[] = [];
  private sources: PendingSource[] = [];
  private readonly queue: Job[] = [];
  private draining = false;
  private uncommitted = 0;
  private failure: Error | undefined;
  private closed = false;
  private progress: Waiter[] = [];
  private readonly recordWaiters = new Map<string, Waiter[]>();
  private appendTurn: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: BackingDatabase,
    private readonly backingId: string,
    private readonly directory: BackingDirectory,
    private readonly pool: SourcePool,
    private readonly bitmaps: TextureBitmapTable,
    options: BackingWriterOptions = {},
  ) {
    this.chunkBytes = positiveBytes(options.chunkBytes, DEFAULT_CHUNK_BYTES, 'Backing chunk size');
    this.queueBytes = positiveBytes(options.queueBytes, DEFAULT_QUEUE_BYTES, 'Backing queue bound');
    // The open chunk is outside the queue's wait condition; keep it within the bound.
    if (this.chunkBytes > this.queueBytes) throw new RangeError('Backing chunk size must not exceed the queue bound');
  }

  get error(): Error | undefined { return this.failure; }
  get isClosed(): boolean { return this.closed; }
  /** Bytes copied for storage and not yet committed (the queue's memory cost). */
  get pendingBytes(): number { return this.uncommitted; }

  private usable(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new GeometryBackingFailedError('Geometry backing writer is closed');
  }

  /** Serialize copying and close/flush boundaries, including concurrent callers.
   * The barrier itself always resolves; operation failures reach their callers
   * and terminal writer state rather than becoming an unhandled tail rejection.
   * Producers must leave their input unchanged until their append resolves. */
  private async serialized(operation: () => Promise<void>): Promise<void> {
    const previous = this.appendTurn;
    let release!: () => void;
    this.appendTurn = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { await operation(); } finally { release(); }
  }

  /** Copy `meshes` into the backing; resolves when the queue has room again. */
  append(meshes: readonly MeshData[]): Promise<void> {
    return this.serialized(() => this.appendMeshes(meshes));
  }

  private async appendMeshes(meshes: readonly MeshData[]): Promise<void> {
    this.usable();
    try {
      for (const mesh of meshes) {
        const encoded = encodeMeshRecord(mesh, this.pool, this.bitmaps);
        const bounds = meshFrameBounds(mesh);
        this.directory.noteMesh(mesh, this.directory.chunks.length, bounds);
        this.builder.add(mesh, encoded.bytes, bounds);
        this.records.push(encoded.record);
        this.sources.push(...encoded.sources);
        this.uncommitted += encoded.bytes;
        if (this.builder.bytes >= this.chunkBytes) this.seal();
        // A single append can contain a model's entire resident mesh list.
        // Stop after the first mesh crossing the bound, before copying more.
        if (this.uncommitted > this.queueBytes) {
          await this.room();
          this.usable();
        }
      }
    } catch (error) {
      throw this.fail(error, 'Geometry could not be encoded for local backing');
    }
    await this.room();
  }

  /** Back one decoded instanced shard: templates and every occurrence. */
  appendInstancedShard(shard: DecodedInstancedShard): Promise<void> {
    return this.serialized(() => this.appendShard(shard));
  }

  private async appendShard(shard: DecodedInstancedShard): Promise<void> {
    this.usable();
    let encoded: ReturnType<typeof encodeShardRecord>;
    try {
      encoded = encodeShardRecord(shard);
    } catch (error) {
      throw this.fail(error, 'Instanced geometry could not be encoded for local backing');
    }
    const index = this.directory.shards.length;
    this.directory.addShard(index, encoded.bytes, encoded.entityIds);
    const key = [this.db.session, this.backingId, index];
    const record = encoded.record;
    this.uncommitted += encoded.bytes;
    this.enqueue({ kind: 'shard', index, bytes: encoded.bytes, stores: [SHARDS],
      write: (tx) => { tx.objectStore(SHARDS).put(record, key); } });
    await this.room();
  }

  private seal(): void {
    if (this.builder.meshCount === 0) return;
    const entry = this.directory.sealChunk(this.directory.chunks.length, this.builder);
    const chunk: ChunkRecord = { meshes: this.records };
    const sources = this.sources;
    const { session } = this.db, backingId = this.backingId;
    this.builder = new ChunkBuilder();
    this.records = [];
    this.sources = [];
    this.enqueue({ kind: 'chunk', index: entry.index, bytes: entry.bytes,
      stores: sources.length > 0 ? [CHUNKS, SOURCES] : [CHUNKS],
      write: (tx) => {
        for (const source of sources) tx.objectStore(SOURCES).put(source.indices, [session, backingId, source.id]);
        tx.objectStore(CHUNKS).put(chunk, [session, backingId, entry.index]);
      } });
  }

  private enqueue(job: Job): void {
    this.queue.push(job);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.failure) {
        const job = this.queue[0];
        try {
          await this.db.commit(job.stores, job.write);
        } catch (error) {
          this.fail(error, `Local geometry backing ${job.kind} ${job.index} was not committed`);
          return;
        }
        if (this.failure) return;
        this.queue.shift();
        this.uncommitted -= job.bytes;
        this.settle(job.kind, job.index, 'durable');
        this.wake();
      }
    } finally {
      this.draining = false;
    }
  }

  private entry(kind: Job['kind'], index: number): { state: RecordState } {
    return kind === 'chunk' ? this.directory.chunks[index] : this.directory.shards[index];
  }

  private settle(kind: Job['kind'], index: number, state: RecordState): void {
    this.entry(kind, index).state = state;
    const key = `${kind}:${index}`;
    const waiters = this.recordWaiters.get(key) ?? [];
    this.recordWaiters.delete(key);
    for (const waiter of waiters) {
      if (state === 'durable') waiter.resolve();
      else waiter.reject(this.failure ?? new GeometryBackingFailedError(`${key} failed`));
    }
  }

  private wake(): void {
    const waiters = this.progress;
    this.progress = [];
    for (const waiter of waiters) waiter.resolve();
  }

  /** Terminal failure: report once, reject everyone, retry nothing. */
  private fail(cause: unknown, message: string): Error {
    if (this.failure) return this.failure;
    const error = new GeometryBackingFailedError(message, { cause });
    this.failure = error;
    for (const job of this.queue) this.settle(job.kind, job.index, 'failed');
    this.queue.length = 0;
    for (const chunk of this.directory.chunks) if (chunk.state === 'pending') chunk.state = 'failed';
    for (const shard of this.directory.shards) if (shard.state === 'pending') shard.state = 'failed';
    for (const waiters of this.recordWaiters.values()) for (const waiter of waiters) waiter.reject(error);
    this.recordWaiters.clear();
    const progress = this.progress;
    this.progress = [];
    for (const waiter of progress) waiter.reject(error);
    // Drop references to copies that will never be written.
    this.records = [];
    this.sources = [];
    this.uncommitted = 0;
    return error;
  }

  /** Stop accepting and drop queued work; committed records stay until disposed. */
  abort(reason: Error): void {
    this.fail(reason, 'Geometry backing was aborted');
  }

  private nextProgress(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => { this.progress.push({ resolve, reject }); });
  }

  private async room(): Promise<void> {
    while (this.uncommitted > this.queueBytes && this.queue.length > 0) await this.nextProgress();
    if (this.failure) throw this.failure;
  }

  /** Seal the partial chunk and resolve once everything appended is committed. */
  flush(): Promise<void> {
    return this.serialized(() => this.flushPending());
  }

  private async flushPending(): Promise<void> {
    this.usable();
    this.seal();
    while (this.queue.length > 0) await this.nextProgress();
    if (this.failure) throw this.failure;
  }

  /** Flush, then refuse further appends. Resolution = complete, committed backing. */
  close(): Promise<void> {
    return this.serialized(async () => {
      // Two consumers can request the same final acknowledgement concurrently.
      if (this.closed && !this.failure) return;
      await this.flushPending();
      this.closed = true;
    });
  }

  /** Resolves once a sealed record is committed; rejects if it never will be. */
  whenDurable(kind: Job['kind'], index: number): Promise<void> {
    const entry = this.entry(kind, index);
    if (!entry) return Promise.reject(new RangeError(`No backed ${kind} ${index}`));
    if (entry.state === 'durable') return Promise.resolve();
    if (entry.state === 'failed') return Promise.reject(this.failure ?? new GeometryBackingFailedError(`${kind} ${index} failed`));
    const key = `${kind}:${index}`;
    return new Promise<void>((resolve, reject) => {
      const waiters = this.recordWaiters.get(key) ?? [];
      waiters.push({ resolve, reject });
      this.recordWaiters.set(key, waiters);
    });
  }

  /** Whether a mesh of the still-open chunk is waiting for `flush`. */
  get hasUnsealed(): boolean { return this.builder.meshCount > 0; }
}
