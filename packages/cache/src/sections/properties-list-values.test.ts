/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cache rehydration of List-typed property values.
 *
 * `valueString` is a Uint32Array, so the NULL sentinel -1 wraps to
 * 4294967295 and `StringTable.get` answers `''`. The string branch of the
 * cache's `getPropertyValue` guards against that so a NULL stays `null`; the
 * List branch fed `''` straight into `JSON.parse` and swallowed the throw,
 * so a property with no list came back from cache as a real empty list.
 * Same defect and same fix as `@ifc-lite/data`'s property table.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StringTable, PropertyValueType, propertyTableFromColumns } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import {
  writeProperties,
  readProperties,
  __resetListParseWarningLatch,
} from './properties.js';

const NULL_STRING_SENTINEL = 0xffffffff; // -1 written into a Uint32Array

/**
 * Build a one-column-per-field table of List rows and round-trip it through
 * the cache section. Slot 0 of the string table must be the canonical empty
 * string (`fromArray` inserts one otherwise and shifts every index), so
 * payload strings start at index 1.
 */
function roundTripListRows(payloadStrings: string[], valueStringIndices: number[]) {
  const strings = StringTable.fromArray(['', ...payloadStrings]);
  const count = valueStringIndices.length;
  const table = propertyTableFromColumns(
    {
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
    },
    strings,
  );

  const writer = new BufferWriter();
  writeProperties(writer, table);
  return readProperties(new BufferReader(writer.build()), strings);
}

beforeEach(() => {
  __resetListParseWarningLatch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cached List property values', () => {
  it('round-trips a well-formed list', () => {
    const restored = roundTripListRows(['Pset_Test', 'Tags', '["a","b"]'], [3]);
    expect(restored.getPropertyValue(100, 'Pset_Test', 'Tags')).toEqual(['a', 'b']);
  });

  it('reports a NULL list as null, not as an empty list', () => {
    const restored = roundTripListRows(['Pset_Test', 'Tags'], [NULL_STRING_SENTINEL]);
    expect(restored.getPropertyValue(100, 'Pset_Test', 'Tags')).toBeNull();
  });

  it('warns once, with the error bound, when a cached list is not JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restored = roundTripListRows(['Pset_Test', 'Tags', '{not json'], [3, 3]);

    expect(restored.getPropertyValue(100, 'Pset_Test', 'Tags')).toEqual([]);
    expect(restored.getPropertyValue(101, 'Pset_Test', 'Tags')).toEqual([]);

    const calls = warn.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('not valid JSON'),
    );
    expect(calls, 'expected exactly one latched warning').toHaveLength(1);
    expect(calls[0][1]).toBeInstanceOf(Error);
  });
});
