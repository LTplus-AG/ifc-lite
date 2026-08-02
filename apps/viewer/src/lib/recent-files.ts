/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Track recently opened model files via localStorage + IndexedDB.
 *
 * localStorage: metadata (name, size, timestamp) — for palette display.
 * IndexedDB:    actual file blobs — so recent files can be loaded instantly
 *               without the user re-selecting them from the file picker.
 *
 * Shared between MainToolbar (writes) and CommandPalette (reads).
 */

const KEY = 'ifc-lite:recent-files';
const DB_NAME = 'ifc-lite-file-cache';
// v2 adds a `timestamp` index so eviction can order records newest-first via a
// key cursor — without deserializing every blob ArrayBuffer (see cacheFileBlobs).
const DB_VERSION = 2;
const STORE_NAME = 'files';
const TIMESTAMP_INDEX = 'timestamp';
const MAX_CACHED_FILES = 5;
/** Max file size to cache (150 MB) — avoids filling IndexedDB quota */
const MAX_CACHE_SIZE = 150 * 1024 * 1024;

export interface RecentFileEntry {
  name: string;
  size: number;
  timestamp: number;
}

export type RecentFileInput = {
  name: string;
  size: number;
};

// ── localStorage (metadata) ─────────────────────────────────────────────

export function getRecentFiles(): RecentFileEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); }
  catch { return []; }
}

// Browser uploads don't expose filesystem paths, so the file name is the
// dedup key.
function recentKey(f: { name: string }): string {
  return `name:${f.name}`;
}

export function recordRecentFiles(files: RecentFileInput[]) {
  try {
    const incomingKeys = new Set(files.map(recentKey));
    const existing = getRecentFiles().filter(f => !incomingKeys.has(recentKey(f)));
    const entries: RecentFileEntry[] = files.map(f => ({
      name: f.name,
      size: f.size,
      timestamp: Date.now(),
    }));
    localStorage.setItem(KEY, JSON.stringify([...entries, ...existing].slice(0, 10)));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[recent-files] failed to persist recent files metadata', err);
  }
}

/** Format bytes into human-readable size */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── IndexedDB (file blob cache) ─────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // The versionchange transaction — needed to reach an existing store when
      // upgrading v1 → v2 (createObjectStore only runs on a fresh create).
      const tx = req.transaction;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? tx!.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      // Records have always carried a `timestamp`; the index just lets eviction
      // walk them ordered without reading the blobs.
      if (!store.indexNames.contains(TIMESTAMP_INDEX)) {
        store.createIndex(TIMESTAMP_INDEX, 'timestamp', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Cache file blobs in IndexedDB for instant reload from palette. */
export async function cacheFileBlobs(files: File[]): Promise<void> {
  try {
    // Only stage up to the cache capacity. The store keeps at most
    // MAX_CACHED_FILES entries, so reading every blob of a large multi-file drop
    // into memory just to evict most of them afterwards is wasteful — keep the
    // last-selected ones (the eviction below keeps newest by timestamp anyway).
    const eligible = files.filter((f) => f.size <= MAX_CACHE_SIZE).slice(-MAX_CACHED_FILES);

    // Read every blob FIRST. An IndexedDB transaction auto-commits as soon as
    // control returns to the event loop with no pending request, so awaiting
    // file.arrayBuffer() *inside* the transaction would inactivate it and make
    // the next store.put() throw TransactionInactiveError (silently caught →
    // nothing cached). Do all the async reads up front, then write in one
    // synchronous burst.
    const records: { name: string; blob: ArrayBuffer; size: number; type: string; timestamp: number }[] = [];
    for (const file of eligible) {
      records.push({
        name: file.name,
        blob: await file.arrayBuffer(),
        size: file.size,
        type: file.type,
        timestamp: Date.now(),
      });
    }
    if (records.length === 0) return;

    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    for (const record of records) {
      store.put(record);
    }

    // Evict old entries beyond MAX_CACHED_FILES. Walk the `timestamp` index
    // newest-first with a KEY cursor — it yields only the index key + primary
    // key, never the record value, so the ~1.5 GB of cached blob ArrayBuffers
    // are never deserialized just to sort by timestamp (the old getAll() did).
    const cursorReq = store.index(TIMESTAMP_INDEX).openKeyCursor(null, 'prev');
    let kept = 0;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      kept++;
      if (kept > MAX_CACHED_FILES) {
        store.delete(cursor.primaryKey);
      }
      cursor.continue();
    };

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[recent-files] failed to cache file blobs', err);
  }
}

/**
 * List the names of files currently in the blob cache (keys only, no blobs).
 * Cheap enough to call on every palette open so callers can decide cache
 * hit/miss synchronously, without an `await` that would drop the user
 * activation a file dialog needs.
 */
export async function getCachedFileNames(): Promise<string[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAllKeys();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return keys.map(String);
  } catch {
    return [];
  }
}

/** Retrieve a cached file blob and reconstruct a File object. */
export async function getCachedFile(target: string | RecentFileEntry): Promise<File | null> {
  const name = typeof target === 'string' ? target : target.name;
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(name);
    const result = await new Promise<{ name: string; blob: ArrayBuffer; size: number; type: string } | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!result) return null;
    return new File([result.blob], result.name, { type: result.type || 'application/octet-stream' });
  } catch {
    return null;
  }
}
