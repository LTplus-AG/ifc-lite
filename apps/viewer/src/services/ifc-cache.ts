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
  buffer: ArrayBuffer;
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

/** Bytes a cache record occupies on disk (cache buffer + optional source). */
function entryBytes(buffer: ArrayBuffer, sourceBuffer?: ArrayBuffer): number {
  return buffer.byteLength + (sourceBuffer?.byteLength ?? 0);
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

export interface CacheResult {
  buffer: ArrayBuffer;
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
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
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
    const db = await openDatabase();

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
        // e.g. InvalidStateError if the connection is closing.
        console.warn('[IFC Cache] Could not open write transaction; skipping cache write', err);
        done();
        return;
      }
      const store = tx.objectStore(STORE_NAME);

      const entry: CacheEntry = {
        key,
        buffer,
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
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.count(IDBKeyRange.only(key));

      request.onsuccess = () => {
        resolve(request.result > 0);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch {
    return false;
  }
}

/**
 * Delete a cache entry
 */
export async function deleteCached(key: string): Promise<void> {
  try {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
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
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
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
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const entries = request.result as CacheEntry[];
        resolve({
          entryCount: entries.length,
          totalSize: entries.reduce((sum, e) => sum + e.buffer.byteLength, 0),
          entries: entries.map((e) => ({
            fileName: e.fileName,
            fileSize: e.fileSize,
            createdAt: new Date(e.createdAt),
          })),
        });
      };

      request.onerror = () => reject(request.error);
    });
  } catch {
    return { entryCount: 0, totalSize: 0, entries: [] };
  }
}
