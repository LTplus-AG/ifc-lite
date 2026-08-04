/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IndexedDB cache service for IFC files
 *
 * Stores parsed IFC data and geometry in IndexedDB for fast subsequent loads.
 * Uses xxhash64 of the source file as the cache key.
 */

const DB_NAME = 'ifc-lite-cache';
const DB_VERSION = 1;
const STORE_NAME = 'models';

interface CacheEntry {
  key: string;
  /** The serialized .ifc-lite cache. Written as a Blob since the v13 cold
   *  tier (issue #1682 phase 3b): IndexedDB Blobs are disk-backed, so a
   *  retained handle enables `slice()` PARTIAL reads of geometry chunks
   *  without holding the whole entry in memory. Older entries hold an
   *  ArrayBuffer — readers accept both. */
  buffer: Blob | ArrayBuffer;
  sourceBuffer?: ArrayBuffer; // Original IFC source for on-demand property extraction
  fileName: string;
  fileSize: number;
  createdAt: number;
  /**
   * The source File's `lastModified` (ms epoch) at write. On a mesh-only hit,
   * a differing fresh mtime means the on-disk file changed → treat as a miss.
   * `0`/absent = unknown (fall back to the full-hash revalidation).
   */
  lastModified?: number;
  /**
   * TRUE full-file content hash of the source (SHA-256 hex) at write. Used to
   * VALIDATE a mesh-only hit against the fresh buffer in the background — this is
   * the source-of-truth guard the O(1) spread key can't provide. Stored here in
   * the record, DISTINCT from the header's `sourceHash` and the key's spread
   * fingerprint. Absent when Web Crypto was unavailable at write.
   */
  fullSourceHash?: string;
}

/**
 * Per-entry hard ceiling (1.5GB). A single cache record above this is refused so
 * one pathological model can't blow the whole origin quota. The mesh-only tier
 * caps source at 400MB but its decoded geometry can be larger, so the ceiling is
 * comfortably above that while still catching a runaway blob.
 */
export const PER_ENTRY_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Free-space headroom to keep below the origin quota after a write, so we never
 * write right up to the limit (a full quota fails future writes app-wide and can
 * trip browser eviction of the whole origin). A fixed 128MB is enough to clear
 * the edge without over-reserving on large quotas.
 */
export const QUOTA_HEADROOM_BYTES = 128 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * The connection `dbPromise` last resolved to. Kept alongside the memo so an
 * invalidation can be IDENTITY-CHECKED: a caller that trips over a dead
 * connection must only clear the memo if the memo still holds *that* dead
 * connection, never one a concurrent caller has already reopened.
 */
let memoisedDb: IDBDatabase | null = null;

/** Bytes a cache record occupies on disk (cache buffer + optional source). */
function entryBytes(buffer: Blob | ArrayBuffer, sourceBuffer?: ArrayBuffer): number {
  const bufferBytes = buffer instanceof Blob ? buffer.size : buffer.byteLength;
  return bufferBytes + (sourceBuffer?.byteLength ?? 0);
}

/**
 * Best-effort free bytes remaining in the origin's storage quota. Returns
 * `Infinity` when the Storage API is unavailable (older Safari / blocked) so the
 * caller falls back to the per-entry ceiling alone rather than refusing writes.
 */
export async function availableQuotaBytes(): Promise<number> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const { quota, usage } = await navigator.storage.estimate();
      if (typeof quota === 'number' && typeof usage === 'number') {
        return Math.max(0, quota - usage);
      }
    }
  } catch (err) {
    console.warn('[IFC Cache] storage.estimate() failed; skipping quota guard', err);
  }
  return Infinity;
}

/**
 * Free at least `targetBytes` by evicting least-recently-created entries (oldest
 * `createdAt` first), skipping `keepKey` (the entry we're about to (over)write).
 *
 * NON-DESTRUCTIVE ON FAILURE: it first walks the eligible entries oldest-first
 * and only deletes them if their combined size actually reaches `targetBytes`.
 * If even evicting every eligible entry would fall short, it deletes NOTHING and
 * returns `false`. This matters for a large model on a tight-quota device (e.g.
 * mobile Safari): without it, we would throw away the user's other cached models
 * to make room for a write that can't fit anyway — a pure loss. Returns whether
 * enough room was freed (all deletions commit in one transaction).
 */
