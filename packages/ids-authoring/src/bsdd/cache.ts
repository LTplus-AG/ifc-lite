/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Offline cache for bSDD (05-bsdd.md §4, IDS-074). `createCachedBsddSource`
 * wraps any `BsddSource` with a read-through cache over a persistent
 * `BsddCacheStore` (IndexedDB in the browser, `createIndexedDbBsddStore`;
 * memory in tests and on the CLI): search results, class details,
 * dictionaries and URI records. When bSDD cannot be reached, a cached entry
 * is served even past its freshness, so known classes stay usable offline;
 * an uncached request fails with `BsddUnavailableError`.
 */

import { isRecord } from './contract.js';
import { BsddHttpError, BsddUnavailableError, type BsddSource, type BsddUriRecord } from './types.js';
import { createBsddUriIndex, type BsddUriIndex } from './uri-health.js';

export const BSDD_CACHE_VERSION = 1;

export type BsddCacheKind = 'dictionaries' | 'dictionary' | 'classes' | 'search' | 'class' | 'uri';

export interface BsddCacheEntry {
  v: number;
  kind: BsddCacheKind;
  /** Epoch milliseconds. */
  storedAt: number;
  value: unknown;
}

/** Persistent key/value storage for the cache. */
export interface BsddCacheStore {
  /** The stored value, unchecked (`undefined` when absent). */
  get(key: string): Promise<unknown>;
  put(key: string, entry: BsddCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys starting with `prefix`. */
  keys(prefix: string): Promise<string[]>;
}

export function createMemoryBsddStore(): BsddCacheStore {
  const map = new Map<string, BsddCacheEntry>();
  return {
    get: async (key) => map.get(key),
    put: async (key, entry) => void map.set(key, entry),
    delete: async (key) => void map.delete(key),
    keys: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

export interface CachedBsddSourceOptions {
  store: BsddCacheStore;
  /** How long an entry is served without asking bSDD. Default 24 h. */
  ttlMs?: number;
  now?: () => number;
}

export interface CachedBsddSource extends BsddSource {
  /** True when the last request was answered from the cache because bSDD was unreachable. */
  readonly offline: boolean;
}

/** A failure that says "bSDD is not reachable right now", as opposed to a definitive answer. */
export function isTransportFailure(err: unknown): boolean {
  if (err instanceof BsddHttpError) return err.status === 429 || err.status >= 500;
  return err instanceof TypeError || (err instanceof Error && err.name === 'AbortError');
}

function isCacheEntry(v: unknown): v is BsddCacheEntry {
  return isRecord(v) && v.v === BSDD_CACHE_VERSION && typeof v.kind === 'string' && typeof v.storedAt === 'number' && 'value' in v;
}

function isUriRecord(v: unknown): v is BsddUriRecord {
  return isRecord(v) && typeof v.uri === 'string' && typeof v.state === 'string' && typeof v.checkedAt === 'number';
}

/** Shape checks for what the cache gives back: an entry from an older build or a damaged store is a miss, not a crash. */
const VALID: Record<BsddCacheKind, (v: unknown) => boolean> = {
  dictionaries: (v) => Array.isArray(v) && v.every((d) => isRecord(d) && typeof d.uri === 'string'),
  dictionary: (v) => v === null || (isRecord(v) && typeof v.uri === 'string' && typeof v.name === 'string'),
  classes: (v) => Array.isArray(v) && v.every((c) => isRecord(c) && typeof c.uri === 'string' && typeof c.code === 'string'),
  search: (v) => isRecord(v) && Array.isArray(v.classes) && typeof v.total === 'number',
  class: (v) => v === null || (isRecord(v) && typeof v.uri === 'string' && Array.isArray(v.properties) && Array.isArray(v.relatedIfcEntityNames)),
  uri: isUriRecord,
};

export function createCachedBsddSource(source: BsddSource, options: CachedBsddSourceOptions): CachedBsddSource {
  const { store } = options;
  const ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now;
  let offline = false;

  async function read(key: string, kind: BsddCacheKind): Promise<BsddCacheEntry | undefined> {
    try {
      const hit = await store.get(key);
      return isCacheEntry(hit) && hit.kind === kind && VALID[kind](hit.value) ? hit : undefined;
    } catch (err) {
      // A broken store degrades to "not cached"; the network answer still flows.
      console.warn('[bsdd-cache] read failed', key, err);
      return undefined;
    }
  }

  async function write(key: string, kind: BsddCacheKind, value: unknown): Promise<void> {
    try {
      await store.put(key, { v: BSDD_CACHE_VERSION, kind, storedAt: now(), value });
    } catch (err) {
      console.warn('[bsdd-cache] write failed', key, err);
    }
  }

  /** Read through the cache. `T` is what `fetcher` returns; the cached copy passed the shape check of `kind`. */
  async function through<T>(kind: BsddCacheKind, key: string, fetcher: () => Promise<T>): Promise<T> {
    const hit = await read(key, kind);
    if (hit && now() - hit.storedAt < ttl) {
      offline = false;
      return hit.value as T;
    }
    try {
      const value = await fetcher();
      offline = false;
      await write(key, kind, value);
      return value;
    } catch (err) {
      if (!isTransportFailure(err)) throw err;
      if (hit) {
        offline = true;
        return hit.value as T;
      }
      throw new BsddUnavailableError(key, { cause: err });
    }
  }

  return {
    get offline() {
      return offline;
    },
    listDictionaries: () => through('dictionaries', 'dictionaries', () => source.listDictionaries()),
    getDictionary: (uri) => through('dictionary', `dictionary:${uri}`, () => source.getDictionary(uri)),
    listClasses: (uri) => through('classes', `classes:${uri}`, () => source.listClasses(uri)),
    searchClasses: (q) =>
      through('search', `search:${JSON.stringify([q.text.trim().toLowerCase(), [...(q.dictionaryUris ?? [])].sort(), q.relatedIfcEntity ?? '', q.languageCode ?? '', q.offset ?? 0, q.limit ?? 50])}`, () =>
        source.searchClasses(q),
      ),
    getClass: (uri, opts) => through('class', `class:${opts?.languageCode ?? ''}:${uri}`, () => source.getClass(uri, opts)),
    resolveUri: (uri) => through('uri', `uri:${uri}`, () => source.resolveUri(uri)),
  };
}

/** A URI index holding every URI record in the store (e.g. the last session's URI health). */
export async function loadUriIndex(store: BsddCacheStore): Promise<BsddUriIndex> {
  const records: BsddUriRecord[] = [];
  for (const key of await store.keys('uri:')) {
    const entry = await store.get(key);
    if (isCacheEntry(entry) && isUriRecord(entry.value)) records.push(entry.value);
  }
  return createBsddUriIndex(records);
}
