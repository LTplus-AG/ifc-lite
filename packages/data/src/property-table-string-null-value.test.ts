/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getPropertyValue`'s String-branch NULL sentinel guard
 * (property-table.ts:341): `valueString` is a Uint32Array, so the -1 NULL
 * sentinel wraps to 4294967295. Without the range check, that index is fed
 * straight to `StringTable.get`, which answers `''` for it — a NULL
 * string-typed property would silently read back as an empty string instead
 * of `null`.
 *
 * This is an asymmetry: the List branch three lines below had exactly this
 * bug, was fixed, and has its own test (property-table-list-values.test.ts)
 * whose doc comment cites the String branch as "already reject[ing]
 * out-of-range indices" — asserting the String branch's correctness as a
 * given rather than testing it. The fix documented its own blind spot; this
 * is the test that closes it.
 */

import { describe, expect, it } from 'vitest';
import { StringTable } from './string-table.js';
import { PropertyValueType } from './types.js';
import { propertyTableFromColumns, type PropertyTableColumns } from './property-table.js';

const NULL_STRING_SENTINEL = 0xffffffff; // -1 written into a Uint32Array

/**
 * One row per string index supplied, using a String-typed property. `strings`
 * seeds the table so the indices in `valueString` address real slots. Slot 0
 * must be the canonical empty string ('fromArray' inserts one otherwise and
 * shifts every index), so callers pass 1-based payload strings and the
 * leading '' is added here — mirrors `tableWithListValues` in
 * property-table-list-values.test.ts, but with propType: String.
 */
function tableWithStringValue(payloadStrings: string[], valueStringIndex: number) {
  const strings = ['', ...payloadStrings];
  const count = 1;
  const columns: PropertyTableColumns = {
    count,
    entityId: Uint32Array.from([100]),
    psetName: new Uint32Array(count).fill(1),
    psetGlobalId: new Uint32Array(count).fill(0),
    propName: new Uint32Array(count).fill(2),
    propType: new Uint8Array(count).fill(PropertyValueType.String),
    valueString: Uint32Array.from([valueStringIndex]),
    valueReal: new Float64Array(count),
    valueInt: new Int32Array(count),
    valueBool: new Uint8Array(count).fill(255),
    unitId: new Int32Array(count).fill(-1),
  };
  return propertyTableFromColumns(columns, StringTable.fromArray(strings));
}

describe('getPropertyValue: String NULL sentinel', () => {
  it('reports a NULL string-typed property as null, not as an empty string', () => {
    // strings[0] = pset name, strings[1] = prop name; no payload string —
    // the NULL sentinel index never resolves to a real slot.
    const table = tableWithStringValue(['Pset_Test', 'Name'], NULL_STRING_SENTINEL);
    const value = table.getPropertyValue(100, 'Pset_Test', 'Name');
    expect(value).toBeNull();
    expect(value).not.toBe('');
  });

  it('still returns the stored string for an in-range index', () => {
    const table = tableWithStringValue(['Pset_Test', 'Name', 'Wall-01'], 3);
    expect(table.getPropertyValue(100, 'Pset_Test', 'Name')).toBe('Wall-01');
  });
});