export function evictToFree(db: IDBDatabase, targetBytes: number, keepKey: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const cursorReq = store.index('createdAt').openCursor(); // ascending = oldest first
    const victims: IDBValidKey[] = [];
    let cumulative = 0;
    let enough = false;

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && cumulative < targetBytes) {
        const entry = cursor.value as CacheEntry;
        if (entry.key !== keepKey) {
          cumulative += entryBytes(entry.buffer, entry.sourceBuffer);
          victims.push(cursor.primaryKey);
        }
        cursor.continue();
        return;
      }
      // Cursor exhausted or target reached: commit deletions only if they help.
      enough = cumulative >= targetBytes;
      if (enough) {
        for (const key of victims) store.delete(key);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
    tx.oncomplete = () => resolve(enough);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Make room for a `bytes`-sized entry: refuse oversized records, then (if the
 * Storage API reports a tight quota) LRU-evict older entries until it fits.
 * Returns `true` when the write should proceed, `false` when it must be skipped.
 */
export async function ensureRoomForEntry(db: IDBDatabase, bytes: number, keepKey: string): Promise<boolean> {
  if (bytes > PER_ENTRY_MAX_BYTES) {
    console.warn(`[IFC Cache] Entry ${(bytes / 1024 / 1024).toFixed(0)}MB exceeds per-entry ceiling; skipping cache write`);
    return false;
  }

  const available = await availableQuotaBytes();
  if (available === Infinity) return true; // no quota signal — rely on the ceiling
  const required = bytes + QUOTA_HEADROOM_BYTES;
  if (available >= required) return true;

  const need = required - available;
  try {
    const freedEnough = await evictToFree(db, need, keepKey);
    if (freedEnough) return true;
  } catch (err) {
    console.warn('[IFC Cache] LRU eviction failed; skipping cache write', err);
    return false;
  }

  console.warn(`[IFC Cache] Insufficient quota headroom (need ${(need / 1024 / 1024).toFixed(0)}MB after eviction); skipping cache write`);
  return false;
}

/**
 * Open the IndexedDB database
 */
export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[IFC Cache] Failed to open database:', request.error);
      dbPromise = null; // Reset so we can retry
      reject(request.error);
    };

    request.onsuccess = () => {
      const db = request.result;

      // Verify the object store exists (handles corrupted DB state)
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        console.warn('[IFC Cache] Object store missing, recreating database...');
        db.close();
        dbPromise = null;
        memoisedDb = null;

        // Delete and recreate the database
        const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
        deleteRequest.onsuccess = () => {
          // Retry opening after deletion
          openDatabase().then(resolve).catch(reject);
        };
        deleteRequest.onerror = () => {
          reject(new Error('Failed to recreate database'));
        };
        return;
      }

      // A connection can go away underneath the memo. Drop it PROACTIVELY on
      // the two events that announce it, so the next call opens a fresh one
      // instead of handing out a dead handle:
      //  - `versionchange`: another tab is upgrading/deleting the database. We
      //    must close, or we block it; after our own close() no `close` event
      //    fires, so invalidate here explicitly.
      //  - `close`: the connection was closed ABNORMALLY (e.g. the browser
      //    reclaiming storage), which is the case no code path can predict.
      db.onversionchange = () => {
        console.warn('[IFC Cache] Database version change requested elsewhere; closing connection');
        db.close();
        invalidateConnection(db);
      };
      db.onclose = () => {
        console.warn('[IFC Cache] Database connection closed unexpectedly; will reopen on next use');
        invalidateConnection(db);
      };

      memoisedDb = db;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create object store for cached models
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('fileName', 'fileName', { unique: false });
      }
    };
  });

  return dbPromise;
}

/**
 * Drop the memoised connection, but only if it is still `dead`. Concurrent
 * callers all trip over the same dead connection; without this check the second
 * one would clear the memo the first has already refilled, and we would open
 * the database once per in-flight operation instead of once.
 */
function invalidateConnection(dead: IDBDatabase): void {
  if (memoisedDb !== dead) return;
  memoisedDb = null;
  dbPromise = null;
}

/**
 * A closed connection is the one failure that `openDatabase`'s memo cannot see:
 * `IDBDatabase.transaction()` throws `InvalidStateError` SYNCHRONOUSLY once the
 * connection is closed, and none of the operations below can produce that name
 * any other way (an inactive/finished transaction throws
 * `TransactionInactiveError`, a read-only write throws `ReadOnlyError`).
 */
