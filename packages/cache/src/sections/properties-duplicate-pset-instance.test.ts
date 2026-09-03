/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model with two `IfcPropertySet` instances that share a literal name --
 * a federated merge, or an exporter emitting the same Pset_ twice on one
 * element -- must answer the same way whether it came from a fresh parse or
 * from the binary cache. `@ifc-lite/data`'s `PropertyTable.getForEntity`
 * groups rows on `(psetName, psetGlobalId)` so the two instances stay
 * distinct; this cache section reuses that same grouping (via
 * `groupPropertySetsByInstance`) instead of re-implementing it, so a
 * cache-loaded model can't silently regress to grouping by name alone.
 */

import { describe, it, expect } from 'vitest';
import { StringTable, PropertyValueType, PropertyTableBuilder, propertyTableFromColumns } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import { writeProperties, readProperties } from './properties.js';

describe('cache round-trip: distinct same-named pset instances', () => {
  it('keeps two same-named pset instances separate after a cache round-trip, matching the fresh parse', () => {
    const strings = new StringTable();
    const builder = new PropertyTableBuilder(strings);
    builder.add({
      entityId: 100,
      psetName: 'Pset_WallCommon',
      psetGlobalId: 'gid-AAA',
      propName: 'FireRating',
      propType: PropertyValueType.String,
      value: 'F90',
    });
    builder.add({
      entityId: 100,
      psetName: 'Pset_WallCommon',
      psetGlobalId: 'gid-BBB',
      propName: 'IsExternal',
      propType: PropertyValueType.Boolean,
      value: true,
    });
    const freshTable = builder.build();

    // Fresh parse: the reference behaviour this test pins the cache path to.
    const freshSets = freshTable.getForEntity(100);
    expect(freshSets).toHaveLength(2);

    // Round-trip through the binary cache format.
    const writer = new BufferWriter();
    writeProperties(writer, freshTable);
    const cachedTable = readProperties(new BufferReader(writer.build()), strings);

    const cachedSets = cachedTable.getForEntity(100);

    // The actual regression: cache-loaded rows must not merge back into one
    // set keyed on psetName alone, misattributing IsExternal to gid-AAA.
    expect(cachedSets).toHaveLength(2);
    const byGlobalId = new Map(cachedSets.map((s) => [s.globalId, s]));
    expect(byGlobalId.get('gid-AAA')?.properties).toEqual([
      { name: 'FireRating', type: PropertyValueType.String, value: 'F90' },
    ]);
    expect(byGlobalId.get('gid-BBB')?.properties).toEqual([
      { name: 'IsExternal', type: PropertyValueType.Boolean, value: true },
    ]);

    // Parity: the cache-loaded model must answer identically to the fresh
    // parse for this fixture -- that equality is the real guard against the
    // two paths re-diverging.
    expect(cachedSets).toEqual(freshSets);
  });

  it('round-trips unaffected through propertyTableFromColumns too (sanity: fresh-parse rebuild)', () => {
    const strings = new StringTable();
    const builder = new PropertyTableBuilder(strings);
    builder.add({
      entityId: 100,
      psetName: 'Pset_WallCommon',
      psetGlobalId: 'gid-AAA',
      propName: 'FireRating',
      propType: PropertyValueType.String,
      value: 'F90',
    });
    builder.add({
      entityId: 100,
      psetName: 'Pset_WallCommon',
      psetGlobalId: 'gid-BBB',
      propName: 'IsExternal',
      propType: PropertyValueType.Boolean,
      value: true,
    });
    const table = builder.build();
    const rebuilt = propertyTableFromColumns(
      {
        count: table.count,
        entityId: table.entityId,
        psetName: table.psetName,
        psetGlobalId: table.psetGlobalId,
        propName: table.propName,
        propType: table.propType,
        valueString: table.valueString,
        valueReal: table.valueReal,
        valueInt: table.valueInt,
        valueBool: table.valueBool,
        unitId: table.unitId,
      },
      strings,
    );
    expect(rebuilt.getForEntity(100)).toHaveLength(2);
  });
});
