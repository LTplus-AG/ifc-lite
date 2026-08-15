/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StringTable } from './string-table.js';
import {
  EntityTableBuilder,
  entityTableFromColumns,
  entityTableToColumns,
} from './entity-table.js';
import { IfcTypeEnum, EntityFlags } from './types.js';

function buildSampleTable() {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(8, strings);
  builder.add(101, 'IFCWALL', '0YvCT2_$X3_xJG3rzD8L_8', 'Wall-A', 'desc', 'Standard', true, false);
  builder.add(102, 'IFCWALL', '1abCT2_$X3_xJG3rzD8L_8', 'Wall-B', '', '', true, false);
  builder.add(201, 'IFCWALLTYPE', '2zzCT2_$X3_xJG3rzD8L_8', 'WallType-A', '', '', false, true);
  builder.add(301, 'IFCSPACE', '3qqCT2_$X3_xJG3rzD8L_8', 'Office-101', '', '', false, false);
  builder.add(401, 'IFCSOMEUNKNOWN', '', '', '', '', false, false); // exercises rawTypeName fallback
  return { strings, table: builder.build() };
}

describe('EntityTable.build()', () => {
  it('exposes columnar arrays and lookup methods', () => {
    const { table } = buildSampleTable();
    expect(table.count).toBe(5);
    expect(table.expressId[0]).toBe(101);
    expect(table.getName(101)).toBe('Wall-A');
    expect(table.getGlobalId(101)).toBe('0YvCT2_$X3_xJG3rzD8L_8');
    expect(table.hasGeometry(101)).toBe(true);
    expect(table.hasGeometry(201)).toBe(false);
    expect(table.getTypeName(101)).toBe('IfcWall');
    expect(table.getTypeEnum(101)).toBe(IfcTypeEnum.IfcWall);
  });

  it('returns the rawTypeName fallback for unknown enum types', () => {
    const { table } = buildSampleTable();
    // IFCSOMEUNKNOWN is not in the enum — getTypeName must fall back to rawTypeName.
    const name = table.getTypeName(401);
    expect(name).not.toBe('Unknown');
    expect(name.toLowerCase()).toContain('someunknown');
  });

  it('exposes rawTypeName as a column', () => {
    const { table } = buildSampleTable();
    expect(table.rawTypeName).toBeInstanceOf(Uint32Array);
    expect(table.rawTypeName!.length).toBe(table.count);
  });

  it('groups expressIds by type', () => {
    const { table } = buildSampleTable();
    const wallIds = table.getByType(IfcTypeEnum.IfcWall);
    expect(wallIds.sort()).toEqual([101, 102]);
    expect(table.getByType(IfcTypeEnum.IfcSpace)).toEqual([301]);
  });
});

describe('entityTableToColumns / entityTableFromColumns round-trip', () => {
  it('preserves every public lookup', () => {
    const { strings, table } = buildSampleTable();
    const columns = entityTableToColumns(table);
    const rebuilt = entityTableFromColumns(columns, strings);

    expect(rebuilt.count).toBe(table.count);
    expect(Array.from(rebuilt.expressId)).toEqual(Array.from(table.expressId));
    expect(Array.from(rebuilt.flags)).toEqual(Array.from(table.flags));

    for (const id of [101, 102, 201, 301, 401]) {
      expect(rebuilt.getName(id)).toBe(table.getName(id));
      expect(rebuilt.getGlobalId(id)).toBe(table.getGlobalId(id));
      expect(rebuilt.getTypeName(id)).toBe(table.getTypeName(id));
      expect(rebuilt.getTypeEnum(id)).toBe(table.getTypeEnum(id));
      expect(rebuilt.hasGeometry(id)).toBe(table.hasGeometry(id));
    }

    expect(rebuilt.getByType(IfcTypeEnum.IfcWall).sort()).toEqual([101, 102]);
    expect(rebuilt.getExpressIdByGlobalId('0YvCT2_$X3_xJG3rzD8L_8')).toBe(101);
    expect(rebuilt.getExpressIdByGlobalId('does-not-exist')).toBe(-1);
  });

  it('survives when columns omit rawTypeName (legacy cache hydration)', () => {
    const { strings, table } = buildSampleTable();
    const columns = entityTableToColumns(table);
    delete (columns as { rawTypeName?: Uint32Array }).rawTypeName;
    const rebuilt = entityTableFromColumns(columns, strings);

    // Known enums still resolve via the typeEnum column.
    expect(rebuilt.getTypeName(101)).toBe('IfcWall');
    // Without rawTypeName, the unknown-type fallback returns 'Unknown'.
    expect(rebuilt.getTypeName(401)).toBe('Unknown');
  });

  it('honors EntityFlags.HAS_GEOMETRY through the round-trip', () => {
    const { strings, table } = buildSampleTable();
    expect((table.flags[0] & EntityFlags.HAS_GEOMETRY) !== 0).toBe(true);
    const rebuilt = entityTableFromColumns(entityTableToColumns(table), strings);
    expect((rebuilt.flags[0] & EntityFlags.HAS_GEOMETRY) !== 0).toBe(true);
  });

  it('returns identical typed-array buffers (zero-copy aliasing)', () => {
    const { strings, table } = buildSampleTable();
    const columns = entityTableToColumns(table);
    expect(columns.expressId.buffer).toBe(table.expressId.buffer);

    const rebuilt = entityTableFromColumns(columns, strings);
    expect(rebuilt.expressId.buffer).toBe(table.expressId.buffer);
  });
});