function isClosedConnectionError(err: unknown): boolean {
  return err instanceof Error && err.name === 'InvalidStateError';
}

/**
 * Run `use` against the memoised connection, reopening ONCE if that connection
 * turns out to be closed.
 *
 * `use` must be synchronous and must not have applied any persistent effect
 * before it throws — the only failure treated as retryable is the synchronous
 * `InvalidStateError` from `transaction()`, which means no transaction was ever
 * created and therefore nothing was written. That is what makes the retry
 * safe: it replays a no-op, never a half-applied write.
 *
 * Bounded on purpose: exactly one reopen per operation. If the fresh connection
 * also fails (or the database cannot be opened at all) the error propagates to
 * the caller's non-fatal handler — one broken database must not become an
 * endless open loop.
 */
async function withConnection<T>(use: (db: IDBDatabase) => T): Promise<T> {
  const db = await openDatabase();
  try {
    return use(db);
  } catch (err) {
    if (!isClosedConnectionError(err)) throw err;
    console.warn('[IFC Cache] Connection was closed underneath the cache; reopening', err);
    invalidateConnection(db);
    return use(await openDatabase());
  }
}

/**
 * Begin a transaction on a live connection, reopening once if needed.
 *
 * The caller must use the returned transaction IMMEDIATELY: an IndexedDB
 * transaction stays active only until control returns to the event loop, and
 * every `await` on the path here settles within the same microtask checkpoint
 * (either an already-memoised connection or the open event that just fired).
 * Awaiting anything else between this call and the first request would
 * deactivate it (`TransactionInactiveError`).
 */
function beginTransaction(mode: IDBTransactionMode): Promise<IDBTransaction> {
  return withConnection((db) => db.transaction(STORE_NAME, mode));
}

/**
 * A connection that was live a moment ago, for the callers that need the
 * `IDBDatabase` itself (the quota guard opens its own transactions). The probe
 * is an empty read-only transaction: it does no I/O, and creating it is exactly
 * the operation that throws when the connection is closed.
 */
function liveConnection(): Promise<IDBDatabase> {
  return withConnection((db) => {
    db.transaction(STORE_NAME, 'readonly').abort();
    return db;
  });
}

export interface CacheResult {
  /** Blob for cold-tier-era entries (disk-backed, sliceable); ArrayBuffer for older ones. */
  buffer: Blob | ArrayBuffer;
  sourceBuffer?: ArrayBuffer;
  /** Source File `lastModified` (ms) stored at write; see {@link CacheEntry}. */
  lastModified?: number;
  /** True full-file content hash (SHA-256 hex) stored at write; see {@link CacheEntry}. */
  fullSourceHash?: string;
}

/** Extra validation metadata persisted alongside a cache entry (mesh-only tier). */
export interface CacheEntryMeta {
  lastModified?: number;
  fullSourceHash?: string;
}

/**
 * Get a cached model by hash key
 */
export async function getCached(key: string): Promise<CacheResult | null> {
  try {
    const tx = await beginTransaction('readonly');
    // `return await` is load-bearing: a bare `return promise` inside a try
    // hands the promise straight to the caller, so its rejection would bypass
    // the catch below and break the load instead of degrading to a miss.
    return await new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const entry = request.result as CacheEntry | undefined;
        if (entry) {
          resolve({
            buffer: entry.buffer,
            sourceBuffer: entry.sourceBuffer,
            lastModified: entry.lastModified,
            fullSourceHash: entry.fullSourceHash,
          });
        } else {
          resolve(null);
        }
      };

      request.onerror = () => {
        console.error('[IFC Cache] Failed to get cache entry:', request.error);
        reject(request.error);
      };
    });
  } catch (err) {
    console.warn('[IFC Cache] Cache read failed:', err);
    return null;
  }
}

/**
 * Store a model in the cache
 */
