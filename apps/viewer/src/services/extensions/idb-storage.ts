/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IndexedDB-backed implementation of @ifc-lite/extensions' `ExtensionStorage`
 * interface.
 *
 * Two object stores:
 *   - `extensions`         keyed by extension id           → InstalledExtensionRecord
 *   - `extension-bundles`  keyed by `<id>@<version>` tuple → Uint8Array
 *
 * On startup, we open the database, verify both stores exist, and recreate
 * the database from scratch if anything is missing (mirrors the recovery
 * pattern used by `services/ifc-cache.ts`).
 */

import type {
  ExtensionStorage,
  InstalledExtensionRecord,
} from '@ifc-lite/extensions';

const DB_NAME = 'ifc-lite-extensions';
const DB_VERSION = 1;
const STORE_EXT = 'extensions';
const STORE_BUNDLES = 'extension-bundles';

let dbPromise: Promise<IDBDatabase> | null = null;

export class IdbExtensionStorage implements ExtensionStorage {
  async putExtension(record: InstalledExtensionRecord): Promise<void> {
    const db = await openDatabase();
    await runStore(db, STORE_EXT, 'readwrite', (store) => store.put(record));
  }

  async getExtension(id: string): Promise<InstalledExtensionRecord | undefined> {
    const db = await openDatabase();
    return runStore(db, STORE_EXT, 'readonly', (store) => store.get(id))
      .then((v) => (v ? (v as InstalledExtensionRecord) : undefined));
  }

  async listExtensions(): Promise<InstalledExtensionRecord[]> {
    const db = await openDatabase();
    return runStore<InstalledExtensionRecord[]>(db, STORE_EXT, 'readonly', (store) => store.getAll());
  }

  async deleteExtension(id: string): Promise<void> {
    const db = await openDatabase();
    await runStore(db, STORE_EXT, 'readwrite', (store) => store.delete(id));
    // Cascade: drop bundles for this extension.
    await runStore(db, STORE_BUNDLES, 'readwrite', (store) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if (key.startsWith(`${id}@`)) cursor.delete();
        cursor.continue();
      };
      return req;
    });
  }

  async putBundle(id: string, version: string, bytes: Uint8Array): Promise<void> {
    const db = await openDatabase();
    await runStore(db, STORE_BUNDLES, 'readwrite', (store) =>
      store.put(new Uint8Array(bytes), bundleKey(id, version)),
    );
  }

  async getBundle(id: string, version: string): Promise<Uint8Array | undefined> {
    const db = await openDatabase();
    const value = await runStore<Uint8Array | undefined>(
      db,
      STORE_BUNDLES,
      'readonly',
      (store) => store.get(bundleKey(id, version)),
    );
    return value ? new Uint8Array(value) : undefined;
  }

  async deleteBundle(id: string, version: string): Promise<void> {
    const db = await openDatabase();
    await runStore(db, STORE_BUNDLES, 'readwrite', (store) =>
      store.delete(bundleKey(id, version)),
    );
  }

  async clear(): Promise<void> {
    const db = await openDatabase();
    await runStore(db, STORE_EXT, 'readwrite', (store) => store.clear());
    await runStore(db, STORE_BUNDLES, 'readwrite', (store) => store.clear());
  }
}

function bundleKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      console.error('[extensions/idb] Failed to open database:', request.error);
      dbPromise = null;
      reject(request.error);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_EXT)) {
        db.createObjectStore(STORE_EXT, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BUNDLES)) {
        db.createObjectStore(STORE_BUNDLES);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_EXT) || !db.objectStoreNames.contains(STORE_BUNDLES)) {
        // Recovery: delete and recreate.
        db.close();
        dbPromise = null;
        const del = indexedDB.deleteDatabase(DB_NAME);
        del.onsuccess = () => openDatabase().then(resolve).catch(reject);
        del.onerror = () => reject(new Error('Failed to recreate extensions database.'));
        return;
      }
      resolve(db);
    };
  });
  return dbPromise;
}

function runStore<T = unknown>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let value: unknown;
    const req = fn(store);
    if (req instanceof IDBRequest) {
      req.onsuccess = () => {
        value = req.result;
      };
      req.onerror = () => reject(req.error);
    }
    tx.oncomplete = () => resolve(value as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
