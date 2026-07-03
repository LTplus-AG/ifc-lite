/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StringTable } from './string-table.js';
import {
  PropertyTableBuilder,
  propertyTableFromColumns,
  propertyTableToColumns,
  QuantityTableBuilder,
  quantityTableFromColumns,
  quantityTableToColumns,
} from './index.js';
import { PropertyValueType, QuantityType } from './types.js';

describe('PropertyTable round-trip', () => {
  it('preserves getForEntity / getPropertyValue across columns transport', () => {
    const strings = new StringTable();
    const builder = new PropertyTableBuilder(strings);
    builder.add({ entityId: 100, psetName: 'Pset_WallCommon', psetGlobalId: 'gid-1', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: true });
    builder.add({ entityId: 100, psetName: 'Pset_WallCommon', psetGlobalId: 'gid-1', propName: 'FireRating', propType: PropertyValueType.String, value: 'F90' });
    builder.add({ entityId: 100, psetName: 'Custom', psetGlobalId: 'gid-2', propName: 'Length', propType: PropertyValueType.Real, value: 3.5 });
    const original = builder.build();

    const rebuilt = propertyTableFromColumns(propertyTableToColumns(original), strings);

    const psets = rebuilt.getForEntity(100);
    expect(psets.map(p => p.name).sort()).toEqual(['Custom', 'Pset_WallCommon']);
    expect(rebuilt.getPropertyValue(100, 'Pset_WallCommon', 'IsExternal')).toBe(true);
    expect(rebuilt.getPropertyValue(100, 'Pset_WallCommon', 'FireRating')).toBe('F90');
    expect(rebuilt.getPropertyValue(100, 'Custom', 'Length')).toBeCloseTo(3.5);
  });

  it('handles empty tables (lite-mode default)', () => {
    const strings = new StringTable();
    const empty = new PropertyTableBuilder(strings).build();
    const rebuilt = propertyTableFromColumns(propertyTableToColumns(empty), strings);
    expect(rebuilt.count).toBe(0);
    expect(rebuilt.getForEntity(1)).toEqual([]);
  });
});

describe('PropertyTable.findByProperty', () => {
  function buildFixture() {
    const strings = new StringTable();
    const builder = new PropertyTableBuilder(strings);
    // Same prop name ("FireRating") appears in two different psets, on
    // different entities, to exercise the pset-scoping rule.
    builder.add({ entityId: 1, psetName: 'Pset_WallCommon', psetGlobalId: 'gid-wall', propName: 'FireRating', propType: PropertyValueType.String, value: 'F90' });
    builder.add({ entityId: 2, psetName: 'Pset_WallCommon', psetGlobalId: 'gid-wall', propName: 'FireRating', propType: PropertyValueType.String, value: 'F30' });
    builder.add({ entityId: 3, psetName: 'Pset_DoorCommon', psetGlobalId: 'gid-door', propName: 'FireRating', propType: PropertyValueType.String, value: 'F90' });
    // Numeric property for the comparison-operator matrix.
    builder.add({ entityId: 1, psetName: 'Qto_WallBaseQuantities', psetGlobalId: 'gid-qto', propName: 'Length', propType: PropertyValueType.Real, value: 5 });
    builder.add({ entityId: 2, psetName: 'Qto_WallBaseQuantities', psetGlobalId: 'gid-qto', propName: 'Length', propType: PropertyValueType.Real, value: 3 });
    // Boolean property.
    builder.add({ entityId: 1, psetName: 'Pset_WallCommon', psetGlobalId: 'gid-wall', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: true });
    builder.add({ entityId: 2, psetName: 'Pset_WallCommon', psetGlobalId: 'gid-wall', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: false });
    return builder.build();
  }

  it('numeric operator matrix (>=, >, <=, <, =, ==, !=)', () => {
    const table = buildFixture();
    expect(table.findByProperty('Length', '>=', 3).sort()).toEqual([1, 2]);
    expect(table.findByProperty('Length', '>', 3)).toEqual([1]);
    expect(table.findByProperty('Length', '<=', 3)).toEqual([2]);
    expect(table.findByProperty('Length', '<', 5)).toEqual([2]);
    expect(table.findByProperty('Length', '=', 5)).toEqual([1]);
    expect(table.findByProperty('Length', '==', 5)).toEqual([1]);
    expect(table.findByProperty('Length', '!=', 5)).toEqual([2]);
  });

  it('string operator matrix (=, ==, !=, contains, startsWith)', () => {
    const table = buildFixture();
    // Unscoped: both wall (1) and door (3) carry FireRating = 'F90'.
    expect(table.findByProperty('FireRating', '=', 'F90').sort()).toEqual([1, 3]);
    expect(table.findByProperty('FireRating', '==', 'F90').sort()).toEqual([1, 3]);
    expect(table.findByProperty('FireRating', '!=', 'F90').sort()).toEqual([2]);
    expect(table.findByProperty('FireRating', 'contains', '9').sort()).toEqual([1, 3]);
    expect(table.findByProperty('FireRating', 'startsWith', 'F3')).toEqual([2]);
  });

  it('boolean operator matrix (=, ==, !=)', () => {
    const table = buildFixture();
    expect(table.findByProperty('IsExternal', '=', true)).toEqual([1]);
    expect(table.findByProperty('IsExternal', '==', true)).toEqual([1]);
    expect(table.findByProperty('IsExternal', '!=', true)).toEqual([2]);
  });

  it('scopes matches to the given pset: a same-named prop in another pset does not match (#pset-scoping)', () => {
    const table = buildFixture();
    // Wall's FireRating='F90' matches when scoped to its own pset...
    expect(table.findByProperty('FireRating', '=', 'F90', 'Pset_WallCommon')).toEqual([1]);
    // ...and the door's identically-valued FireRating in a different pset
    // must NOT leak into that result.
    expect(table.findByProperty('FireRating', '=', 'F90', 'Pset_DoorCommon')).toEqual([3]);
  });

  it('an unknown pset name matches nothing', () => {
    const table = buildFixture();
    expect(table.findByProperty('FireRating', '=', 'F90', 'Pset_DoesNotExist')).toEqual([]);
  });

  it('an unknown property name matches nothing', () => {
    const table = buildFixture();
    expect(table.findByProperty('NoSuchProp', '=', 'anything')).toEqual([]);
  });
});

describe('QuantityTable round-trip', () => {
  it('preserves quantity values across columns transport', () => {
    const strings = new StringTable();
    const builder = new QuantityTableBuilder(strings);
    builder.add({ entityId: 100, qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetVolume', quantityType: QuantityType.Volume, value: 1.25 });
    builder.add({ entityId: 100, qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetArea', quantityType: QuantityType.Area, value: 5.0 });
    const original = builder.build();

    const rebuilt = quantityTableFromColumns(quantityTableToColumns(original), strings);
    expect(rebuilt.getQuantityValue(100, 'Qto_WallBaseQuantities', 'NetVolume')).toBeCloseTo(1.25);
    expect(rebuilt.sumByType('NetArea')).toBeCloseTo(5.0);
  });
});