export async function setCached(
  key: string,
  buffer: ArrayBuffer,
  fileName: string,
  fileSize: number,
  sourceBuffer?: ArrayBuffer,
  meta?: CacheEntryMeta,
): Promise<void> {
  try {
    // A connection verified live, so a write does not silently skip just
    // because the memo was holding a closed one (the quota guard below opens
    // its own transactions, so it needs the connection, not a transaction).
    const db = await liveConnection();

    // Quota/eviction guard (prerequisite for the mesh-only tier — entries can be
    // 100s of MB): refuse oversized records and LRU-evict older entries when the
    // origin quota is tight, so a large write can't blow the quota app-wide.
    const roomOk = await ensureRoomForEntry(db, entryBytes(buffer, sourceBuffer), key);
    if (!roomOk) return; // non-fatal: a cache miss next open is a slow load, not a crash

    // A cache write must NEVER break the load (AGENTS.md; task blocker #2): every
    // failure mode here is caught and turned into a non-fatal skip. We resolve
    // (not reject) on failure so callers can `await` without a try/catch, and we
    // wire the transaction's abort/error too — a QuotaExceededError or a
    // blob-too-large record on Safari often surfaces as a tx abort rather than a
    // request error, and without this the promise would hang forever.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE_NAME, 'readwrite');
      } catch (err) {
        // The connection was verified live above, so reaching here means it
        // died inside the quota guard's await. Not retried: a retry would also
        // re-run eviction, and a skipped write is a slow next load, not a
        // failure. The next operation reopens.
        console.warn('[IFC Cache] Could not open write transaction; skipping cache write', err);
        done();
        return;
      }
      const store = tx.objectStore(STORE_NAME);

      const entry: CacheEntry = {
        key,
        // Blob = disk-backed in IDB → enables partial chunk reads later.
        buffer: new Blob([buffer]),
        sourceBuffer,
        fileName,
        fileSize,
        createdAt: Date.now(),
        lastModified: meta?.lastModified,
        fullSourceHash: meta?.fullSourceHash,
      };

      tx.oncomplete = () => done();
      tx.onabort = () => {
        console.warn('[IFC Cache] Cache write transaction aborted (quota / blob too large); skipping', tx.error);
        done();
      };
      tx.onerror = () => {
        console.warn('[IFC Cache] Cache write transaction error; skipping', tx.error);
        done();
      };

      try {
        const request = store.put(entry);
        request.onerror = () => {
          // Prevent the error from also aborting the tx as an unhandled error;
          // the tx.onabort above still resolves us non-fatally.
          console.warn('[IFC Cache] Failed to cache entry (quota / blob too large); skipping', request.error);
        };
      } catch (err) {
        // Synchronous throw from put() (e.g. DataCloneError on an unclonable value).
        console.warn('[IFC Cache] Cache put threw; skipping cache write', err);
        try { tx.abort(); } catch { /* already inactive */ }
        done();
      }
    });
  } catch (err) {
    console.warn('[IFC Cache] Cache write failed:', err);
  }
}

/**
 * Check if a cache entry exists
 */
export async function hasCached(key: string): Promise<boolean> {
  try {
    const tx = await beginTransaction('readonly');
    return await new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE_NAME);
      const request = store.count(IDBKeyRange.only(key));

      request.onsuccess = () => {
        resolve(request.result > 0);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch (err) {
    console.warn('[IFC Cache] Cache existence check failed; treating as a miss:', err);
    return false;
  }
}

/**
 * Delete a cache entry
 */
export async function deleteCached(key: string): Promise<void> {
  try {
    const tx = await beginTransaction('readwrite');
    return await new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('[IFC Cache] Failed to delete cache entry:', err);
  }
}

/**
 * Clear all cached models
 */
export async function clearCache(): Promise<void> {
  try {
    const tx = await beginTransaction('readwrite');
    return await new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('[IFC Cache] Failed to clear cache:', err);
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  entryCount: number;
  totalSize: number;
  entries: Array<{ fileName: string; fileSize: number; createdAt: Date }>;
}> {
  try {
    const tx = await beginTransaction('readonly');
    return await new Promise((resolve, reject) => {
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const entries = request.result as CacheEntry[];
        resolve({
          entryCount: entries.length,
          totalSize: entries.reduce((sum, e) => sum + entryBytes(e.buffer), 0),
          entries: entries.map((e) => ({
            fileName: e.fileName,
            fileSize: e.fileSize,
            createdAt: new Date(e.createdAt),
          })),
        });
      };

      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('[IFC Cache] Cache stats read failed; reporting an empty cache:', err);
    return { entryCount: 0, totalSize: 0, entries: [] };
  }
}
