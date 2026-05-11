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
