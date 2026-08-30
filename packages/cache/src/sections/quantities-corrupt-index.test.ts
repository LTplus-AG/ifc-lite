/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Same defect shape as `properties-corrupt-index.test.ts`: `readQuantities`'s
 * entityIndex/qsetIndex/quantityIndex map row indices into the parallel
 * `entityId`/`qsetName`/`value`/... column arrays, which are fixed-size
 * typed arrays. `arr[idx]` on a typed array silently answers `undefined`
 * for an out-of-range `idx` instead of throwing, so a corrupt/truncated
 * cache whose index table names a row past the column length doesn't fail
 * the cache load — it flows `undefined` names and `NaN`/`undefined` values
 * into `getForEntity`'s result as if they were real quantities.
 */

import { describe, it, expect } from 'vitest';
import type { QuantityTable } from '@ifc-lite/data';
import { QuantityType } from '@ifc-lite/data';
import { writeQuantities, readQuantities } from './quantities.js';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

/** Minimal StringTable stub — only `get`/`count`/`indexOf` are used by readQuantities. */
function makeStrings(strings: string[]) {
  return {
    get: (idx: number) => strings[idx] ?? '',
    count: strings.length,
    indexOf: (s: string) => strings.indexOf(s),
  } as unknown as import('@ifc-lite/data').StringTable;
}

/**
 * Build a QuantityTable-shaped object directly (bypassing
 * `quantityTableFromColumns`, which always derives `entityIndex` in-range
 * from `entityId`) so the on-disk index table can be corrupted the way a
 * damaged/truncated cache file would be.
 */
function tableWithCorruptEntityIndex(): QuantityTable {
  return {
    count: 1,
    entityId: Uint32Array.from([100]),
    qsetName: Uint32Array.from([1]),
    quantityName: Uint32Array.from([2]),
    quantityType: Uint8Array.from([QuantityType.Length]),
    value: new Float64Array([3.5]),
    unitId: Int32Array.from([-1]),
    formula: Uint32Array.from([0]),
    // Row 0 is the only row (count = 1), but the index claims row 7 —
    // exactly what a corrupt/truncated cache file would contain.
    entityIndex: new Map([[100, [1]]]),
    qsetIndex: new Map([[1, [0]]]),
    quantityIndex: new Map([[2, [0]]]),
  } as unknown as QuantityTable;
}

describe('readQuantities row-index bounds', () => {
  it('rejects an entityIndex row index that exceeds the row count (corrupt/truncated cache)', () => {
    const writer = new BufferWriter();
    writeQuantities(writer, tableWithCorruptEntityIndex());
    const buffer = writer.build();
    const strings = makeStrings(['', 'Qto_Test', 'Length']);

    expect(() => readQuantities(new BufferReader(buffer), strings)).toThrow(
      /Corrupt cache QuantityTable entityIndex: row index 1 for key 100 exceeds row count 1/,
    );
  });

  it('control: a well-formed table with in-range indices reads cleanly', () => {
    const table = tableWithCorruptEntityIndex();
    table.entityIndex.set(100, [0]); // in range this time
    const writer = new BufferWriter();
    writeQuantities(writer, table);
    const buffer = writer.build();
    const strings = makeStrings(['', 'Qto_Test', 'Length']);

    const restored = readQuantities(new BufferReader(buffer), strings);
    expect(restored.getForEntity(100)).toEqual([
      { name: 'Qto_Test', quantities: [{ name: 'Length', type: QuantityType.Length, value: 3.5, formula: undefined }] },
    ]);
  });
});
