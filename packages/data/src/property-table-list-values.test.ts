/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * List-typed property values: a NULL is not an empty list, and an
 * unparseable one is not silence.
 *
 * `valueString` is a Uint32Array, so the NULL sentinel -1 wraps to
 * 4294967295 and `StringTable.get` answers `''` for it. The string branch of
 * `getPropertyValue` already rejects out-of-range indices so a NULL stays
 * `null`; the List branch fed `''` straight into `JSON.parse`, whose throw
 * was swallowed and rendered as `[]`. A caller asking "does this element
 * declare a list?" was told "yes, and it's empty".
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { StringTable } from './string-table.js';
import { PropertyValueType } from './types.js';
import {
  propertyTableFromColumns,
  __resetListParseWarningLatch,
  type PropertyTableColumns,
} from './property-table.js';

const NULL_STRING_SENTINEL = 0xffffffff; // -1 written into a Uint32Array

/**
 * One row per string index supplied. `strings` seeds the table, so the
 * indices in `valueString` address real slots — a double that omitted the
 * string table would make every lookup fall out of range and pass for the
 * wrong reason. Slot 0 must be the canonical empty string (`fromArray`
 * inserts one otherwise and shifts every index), so callers pass 1-based
 * payload strings and the leading '' is added here.
 */
function tableWithListValues(payloadStrings: string[], valueStringIndices: number[]) {
  const strings = ['', ...payloadStrings];
  const count = valueStringIndices.length;
  const columns: PropertyTableColumns = {
    count,
    entityId: Uint32Array.from(valueStringIndices.map((_, i) => 100 + i)),
    psetName: new Uint32Array(count).fill(1),
    psetGlobalId: new Uint32Array(count).fill(0),
    propName: new Uint32Array(count).fill(2),
    propType: new Uint8Array(count).fill(PropertyValueType.List),
    valueString: Uint32Array.from(valueStringIndices),
    valueReal: new Float64Array(count),
    valueInt: new Int32Array(count),
    valueBool: new Uint8Array(count).fill(255),
    unitId: new Int32Array(count).fill(-1),
  };
  return propertyTableFromColumns(columns, StringTable.fromArray(strings));
}

beforeEach(() => {
  __resetListParseWarningLatch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getPropertyValue: List values', () => {
  it('parses a well-formed list', () => {
    // strings[0] = pset name, strings[1] = prop name, strings[2] = the value.
    const table = tableWithListValues(['Pset_Test', 'Tags', '["a","b"]'], [3]);
    expect(table.getPropertyValue(100, 'Pset_Test', 'Tags')).toEqual(['a', 'b']);
  });

  it('reports a NULL list as null, not as an empty list', () => {
    const table = tableWithListValues(['Pset_Test', 'Tags'], [NULL_STRING_SENTINEL]);
    expect(table.getPropertyValue(100, 'Pset_Test', 'Tags')).toBeNull();
  });

  it('reports an empty stored value as null, not as an empty list', () => {
    const table = tableWithListValues(['Pset_Test', 'Tags', ''], [3]);
    expect(table.getPropertyValue(100, 'Pset_Test', 'Tags')).toBeNull();
  });

  it('warns once, with the error bound, when a stored list is not JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Two corrupt rows: the latch must collapse them to a single warning.
    const table = tableWithListValues(['Pset_Test', 'Tags', '{not json'], [3, 3]);

    expect(table.getPropertyValue(100, 'Pset_Test', 'Tags')).toEqual([]);
    expect(table.getPropertyValue(101, 'Pset_Test', 'Tags')).toEqual([]);

    const calls = warn.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('not valid JSON'),
    );
    expect(calls, 'expected exactly one latched warning').toHaveLength(1);
    expect(calls[0][1]).toBeInstanceOf(Error);
  });
});
