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
const DB_VERSION = 1;
const STORE_NAME = 'files';
const MAX_CACHED_FILES = 5;
/** Max file size to cache (150 MB) — avoids filling IndexedDB quota */
const MAX_CACHE_SIZE = 150 * 1024 * 1024;

export interface RecentFileEntry {
  name: string;
  size: number;
  timestamp: number;
  /** Native filesystem path (Tauri only) — enables direct re-open from disk. */
  path?: string;
  /** Last-modified epoch in ms when known (Tauri stat). */
  modifiedMs?: number | null;
}

// Input shape for `recordRecentFiles` — accepts the optional native fields
// so callers can persist a path / modifiedMs without lying about the type.
export type RecentFileInput = {
  name: string;
  size: number;
  path?: string;
  modifiedMs?: number | null;
};

// ── localStorage (metadata) ─────────────────────────────────────────────

export function getRecentFiles(): RecentFileEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); }
  catch { return []; }
}

// Path-aware dedup key: when a native filesystem path is available it
// uniquely identifies the file (so `A/model.ifc` and `B/model.ifc` are
// kept separate); otherwise fall back to the name (browser uploads
// don't expose paths).
function recentKey(f: { name: string; path?: string }): string {
  return f.path ? `path:${f.path}` : `name:${f.name}`;
}

export function recordRecentFiles(files: RecentFileInput[]) {
  try {
    const incomingKeys = new Set(files.map(recentKey));
    const existing = getRecentFiles().filter(f => !incomingKeys.has(recentKey(f)));
    const entries: RecentFileEntry[] = files.map(f => ({
      name: f.name,
      size: f.size,
      timestamp: Date.now(),
      path: f.path,
      modifiedMs: f.modifiedMs ?? null,
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
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Cache file blobs in IndexedDB for instant reload from palette. */
export async function cacheFileBlobs(files: File[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    for (const file of files) {
      if (file.size > MAX_CACHE_SIZE) continue; // skip oversized files
      const blob = await file.arrayBuffer();
      store.put({ name: file.name, blob, size: file.size, type: file.type, timestamp: Date.now() });
    }

    // Evict old entries beyond MAX_CACHED_FILES
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const all = allReq.result as { name: string; timestamp: number }[];
      if (all.length > MAX_CACHED_FILES) {
        all.sort((a, b) => b.timestamp - a.timestamp);
        for (let i = MAX_CACHED_FILES; i < all.length; i++) {
          store.delete(all[i].name);
        }
      }
    };

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* IndexedDB unavailable — degrade gracefully */ }
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
