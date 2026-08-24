/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Isolated in its own file (own child process under the node test runner)
 * so the module-level `dbPromise` singleton in idb-storage.ts starts
 * genuinely unset — the recovery path only runs on the *first* open of a
 * corrupted database, and other test files opening the (real, healthy)
 * database first would mask it.
 */

// fake-indexeddb installs a Node-compatible IDB implementation on
// `globalThis.indexedDB` when imported via the `/auto` entry point.
import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IdbExtensionStorage } from './idb-storage.js';

// Mirrors the private DB_NAME/DB_VERSION constants in idb-storage.ts.
const DB_NAME = 'ifc-lite-extensions';
const DB_VERSION = 1;

describe('IdbExtensionStorage recovery', () => {
  it('recreates the database when an object store is unexpectedly missing', async () => {
    // Simulate corruption: pre-create the database at the module's own
    // name+version, but with only one of the two stores it expects. This
    // is the state the recovery branch in openDatabase() exists to detect.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('extensions', { keyPath: 'id' });
        // 'extension-bundles' intentionally omitted.
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });

    const storage = new IdbExtensionStorage();

    // Any operation opens the db and must trigger recovery rather than
    // silently operating against a database that's missing a store.
    const list = await storage.listExtensions();
    assert.deepStrictEqual(list, []);

    // The recreated database must actually have both stores usable —
    // not just "extensions" (the one that happened to already exist).
    await storage.putBundle('x', '1.0.0', new Uint8Array([1, 2, 3]));
    const bundle = await storage.getBundle('x', '1.0.0');
    assert.deepStrictEqual(bundle, new Uint8Array([1, 2, 3]));
  });
});
