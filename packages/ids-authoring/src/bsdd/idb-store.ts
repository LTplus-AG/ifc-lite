/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IndexedDB `BsddCacheStore` (IDS-074): the browser's persistent bSDD cache,
 * so pickers keep working offline for classes seen before. Framework-free;
 * the factory is injectable (tests pass `fake-indexeddb`).
 */

import type { BsddCacheStore } from './cache.js';

export const BSDD_IDB_NAME = 'ifc-lite-bsdd';
const STORE = 'entries';

export interface IndexedDbBsddStoreOptions {
  /** Default: `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  /** Default: `globalThis.IDBKeyRange` (used for prefix scans when present). */
  keyRange?: typeof IDBKeyRange;
  dbName?: string;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function createIndexedDbBsddStore(options: IndexedDbBsddStoreOptions = {}): BsddCacheStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const keyRange = options.keyRange ?? globalThis.IDBKeyRange;
  if (!factory) throw new Error('IndexedDB is not available here; use createMemoryBsddStore()');
  let db: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    db ??= new Promise((resolve, reject) => {
      const req = factory.open(options.dbName ?? BSDD_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('cannot open the bSDD cache database'));
    });
    return db;
  }

  async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const tx = (await open()).transaction(STORE, mode);
    const result = done(body(tx.objectStore(STORE)));
    await settled(tx);
    return result;
  }

  return {
    // Whatever is stored comes back as `unknown`: the cache checks version, kind and shape before use.
    get: (key) => run('readonly', (s): IDBRequest<unknown> => s.get(key)),
    async put(key, entry) {
      await run('readwrite', (s) => s.put(entry, key));
    },
    async delete(key) {
      await run('readwrite', (s) => s.delete(key));
    },
    async keys(prefix) {
      const all = await run('readonly', (s) => s.getAllKeys(keyRange ? keyRange.bound(prefix, `${prefix}￿`) : undefined));
      return all.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
    },
  };
}
