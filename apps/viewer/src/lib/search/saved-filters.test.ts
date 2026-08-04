/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  loadSavedFilters,
  saveFilter,
  deleteSavedFilter,
  clearSavedFilters,
  __internal,
} from './saved-filters.js';
import { Rule } from './filter-rules.js';

interface MemoryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MemoryStorage implements MemoryStorageLike {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown };

describe('saved-filters', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
  });

  it('returns an empty list when nothing is stored', () => {
    assert.deepStrictEqual(loadSavedFilters(), []);
  });

  it('saves a preset and reads it back sorted by name', () => {
    saveFilter('Bravo', 'AND', [Rule.ifcType(['IfcWall'])]);
    saveFilter('Alpha', 'OR', [Rule.name('contains', 'EXT')]);
    const list = loadSavedFilters();
    assert.deepStrictEqual(list.map((p) => p.name), ['Alpha', 'Bravo']);
    assert.strictEqual(list[0].combinator, 'OR');
    assert.strictEqual(list[1].combinator, 'AND');
  });

  it('overwrites an existing preset by case-insensitive name match', () => {
    saveFilter('External Walls', 'AND', [Rule.ifcType(['IfcWall'])]);
    saveFilter('external walls', 'OR', [Rule.ifcType(['IfcDoor'])]);
    const list = loadSavedFilters();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].combinator, 'OR');
    assert.strictEqual(list[0].name, 'external walls');
  });

  it('drops empty / whitespace / over-length names', () => {
    saveFilter('', 'AND', []);
    saveFilter('   ', 'AND', []);
    saveFilter('x'.repeat(__internal.MAX_NAME_LEN + 1), 'AND', []);
    assert.deepStrictEqual(loadSavedFilters(), []);
  });

  it('takes a defensive copy of the rules array', () => {
    const rules = [Rule.ifcType(['IfcWall'])];
    saveFilter('Walls', 'AND', rules);
    rules[0] = Rule.ifcType(['IfcDoor']);
    const loaded = loadSavedFilters()[0];
    // The mutation to the caller's array must not leak into storage.
    const r = loaded.rules[0];
    assert.strictEqual(r.kind, 'ifcType');
    if (r.kind === 'ifcType') {
      assert.deepStrictEqual(r.values, ['IfcWall']);
    }
  });

  it('deleteSavedFilter removes the named preset', () => {
    saveFilter('Walls', 'AND', [Rule.ifcType(['IfcWall'])]);
    saveFilter('Doors', 'AND', [Rule.ifcType(['IfcDoor'])]);
    deleteSavedFilter('walls');
    const list = loadSavedFilters();
    assert.deepStrictEqual(list.map((p) => p.name), ['Doors']);
  });

  it('deleteSavedFilter is a no-op for unknown names', () => {
    saveFilter('Walls', 'AND', [Rule.ifcType(['IfcWall'])]);
    deleteSavedFilter('Nope');
    assert.strictEqual(loadSavedFilters().length, 1);
  });

  it('clearSavedFilters wipes the catalog', () => {
    saveFilter('Walls', 'AND', [Rule.ifcType(['IfcWall'])]);
    clearSavedFilters();
    assert.deepStrictEqual(loadSavedFilters(), []);
  });

  it('drops malformed payloads in storage', () => {
    (g.localStorage as MemoryStorage).setItem(__internal.STORAGE_KEY, '{not-json');
    assert.deepStrictEqual(loadSavedFilters(), []);
  });

  it('rejects entries with unknown rule kinds while preserving valid ones', () => {
    (g.localStorage as MemoryStorage).setItem(
      __internal.STORAGE_KEY,
      JSON.stringify([
        { name: 'Mixed', combinator: 'AND', rules: [
          { kind: 'ifcType', values: ['IfcWall'], op: 'in' },
          { kind: 'unknown' },
        ], updatedAt: 1 },
      ]),
    );
    const list = loadSavedFilters();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].rules.length, 1, 'invalid rule was filtered');
    assert.strictEqual(list[0].rules[0].kind, 'ifcType');
  });
});

/** Same as `MemoryStorage`, but the backing map is readable by the assertions. */
class InspectableStorage implements MemoryStorageLike {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

/** Truncated JSON — the shape an externally mangled entry has. */
const CORRUPT = '[{"name":"Ground floor walls","combinator":"AND","rules":[{"kind":"ifcTy';

describe('saved-filters: an unreadable catalog is never deleted', () => {
  let ls: InspectableStorage;
  beforeEach(() => {
    ls = new InspectableStorage();
    g.localStorage = ls;
    loadSavedFilters(); // clean read clears the module-level "unwritable" flag
  });

  const survives = () => [...ls.store.values()].includes(CORRUPT);

  it('does not delete the stored catalog when it fails to parse', () => {
    ls.setItem(__internal.STORAGE_KEY, CORRUPT);
    assert.deepStrictEqual(loadSavedFilters(), []);
    assert.ok(survives(), 'the unreadable catalog was deleted by the read');
  });

  it('does not overwrite the stored catalog with the save that follows', () => {
    ls.setItem(__internal.STORAGE_KEY, CORRUPT);
    loadSavedFilters();
    saveFilter('New preset', 'AND', [Rule.ifcType(['IfcSlab'])]);
    assert.ok(survives(), 'the unreadable catalog was destroyed by the save');
  });

  // ── Negative cases ─────────────────────────────────────────────────────────

  it('keeps saving after an unreadable read — the toolbar stays usable', () => {
    ls.setItem(__internal.STORAGE_KEY, CORRUPT);
    loadSavedFilters();

    saveFilter('New preset', 'AND', [Rule.ifcType(['IfcSlab'])]);
    assert.deepStrictEqual(loadSavedFilters().map((p) => p.name), ['New preset']);

    // A user-initiated delete still deletes.
    deleteSavedFilter('New preset');
    assert.deepStrictEqual(loadSavedFilters(), []);
    assert.ok(survives(), 'the preserved copy should outlive an unrelated delete');
  });

  it('clearSavedFilters still wipes everything, preserved copy included', () => {
    ls.setItem(__internal.STORAGE_KEY, CORRUPT);
    loadSavedFilters();
    saveFilter('New preset', 'AND', [Rule.ifcType(['IfcSlab'])]);
    clearSavedFilters();
    assert.deepStrictEqual(loadSavedFilters(), []);
    assert.strictEqual(ls.store.size, 0, 'an explicit wipe leaves nothing behind');
  });

  it('refuses to write when the unreadable catalog could not even be backed up', () => {
    // Quota is exhausted for the backup write specifically. `safeStorage`
    // probes storage first, so rejecting every write here would make the test
    // vacuous — it would pass because the module saw no storage at all.
    const full = new (class extends InspectableStorage {
      override setItem(key: string, value: string): void {
        if (key.startsWith(`${__internal.STORAGE_KEY}:unreadable`)) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        super.setItem(key, value);
      }
    })();
    full.setItem(__internal.STORAGE_KEY, CORRUPT);
    g.localStorage = full;

    loadSavedFilters();
    saveFilter('New preset', 'AND', [Rule.ifcType(['IfcSlab'])]);
    assert.strictEqual(full.getItem(__internal.STORAGE_KEY), CORRUPT);
  });
});
