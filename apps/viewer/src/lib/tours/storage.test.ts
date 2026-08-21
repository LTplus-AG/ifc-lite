/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { markTourCompleted, isTourCompleted } from './storage.js';

const STORAGE_KEY = 'ifc-lite:tours:v1';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
}

function installWindowShim(): { uninstall: () => void; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const g = globalThis as unknown as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  g.window = { localStorage: storage } as unknown;
  return {
    storage,
    uninstall: () => {
      if (had) g.window = prev;
      else delete g.window;
    },
  };
}

describe('tours storage — wrong-typed `tours` field', () => {
  it('does not throw when the stored `tours` field is not an object', () => {
    // Valid JSON, right top-level shape, but `tours` itself is a string —
    // the kind of thing a hand edit or a future format change could leave
    // behind. `read()`'s `parsed.tours ?? {}` only rescues null/undefined,
    // so a non-nullish wrong-typed value sails through unchanged and
    // `s.tours[id] = rec` in markTourCompleted then assigns a property on a
    // primitive string, which throws in strict mode.
    const shim = installWindowShim();
    try {
      shim.storage.setItem(STORAGE_KEY, JSON.stringify({ tours: 'corrupted' }));
      assert.doesNotThrow(() => markTourCompleted('welcome' as never, 1));
      assert.strictEqual(isTourCompleted('welcome' as never, 1), true);
    } finally {
      shim.uninstall();
    }
  });
});
