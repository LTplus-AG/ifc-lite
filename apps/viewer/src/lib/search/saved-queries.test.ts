/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  loadSavedQueries,
  saveQuery,
  updateSavedQuery,
  deleteSavedQuery,
  clearSavedQueries,
  __internal,
} from './saved-queries.js';

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

describe('saved-queries', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
  });

  it('starts empty', () => {
    assert.deepStrictEqual(loadSavedQueries(), []);
  });

  it('saves a query and round-trips through load', () => {
    saveQuery('Walls only', 'SELECT * FROM walls');
    const list = loadSavedQueries();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'Walls only');
    assert.strictEqual(list[0].sql, 'SELECT * FROM walls');
    assert.ok(list[0].id.length > 0);
    assert.ok(typeof list[0].createdAt === 'number');
  });

  it('places newest entries at the top', () => {
    saveQuery('First', 'SELECT 1');
    saveQuery('Second', 'SELECT 2');
    const list = loadSavedQueries();
    assert.strictEqual(list[0].name, 'Second');
    assert.strictEqual(list[1].name, 'First');
  });

  it('rejects empty / whitespace-only names and sql', () => {
    saveQuery('', 'SELECT 1');
    saveQuery('Name only', '   ');
    assert.deepStrictEqual(loadSavedQueries(), []);
  });

  it('rejects oversized name and sql', () => {
    const longName = 'x'.repeat(__internal.MAX_NAME_LEN + 1);
    const longSql = 'x'.repeat(__internal.MAX_SQL_LEN + 1);
    saveQuery(longName, 'SELECT 1');
    saveQuery('ok', longSql);
    assert.deepStrictEqual(loadSavedQueries(), []);
  });

  it('caps the saved list at MAX_ENTRIES', () => {
    for (let i = 0; i < __internal.MAX_ENTRIES + 5; i++) {
      saveQuery(`q-${i}`, `SELECT ${i}`);
    }
    assert.strictEqual(loadSavedQueries().length, __internal.MAX_ENTRIES);
  });

  it('updateSavedQuery patches name + sql and bumps updatedAt to the front', () => {
    saveQuery('First', 'SELECT 1');
    saveQuery('Second', 'SELECT 2');
    const [secondBefore, firstBefore] = loadSavedQueries();
    updateSavedQuery(firstBefore.id, { name: 'First (v2)' });
    const list = loadSavedQueries();
    assert.strictEqual(list[0].id, firstBefore.id, 'edited entry moves to top');
    assert.strictEqual(list[0].name, 'First (v2)');
    assert.strictEqual(list[1].id, secondBefore.id);
  });

  it('updateSavedQuery is a no-op when name or sql is empty / oversized', () => {
    saveQuery('Name', 'SELECT 1');
    const [original] = loadSavedQueries();
    updateSavedQuery(original.id, { name: '   ' });
    assert.strictEqual(loadSavedQueries()[0].name, 'Name');
    updateSavedQuery(original.id, { sql: '' });
    assert.strictEqual(loadSavedQueries()[0].sql, 'SELECT 1');
  });

  it('deleteSavedQuery removes by id', () => {
    saveQuery('A', 'SELECT 1');
    saveQuery('B', 'SELECT 2');
    const list = loadSavedQueries();
    deleteSavedQuery(list[0].id);
    const after = loadSavedQueries();
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].name, 'A');
  });

  it('deleteSavedQuery on a missing id is a no-op', () => {
    saveQuery('A', 'SELECT 1');
    const before = loadSavedQueries();
    deleteSavedQuery('does-not-exist');
    assert.deepStrictEqual(loadSavedQueries(), before);
  });

  it('clearSavedQueries wipes the list', () => {
    saveQuery('A', 'SELECT 1');
    saveQuery('B', 'SELECT 2');
    clearSavedQueries();
    assert.deepStrictEqual(loadSavedQueries(), []);
  });

  it('drops malformed payloads on load and writes succeed afterwards', () => {
    (g.localStorage as MemoryStorageLike).setItem(__internal.STORAGE_KEY, '{not-json');
    assert.deepStrictEqual(loadSavedQueries(), []);
    saveQuery('A', 'SELECT 1');
    assert.strictEqual(loadSavedQueries().length, 1);
  });

  it('drops non-array payloads on load', () => {
    (g.localStorage as MemoryStorageLike).setItem(__internal.STORAGE_KEY, '{"not":"an-array"}');
    assert.deepStrictEqual(loadSavedQueries(), []);
  });

  it('drops invalid entries within an array payload', () => {
    const mixed = [
      { id: 'ok', name: 'fine', sql: 'SELECT 1', createdAt: 1, updatedAt: 1 },
      { id: 'broken' }, // missing fields
      { id: 'also', name: 'still ok', sql: 'SELECT 2', createdAt: 1, updatedAt: 1 },
    ];
    (g.localStorage as MemoryStorageLike).setItem(__internal.STORAGE_KEY, JSON.stringify(mixed));
    const list = loadSavedQueries();
    assert.strictEqual(list.length, 2);
    assert.deepStrictEqual(list.map((q) => q.id).sort(), ['also', 'ok']);
  });

  it('returns an empty list when localStorage is unavailable', () => {
    delete g.localStorage;
    assert.deepStrictEqual(loadSavedQueries(), []);
    saveQuery('A', 'SELECT 1');
    assert.deepStrictEqual(loadSavedQueries(), []);
  });
});
