/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { loadSavedScripts, type SavedScript } from './persistence.js';

class MemoryStorage {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown };
const STORAGE_KEY = 'ifc-lite-scripts';

describe('loadSavedScripts — current-schema wrapper', () => {
  let ls: MemoryStorage;

  beforeEach(() => {
    ls = new MemoryStorage();
    g.localStorage = ls;
  });

  it('drops a malformed entry instead of returning it whole', () => {
    // A hand-edited or partially-migrated entry: valid JSON, right top-level
    // shape (schemaVersion + scripts array), but the script itself is `{}`.
    // The legacy (bare-array) branch below already discards this shape via
    // migrateFromLegacy; the versioned branch must not be the weaker path.
    ls.store.set(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, scripts: [{}] }));
    const scripts = loadSavedScripts();
    assert.deepStrictEqual(scripts, []);
  });

  it('keeps a well-formed script untouched', () => {
    const script: SavedScript = {
      id: 'a', name: 'Test', code: 'print(1)', createdAt: 1, updatedAt: 2, version: 1,
    };
    ls.store.set(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, scripts: [script] }));
    const scripts = loadSavedScripts();
    assert.deepStrictEqual(scripts, [script]);
  });

  it('drops only the malformed entry, keeping siblings', () => {
    const good: SavedScript = {
      id: 'b', name: 'Good', code: 'ok', createdAt: 1, updatedAt: 2, version: 1,
    };
    ls.store.set(STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      scripts: [good, { id: 'c' /* missing name/code/timestamps */ }],
    }));
    const scripts = loadSavedScripts();
    assert.deepStrictEqual(scripts, [good]);
  });
});