describe('EntityTable GlobalId index', () => {
  // The sample table's entity 401 carries an EMPTY GlobalId (the IFC file
  // omitted it, or the row is a non-rooted entity). Without the emptiness
  // guard on the index build, '' maps to a real expressId and every BCF
  // lookup of a missing GUID resolves to whatever entity happened to be
  // last with a blank GlobalId.
  it('never indexes the empty GlobalId', () => {
    const { table } = buildSampleTable();
    expect(table.getExpressIdByGlobalId('')).toBe(-1);
  });

  it('still indexes every non-empty GlobalId', () => {
    const { table } = buildSampleTable();
    expect(table.getExpressIdByGlobalId('0YvCT2_$X3_xJG3rzD8L_8')).toBe(101);
    expect(table.getExpressIdByGlobalId('3qqCT2_$X3_xJG3rzD8L_8')).toBe(301);
  });

  it('keeps the empty GlobalId unindexed through the columns round-trip', () => {
    const { strings, table } = buildSampleTable();
    const rebuilt = entityTableFromColumns(entityTableToColumns(table), strings);
    expect(rebuilt.getExpressIdByGlobalId('')).toBe(-1);
    expect(rebuilt.getExpressIdByGlobalId('1abCT2_$X3_xJG3rzD8L_8')).toBe(102);
  });
});

describe('EntityTable typeRanges derived from interleaved columns', () => {
  // `entityTableFromColumns` derives typeRanges only when the caller omits
  // them (worker-transport rebuild). IFC streams interleave types freely,
  // and the range for a type is [firstRow, lastRow+1] — NOT the number of
  // rows of that type, which only coincides when each type is contiguous
  // and starts at row 0. The sample table above is fully contiguous, so it
  // cannot tell the two apart; this fixture interleaves deliberately.
  function interleaved() {
    const strings = new StringTable();
    const builder = new EntityTableBuilder(8, strings);
    builder.add(1, 'IFCWALL', 'gid-1', 'W1', '', '', false, false); // row 0
    builder.add(2, 'IFCSPACE', 'gid-2', 'S1', '', '', false, false); // row 1
    builder.add(3, 'IFCWALL', 'gid-3', 'W2', '', '', false, false); // row 2
    builder.add(4, 'IFCSPACE', 'gid-4', 'S2', '', '', false, false); // row 3
    builder.add(5, 'IFCWALL', 'gid-5', 'W3', '', '', false, false); // row 4
    return { strings, table: builder.build() };
  }

  it('spans first row to last row + 1 for an interleaved type', () => {
    const { strings, table } = interleaved();
    const columns = entityTableToColumns(table);
    delete (columns as { typeRanges?: unknown }).typeRanges;
    const rebuilt = entityTableFromColumns(columns, strings);

    // IfcWall occupies rows 0, 2, 4 -> [0, 5); IfcSpace rows 1, 3 -> [1, 4).
    expect(rebuilt.typeRanges.get(IfcTypeEnum.IfcWall)).toEqual({ start: 0, end: 5 });
    expect(rebuilt.typeRanges.get(IfcTypeEnum.IfcSpace)).toEqual({ start: 1, end: 4 });
  });

  it('produces a range that contains every row of that type', () => {
    const { strings, table } = interleaved();
    const columns = entityTableToColumns(table);
    delete (columns as { typeRanges?: unknown }).typeRanges;
    const rebuilt = entityTableFromColumns(columns, strings);

    for (const [type, range] of rebuilt.typeRanges) {
      for (let row = 0; row < rebuilt.count; row++) {
        if (rebuilt.typeEnum[row] === type) {
          expect(row).toBeGreaterThanOrEqual(range.start);
          expect(row).toBeLessThan(range.end);
        }
      }
    }
  });

  it('prefers supplied typeRanges over the derived ones', () => {
    const { strings, table } = interleaved();
    const columns = entityTableToColumns(table);
    columns.typeRanges = new Map([[IfcTypeEnum.IfcWall, { start: 7, end: 9 }]]);
    const rebuilt = entityTableFromColumns(columns, strings);
    expect(rebuilt.typeRanges.get(IfcTypeEnum.IfcWall)).toEqual({ start: 7, end: 9 });
  });

  it('getByType stays exact for interleaved types (index, not range, decides)', () => {
    const { strings, table } = interleaved();
    const columns = entityTableToColumns(table);
    delete (columns as { typeRanges?: unknown }).typeRanges;
    const rebuilt = entityTableFromColumns(columns, strings);
    expect(rebuilt.getByType(IfcTypeEnum.IfcWall)).toEqual([1, 3, 5]);
    expect(rebuilt.getByType(IfcTypeEnum.IfcSpace)).toEqual([2, 4]);
  });
});
