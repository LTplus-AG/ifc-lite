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

describe('QuantityTable.sumByType elementType', () => {
  // The interface declares an optional `elementType` filter, but the
  // columnar table only stores `entityId` per row — no entity-type data —
  // so it cannot honor a filtered sum. It must fail loudly rather than
  // silently return the unfiltered total (issue: declared-but-ignored param).
  function buildFixture() {
    const strings = new StringTable();
    const builder = new QuantityTableBuilder(strings);
    // Two entities, deliberately different values, so an accidental
    // unfiltered-vs-filtered coincidence can't mask the bug.
    builder.add({ entityId: 1, qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetArea', quantityType: QuantityType.Area, value: 10 });
    builder.add({ entityId: 2, qsetName: 'Qto_DoorBaseQuantities', quantityName: 'NetArea', quantityType: QuantityType.Area, value: 100 });
    return builder.build();
  }

  it('sums every row when elementType is omitted', () => {
    const table = buildFixture();
    expect(table.sumByType('NetArea')).toBeCloseTo(110);
  });

  it('throws when elementType is passed instead of silently ignoring it', () => {
    const table = buildFixture();
    expect(() => table.sumByType('NetArea', 42)).toThrow(/elementType/);
  });
});

describe('QuantityTable.findByQuantity', () => {
  // `EntityQuery.whereProperty('Qto_...', 'NetArea', '>', 10)` is documented but
  // quantities are not property rows, so the filter needs a quantity-side index
  // to answer without resolving every candidate (issue #577 follow-up).
  function buildQuantityFixture() {
    const strings = new StringTable();
    const builder = new QuantityTableBuilder(strings);
    builder.add({ entityId: 1, qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetArea', quantityType: QuantityType.Area, value: 12.5 });
    builder.add({ entityId: 2, qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetArea', quantityType: QuantityType.Area, value: 4.0 });
    builder.add({ entityId: 3, qsetName: 'Qto_SlabBaseQuantities', quantityName: 'NetArea', quantityType: QuantityType.Area, value: 30.0 });
    return builder.build();
  }

  it('matches numeric comparisons across quantity sets', () => {
    const table = buildQuantityFixture();
    expect(table.findByQuantity!('NetArea', '>', 10).sort()).toEqual([1, 3]);
    expect(table.findByQuantity!('NetArea', '<', 10)).toEqual([2]);
    expect(table.findByQuantity!('NetArea', '=', 12.5)).toEqual([1]);
    expect(table.findByQuantity!('NetArea', '>=', 30)).toEqual([3]);
  });

  it('scopes to the named quantity set', () => {
    const table = buildQuantityFixture();
    expect(table.findByQuantity!('NetArea', '>', 10, 'Qto_WallBaseQuantities')).toEqual([1]);
    expect(table.findByQuantity!('NetArea', '>', 10, 'Qto_SlabBaseQuantities')).toEqual([3]);
    expect(table.findByQuantity!('NetArea', '>', 10, 'Qto_DoesNotExist')).toEqual([]);
  });

  it('returns [] for an unknown quantity name and for a string filter value', () => {
    const table = buildQuantityFixture();
    expect(table.findByQuantity!('NoSuchQuantity', '>', 0)).toEqual([]);
    // Quantity values are always numbers; `comparePropertyValues` is same-type
    // only, so a string filter value never matches.
    expect(table.findByQuantity!('NetArea', '=', '12.5')).toEqual([]);
  });
});
