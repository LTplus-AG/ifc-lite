/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
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
