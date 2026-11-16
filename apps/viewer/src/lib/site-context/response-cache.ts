/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The geodata client's response cache (`ResponseCache` from
 * `@ifc-lite/geodata-ch`, keyed by URL plus `Range`), kept in IndexedDB with a
 * least-recently-used size cap. Loading the same site again, or a neighbouring
 * one that shares terrain tiles, then costs no swisstopo requests; offline, a
 * cached site still loads and only what is missing becomes an issue.
 *
 * Two object stores: `bodies` holds the responses, `entries` only each key's
 * size and last use, so eviction walks a small index instead of reading
 * megabytes of tile bytes. Every failure is contained: a browser without
 * IndexedDB (private window, blocked storage) gets a cache that never hits,
 * never one that breaks the load.
 */

import type { CachedResponse, ResponseCache } from '@ifc-lite/geodata-ch';

export const SITE_CONTEXT_CACHE_DB = 'ifc-lite-site-context-cache';
/** About 300 MB: a few sites' terrain tiles and imagery. */
export const SITE_CONTEXT_CACHE_MAX_BYTES = 300 * 1024 * 1024;

interface EntryMeta { key: string; size: number; lastUsed: number }

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  const open = factory.open(SITE_CONTEXT_CACHE_DB, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('bodies')) db.createObjectStore('bodies');
    if (!db.objectStoreNames.contains('entries')) {
      db.createObjectStore('entries', { keyPath: 'key' }).createIndex('lastUsed', 'lastUsed');
    }
  };
  return request(open);
}

export interface SiteContextResponseCache extends ResponseCache {
  /** Cache hits served so far. */
  readonly hits: number;
}

/**
 * An IndexedDB-backed LRU cache. `factory` defaults to the global
 * `indexedDB`; `now` is injectable so eviction order is testable.
 */
export function createSiteContextResponseCache(options: {
  factory?: IDBFactory | null;
  maxBytes?: number;
  now?: () => number;
} = {}): SiteContextResponseCache {
  const factory = options.factory === undefined ? (globalThis.indexedDB ?? null) : options.factory;
  const maxBytes = options.maxBytes ?? SITE_CONTEXT_CACHE_MAX_BYTES;
  const now = options.now ?? Date.now;
  let hits = 0;
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  const db = (): Promise<IDBDatabase | null> => {
    dbPromise ??= factory
      ? openDb(factory).catch((error: unknown) => {
        console.warn('[site-context] response cache unavailable; requests go uncached:', error);
        return null;
      })
      : Promise.resolve(null);
    return dbPromise;
  };

  async function evict(handle: IDBDatabase): Promise<void> {
    const tx = handle.transaction(['entries', 'bodies'], 'readwrite');
    const entries = tx.objectStore('entries');
    const all = await request(entries.getAll()) as EntryMeta[];
    let total = all.reduce((sum, entry) => sum + entry.size, 0);
    if (total > maxBytes) {
      for (const entry of all.sort((a, b) => a.lastUsed - b.lastUsed)) {
        if (total <= maxBytes) break;
        entries.delete(entry.key);
        tx.objectStore('bodies').delete(entry.key);
        total -= entry.size;
      }
    }
    await done(tx);
  }

  return {
    get hits() { return hits; },
    async get(key: string): Promise<CachedResponse | undefined> {
      const handle = await db();
      if (!handle) return undefined;
      try {
        const tx = handle.transaction(['bodies', 'entries'], 'readwrite');
        const value = await request(tx.objectStore('bodies').get(key)) as CachedResponse | undefined;
        if (value) {
          tx.objectStore('entries').put({ key, size: value.body.byteLength, lastUsed: now() } satisfies EntryMeta);
          hits += 1;
        }
        await done(tx);
        return value;
      } catch (error) {
        console.warn('[site-context] response cache read failed:', error);
        return undefined;
      }
    },
    async set(key: string, value: CachedResponse): Promise<void> {
      const handle = await db();
      if (!handle || value.body.byteLength > maxBytes) return;
      try {
        const tx = handle.transaction(['bodies', 'entries'], 'readwrite');
        tx.objectStore('bodies').put(value, key);
        tx.objectStore('entries').put({ key, size: value.body.byteLength, lastUsed: now() } satisfies EntryMeta);
        await done(tx);
        await evict(handle);
      } catch (error) {
        console.warn('[site-context] response cache write failed:', error);
      }
    },
  };
}

/**
 * The same store seen through the 3D Tiles reader's cache contract
 * (`TilesCache` of `@ifc-lite/tiles3d`: raw bytes per URL). Keys get a
 * `tiles:` prefix so they can never collide with the geodata client's
 * URL-plus-Range keys; eviction and the size cap are shared.
 */
export function tilesCacheView(cache: SiteContextResponseCache): {
  get(url: string): Promise<Uint8Array | undefined>;
  set(url: string, bytes: Uint8Array): Promise<void>;
} {
  return {
    async get(url) {
      const hit = await cache.get(`tiles:${url}`);
      return hit ? new Uint8Array(hit.body) : undefined;
    },
    async set(url, bytes) {
      const body = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
        ? bytes.buffer : bytes.slice().buffer;
      await cache.set(`tiles:${url}`, { status: 200, headers: {}, body });
    },
  };
}
