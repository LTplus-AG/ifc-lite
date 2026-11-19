/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IndexedDB home of the live-geometry backing. Operational storage for models
 * open in THIS page, separate from the opportunistic reopen cache (`ifc-cache`):
 * nothing here is evicted by cache maintenance, and nothing outlives the page
 * that wrote it except until the next page sweeps it.
 *
 * Ownership is a Web Lock per page session, acquired before the session is
 * recorded. A session record whose lock nobody holds belongs to a closed or
 * crashed page and is swept. Without the Web Locks API no other session is
 * ever swept (a live tab's backing must never be deleted on a guess).
 *
 * Writes follow `IdbConnectionLifecycle`: a transaction is created
 * synchronously; only a closed connection's synchronous InvalidStateError is
 * retried, once; a request, abort or commit failure is reported, never replayed.
 */

import { IdbConnectionLifecycle } from '@/services/idb-connection';

export const BACKING_DB_NAME = 'ifc-lite-geometry-backing';
const DB_VERSION = 1;
export const SESSIONS = 'sessions';
export const CHUNKS = 'chunks';
export const SOURCES = 'sources';
export const SHARDS = 'shards';
const DATA_STORES = [CHUNKS, SOURCES, SHARDS] as const;
const LOCK_PREFIX = 'ifc-lite-geometry-backing:';

export interface BackingDatabaseOptions {
  factory?: IDBFactory;
  /** `null` disables locking and sweeping (tests, or a browser without Web Locks). */
  locks?: LockManager | null;
  session?: string;
  name?: string;
}

export interface StorageCapacity { quota: number; usage: number }

function abortError(tx: IDBTransaction): Error {
  return tx.error ?? new DOMException('Geometry backing transaction aborted', 'AbortError');
}

export class BackingDatabase {
  private readonly lifecycle = new IdbConnectionLifecycle('[GeometryBacking]');
  private releaseLock: (() => void) | undefined;
  private connection: IDBDatabase | null = null;
  private closed = false;
  /** Whether stale sessions of other pages can be detected and swept. */
  readonly sweeps: boolean;

  private constructor(
    private readonly factory: IDBFactory,
    private readonly name: string,
    readonly session: string,
    private readonly locks: LockManager | null,
  ) {
    this.sweeps = locks !== null;
  }

  static async open(options: BackingDatabaseOptions = {}): Promise<BackingDatabase> {
    const factory = options.factory ?? globalThis.indexedDB;
    if (!factory) throw new Error('IndexedDB is unavailable; geometry cannot be backed locally');
    const locks = options.locks === undefined ? (globalThis.navigator?.locks ?? null) : options.locks;
    const database = new BackingDatabase(factory, options.name ?? BACKING_DB_NAME,
      options.session ?? crypto.randomUUID(), locks);
    try {
      await database.acquireLock();
      await database.commit([SESSIONS], (tx) => {
        tx.objectStore(SESSIONS).put({ createdAt: Date.now() }, database.session);
      });
      await database.sweepStaleSessions();
    } catch (error) {
      database.close();
      throw error;
    }
    return database;
  }

  private async acquireLock(): Promise<void> {
    const locks = this.locks;
    if (!locks) return;
    await new Promise<void>((granted, failed) => {
      locks.request(`${LOCK_PREFIX}${this.session}`, { mode: 'exclusive' }, () => {
        granted();
        return new Promise<void>((release) => { this.releaseLock = release; });
      }).then(undefined, failed);
    });
  }

  private connect(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error('Geometry backing database is closed'));
    return this.lifecycle.open(() => new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of [SESSIONS, ...DATA_STORES]) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (this.closed) {
          db.close();
          reject(new Error('Geometry backing database closed while opening'));
          return;
        }
        this.connection = db;
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Geometry backing database failed to open'));
      request.onblocked = () => reject(new Error('Geometry backing database upgrade is blocked by another tab'));
    }));
  }

  /**
   * One read-write transaction. Resolves only when the transaction COMPLETES
   * (the data is committed and readable); rejects on abort, including
   * QuotaExceededError. `write` must only issue requests synchronously.
   */
  async commit(stores: readonly string[], write: (tx: IDBTransaction) => void): Promise<void> {
    const done = await this.lifecycle.withConnection(() => this.connect(), (db) => {
      const tx = db.transaction([...stores], 'readwrite');
      try {
        write(tx);
      } catch (error) {
        // Nothing committed: abort so the failed batch has no partial effect.
        tx.abort();
        throw error;
      }
      return new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(abortError(tx));
      });
    });
    return done;
  }

  /** One read-only transaction; `read` issues requests and returns their collector. */
  async read<T>(stores: readonly string[], read: (tx: IDBTransaction) => () => T): Promise<T> {
    const done = await this.lifecycle.withConnection(() => this.connect(), (db) => {
      const tx = db.transaction([...stores], 'readonly');
      const collect = read(tx);
      return new Promise<T>((resolve, reject) => {
        tx.oncomplete = () => resolve(collect());
        tx.onabort = () => reject(abortError(tx));
      });
    });
    return done;
  }

  static prefixRange(prefix: readonly IDBValidKey[]): IDBKeyRange {
    // Arrays sort after every number and string, so [...prefix, []] bounds it.
    return IDBKeyRange.bound([...prefix], [...prefix, []]);
  }

  /** Delete every record of one backing generation of this session. */
  deleteBacking(backingId: string): Promise<void> {
    const range = BackingDatabase.prefixRange([this.session, backingId]);
    return this.commit(DATA_STORES, (tx) => {
      for (const store of DATA_STORES) tx.objectStore(store).delete(range);
    });
  }

  private async sweepStaleSessions(): Promise<void> {
    if (!this.locks) return;
    const snapshot = await this.locks.query();
    const held = new Set((snapshot.held ?? []).map((lock) => lock.name));
    const sessions = await this.read([SESSIONS], (tx) => {
      const request = tx.objectStore(SESSIONS).getAllKeys();
      return () => request.result;
    });
    const stale = sessions.filter((key): key is string => typeof key === 'string'
      && key !== this.session && !held.has(`${LOCK_PREFIX}${key}`));
    if (stale.length === 0) return;
    await this.commit([SESSIONS, ...DATA_STORES], (tx) => {
      for (const session of stale) {
        for (const store of DATA_STORES) tx.objectStore(store).delete(BackingDatabase.prefixRange([session]));
        tx.objectStore(SESSIONS).delete(session);
      }
    });
  }

  /** Browser quota for this origin, when the Storage API reports one. */
  static async capacity(): Promise<StorageCapacity | undefined> {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    if (!estimate || estimate.quota === undefined || estimate.usage === undefined) return undefined;
    return { quota: estimate.quota, usage: estimate.usage };
  }

  /** Record count under one backing (diagnostics and tests). */
  async count(store: string, backingId: string): Promise<number> {
    return this.read([store], (tx) => {
      const request = tx.objectStore(store).count(BackingDatabase.prefixRange([this.session, backingId]));
      return () => request.result;
    });
  }

  /** Close the connection and give up the session lock (its data becomes sweepable). */
  close(): void {
    this.closed = true;
    this.connection?.close();
    this.connection = null;
    this.lifecycle.reset();
    this.releaseLock?.();
    this.releaseLock = undefined;
  }
}
