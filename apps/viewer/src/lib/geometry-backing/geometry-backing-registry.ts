/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One backing generation per live model, keyed by federated model id.
 *
 * A generation is the geometry of one model as streamed. Anything that
 * changes that geometry (a content-version reload, a mesh edit, a transform
 * written into the arrays, an undo restore) must `invalidate` the model: the
 * generation stops being current, its readers fail with
 * `StaleGeometryGenerationError`, its records are deleted, and the model has no
 * complete backing until a new generation is written. A disk image from before
 * a mutation therefore never answers as current geometry.
 *
 * `isComplete` is the only signal a CPU-release decision may use: the writer
 * closed successfully, every record committed, and the generation is current.
 * Product release stays disabled; nothing in the viewer consults it yet.
 */

import { BackingDatabase, type BackingDatabaseOptions, type StorageCapacity } from './backing-database';
import { BackingDirectory } from './backing-directory';
import { BackingReader } from './backing-reader';
import { BackingWriter, GeometryBackingFailedError, type BackingWriterOptions } from './backing-writer';
import { SourcePool, TextureBitmapTable } from './mesh-record';

export interface ModelBackingOptions extends BackingWriterOptions {
  decodedCacheBytes?: number;
}

/** Proof that one model generation was completely committed. Verify it with
 * `GeometryBackingRegistry.verify` immediately before discarding CPU arrays:
 * a void callback or the active model at that moment is not such proof. */
export interface BackingAcknowledgement {
  readonly modelId: string;
  readonly generation: number;
  readonly backingId: string;
  readonly chunks: number;
  readonly shards: number;
}

export class ModelGeometryBacking {
  readonly directory = new BackingDirectory();
  readonly writer: BackingWriter;
  readonly reader: BackingReader;
  private live = true;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly db: BackingDatabase,
    readonly modelId: string,
    readonly generation: number,
    readonly backingId: string,
    options: ModelBackingOptions,
  ) {
    const bitmaps = new TextureBitmapTable();
    this.writer = new BackingWriter(db, backingId, this.directory, new SourcePool(), bitmaps, options);
    this.reader = new BackingReader(db, backingId, this.directory, this.writer, bitmaps,
      () => this.live, options.decodedCacheBytes);
  }

  get isCurrent(): boolean { return this.live; }

  /** Closed, fully committed and still current: the precondition for any release. */
  get isComplete(): boolean {
    return this.live && this.writer.isClosed && !this.writer.error
      && this.directory.chunks.every((chunk) => chunk.state === 'durable')
      && this.directory.shards.every((shard) => shard.state === 'durable');
  }

  /** Close the writer and acknowledge this exact generation once it is complete. */
  async acknowledge(): Promise<BackingAcknowledgement> {
    if (!this.writer.isClosed) await this.writer.close();
    if (!this.isComplete) throw new GeometryBackingFailedError(`Backing of ${this.modelId} is not complete`);
    return { modelId: this.modelId, generation: this.generation, backingId: this.backingId,
      chunks: this.directory.chunks.length, shards: this.directory.shards.length };
  }

  /** End this generation and delete its records. Idempotent. */
  dispose(reason = 'Geometry backing generation was replaced'): Promise<void> {
    if (this.disposal) return this.disposal;
    this.live = false;
    if (!this.writer.error) this.writer.abort(new GeometryBackingFailedError(reason));
    this.reader.clear();
    // IndexedDB orders this delete after any put that was already in flight.
    this.disposal = this.db.deleteBacking(this.backingId);
    return this.disposal;
  }
}

export class GeometryBackingRegistry {
  private readonly models = new Map<string, ModelGeometryBacking>();
  private readonly generations = new Map<string, number>();
  private closed = false;

  private constructor(private readonly db: BackingDatabase) {}

  static async open(options: BackingDatabaseOptions = {}): Promise<GeometryBackingRegistry> {
    return new GeometryBackingRegistry(await BackingDatabase.open(options));
  }

  get session(): string { return this.db.session; }
  /** Whether closed pages' leftovers can be detected (Web Locks). */
  get sweepsStaleSessions(): boolean { return this.db.sweeps; }

  /** Atomically replace the current generation, then await the previous one's disposal. */
  async begin(modelId: string, options: ModelBackingOptions = {}): Promise<ModelGeometryBacking> {
    if (this.closed) throw new GeometryBackingFailedError('Geometry backing registry is closed');
    const previous = this.models.get(modelId);
    const generation = (this.generations.get(modelId) ?? 0) + 1;
    this.generations.set(modelId, generation);
    const backing = new ModelGeometryBacking(this.db, modelId, generation,
      `${modelId}\u0000${generation}`, options);
    this.models.set(modelId, backing);
    // Publish before awaiting disposal: a concurrent begin must retire this
    // generation, rather than create a second untracked live backing.
    if (previous) await previous.dispose();
    return backing;
  }

  /** The model's current generation, if any. */
  get(modelId: string): ModelGeometryBacking | undefined { return this.models.get(modelId); }

  /** Whether `ack` still names the model's current, complete generation. */
  verify(ack: BackingAcknowledgement): boolean {
    const backing = this.models.get(ack.modelId);
    return backing !== undefined && backing.generation === ack.generation && backing.backingId === ack.backingId
      && backing.isComplete && backing.directory.chunks.length === ack.chunks
      && backing.directory.shards.length === ack.shards;
  }

  /** The model's geometry changed or it was removed: its backing is no longer valid. */
  async invalidate(modelId: string, reason?: string): Promise<void> {
    const previous = this.models.get(modelId);
    if (!previous) return;
    this.models.delete(modelId);
    await previous.dispose(reason);
  }

  /** Free storage of every model and give up this page's session. */
  async close(): Promise<void> {
    this.closed = true;
    const models = [...this.models.keys()];
    try {
      await Promise.all(models.map((modelId) => this.invalidate(modelId, 'Geometry backing closed')));
    } finally {
      this.db.close();
    }
  }

  /** Remaining origin quota, or undefined when the browser does not report it. */
  static async capacity(): Promise<StorageCapacity | undefined> {
    return BackingDatabase.capacity();
  }
}
