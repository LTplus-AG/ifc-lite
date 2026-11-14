/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import { StringTable } from './string-table.js';

describe('StringTable', () => {
  it('should start with empty string at index 0', () => {
    const table = new StringTable();
    expect(table.count).toBe(1);
    expect(table.get(0)).toBe('');
  });

  it('should intern new strings and return indices', () => {
    const table = new StringTable();
    const idx1 = table.intern('hello');
    const idx2 = table.intern('world');

    expect(idx1).toBe(1);
    expect(idx2).toBe(2);
    expect(table.count).toBe(3);
  });

  it('should deduplicate identical strings', () => {
    const table = new StringTable();
    const idx1 = table.intern('hello');
    const idx2 = table.intern('hello');

    expect(idx1).toBe(idx2);
    expect(table.count).toBe(2); // Empty string + 'hello'
  });

  it('should return NULL_INDEX for null and undefined', () => {
    const table = new StringTable();

    expect(table.intern(null)).toBe(table.NULL_INDEX);
    expect(table.intern(undefined)).toBe(table.NULL_INDEX);
    expect(table.NULL_INDEX).toBe(-1);
  });

  it('should retrieve strings by index', () => {
    const table = new StringTable();
    table.intern('hello');
    table.intern('world');

    expect(table.get(1)).toBe('hello');
    expect(table.get(2)).toBe('world');
  });

  it('should return empty string for invalid indices', () => {
    const table = new StringTable();

    expect(table.get(-1)).toBe('');
    expect(table.get(999)).toBe('');
  });

  it('should check if string exists', () => {
    const table = new StringTable();
    table.intern('hello');

    expect(table.has('hello')).toBe(true);
    expect(table.has('nonexistent')).toBe(false);
  });

  it('should return indexOf for strings', () => {
    const table = new StringTable();
    table.intern('hello');

    expect(table.indexOf('hello')).toBe(1);
    expect(table.indexOf('nonexistent')).toBe(-1);
  });

  it('should return all strings via getAll', () => {
    const table = new StringTable();
    table.intern('hello');
    table.intern('world');

    const all = table.getAll();
    expect(all).toEqual(['', 'hello', 'world']);
  });

  describe('fromArray()', () => {
    it('rebuilds a table from a getAll() snapshot', () => {
      const original = new StringTable();
      original.intern('hello');
      original.intern('world');

      const rebuilt = StringTable.fromArray(original.getAll());
      expect(rebuilt.get(1)).toBe('hello');
      expect(rebuilt.get(2)).toBe('world');
      expect(rebuilt.indexOf('hello')).toBe(1);
      expect(rebuilt.indexOf('world')).toBe(2);
      expect(rebuilt.indexOf('missing')).toBe(-1);
      expect(rebuilt.count).toBe(3);
    });

    it('preserves the empty-string sentinel even when missing from the input', () => {
      const rebuilt = StringTable.fromArray(['hello', 'world']);
      expect(rebuilt.get(0)).toBe('');
      expect(rebuilt.indexOf('hello')).toBe(1);
    });

    it('continues to intern correctly after rebuild', () => {
      const rebuilt = StringTable.fromArray(['', 'hello']);
      expect(rebuilt.intern('hello')).toBe(1);
      expect(rebuilt.intern('new')).toBe(2);
      expect(rebuilt.count).toBe(3);
    });
  });
});

describe('StringTable.fromArray duplicate handling', () => {
  // The comment on fromArray promises "first occurrence wins" so a duplicate
  // (possible after manual concatenation of two tables) does not shadow the
  // canonical index. Nothing exercised it: every fixture was duplicate-free,
  // which makes last-wins and first-wins indistinguishable.
  it('keeps the FIRST index for a duplicated string', () => {
    const table = StringTable.fromArray(['', 'wall', 'slab', 'wall']);
    expect(table.indexOf('wall')).toBe(1);
    expect(table.get(1)).toBe('wall');
    expect(table.get(3)).toBe('wall'); // the duplicate slot survives verbatim
    expect(table.count).toBe(4);
  });

  it('does not re-append a duplicated string on intern', () => {
    const table = StringTable.fromArray(['', 'wall', 'slab', 'wall']);
    expect(table.intern('wall')).toBe(1);
    expect(table.count).toBe(4);
  });

  it('keeps index 0 pointing at the empty sentinel even if it repeats', () => {
    const table = StringTable.fromArray(['', 'wall', '']);
    expect(table.indexOf('')).toBe(0);
    expect(table.intern('')).toBe(0);
  });
});

// #8450: hydration and indexed reads must not hash every string on the main thread.
it('hydrates indexed data without per-string reverse-index writes (#8450)', () => {
  const source = ['', 'wall', 'slab', 'wall', ''];
  const set = vi.spyOn(Map.prototype, 'set');
  let writes: number;
  let table: StringTable;
  try {
    table = StringTable.fromArray(source);
    expect(table.get(3)).toBe('wall');
    writes = set.mock.calls.length;
  } finally {
    set.mockRestore();
  }
  expect(writes).toBeLessThanOrEqual(1); // the constructor's constant empty sentinel
  source[1] = 'changed outside the table';
  expect(table.get(1)).toBe('wall');
  expect(table.has('wall')).toBe(true);
  expect(table.has('changed outside the table')).toBe(false);
  expect(table.indexOf('wall')).toBe(1);
  expect(table.intern('wall')).toBe(1);
  expect(table.intern('new')).toBe(5);
  expect(table.getAll()).toEqual(['', 'wall', 'slab', 'wall', '', 'new']);
});
