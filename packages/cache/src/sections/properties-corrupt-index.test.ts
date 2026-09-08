/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `readProperties`'s entityIndex/psetIndex/propIndex map row-index arrays
 * (key -> indices into the parallel `entityId`/`psetName`/... column
 * arrays). Those columns are fixed-size `Uint32Array`s, so an out-of-range
 * row index doesn't throw — `arr[idx]` on a typed array silently answers
 * `undefined`. A corrupt cache whose index table names a row past the column
 * length therefore doesn't fail the cache load: it flows `undefined`
 * names/types into `getForEntity`'s result as if they were real properties.
 * Same defect shape as `entity-index.ts`'s `typeIndex` bounds check, which
 * already throws on the equivalent condition. `relationships.ts`'s edge
 * ranges still carry the same unguarded shape and are out of scope here.
 */

import { describe, it, expect } from 'vitest';
import type { PropertyTable } from '@ifc-lite/data';
import { PropertyValueType } from '@ifc-lite/data';
import { writeProperties, readProperties } from './properties.js';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

/** Minimal StringTable stub — only `get`/`count`/`indexOf` are used by readProperties. */
function makeStrings(strings: string[]) {
  return {
    get: (idx: number) => strings[idx] ?? '',
    count: strings.length,
    indexOf: (s: string) => strings.indexOf(s),
  } as unknown as import('@ifc-lite/data').StringTable;
}

/**
 * Build a PropertyTable-shaped object directly (bypassing
 * `propertyTableFromColumns`, which always derives `entityIndex` in-range
 * from `entityId`) so the on-disk index table can be corrupted the way a
 * damaged/truncated cache file would be, without hand-computing byte
 * offsets into the binary layout.
 */
function tableWithCorruptEntityIndex(): PropertyTable {
  return {
    count: 1,
    entityId: Uint32Array.from([100]),
    psetName: Uint32Array.from([1]),
    psetGlobalId: Uint32Array.from([0]),
    propName: Uint32Array.from([2]),
    propType: Uint8Array.from([PropertyValueType.Integer]),
    valueString: Uint32Array.from([0]),
    valueReal: new Float64Array([0]),
    valueInt: Int32Array.from([42]),
    valueBool: Uint8Array.from([255]),
    unitId: Int32Array.from([-1]),
    // Row 0 is the only row (count = 1), but the index claims row 5 —
    // exactly what a corrupt/truncated cache file would contain.
    entityIndex: new Map([[100, [1]]]),
    psetIndex: new Map([[1, [0]]]),
    propIndex: new Map([[2, [0]]]),
  } as unknown as PropertyTable;
}

describe('readProperties row-index bounds', () => {
  it('rejects an entityIndex row index that exceeds the row count (corrupt/truncated cache)', () => {
    const writer = new BufferWriter();
    writeProperties(writer, tableWithCorruptEntityIndex());
    const buffer = writer.build();
    const strings = makeStrings(['', 'Pset_Test', 'MyProp']);

    expect(() => readProperties(new BufferReader(buffer), strings)).toThrow(
      /Corrupt cache PropertyTable entityIndex: row index 1 for key 100 exceeds row count 1/,
    );
  });

  it('control: a well-formed table with in-range indices reads cleanly', () => {
    const table = tableWithCorruptEntityIndex();
    table.entityIndex.set(100, [0]); // in range this time
    const writer = new BufferWriter();
    writeProperties(writer, table);
    const buffer = writer.build();
    const strings = makeStrings(['', 'Pset_Test', 'MyProp']);

    const restored = readProperties(new BufferReader(buffer), strings);
    expect(restored.getForEntity(100)).toEqual([
      { name: 'Pset_Test', globalId: '', properties: [{ name: 'MyProp', type: PropertyValueType.Integer, value: 42 }] },
    ]);
  });
});
