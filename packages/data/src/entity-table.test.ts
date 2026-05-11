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
