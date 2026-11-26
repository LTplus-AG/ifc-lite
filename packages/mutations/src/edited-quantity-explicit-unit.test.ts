/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #11592: an edited quantity kept its number but lost its own `Unit`, so
 * displays labelled it in the project unit instead.
 */
import { describe, expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from './mutable-property-view.js';
import { replayQuantityMutation } from './quantity-replay.js';

/** NetSideArea declares its own mm2 Unit; GrossArea inherits the project unit. */
function view(): MutablePropertyView {
  const v = new MutablePropertyView(null, 'm');
  v.setQuantityExtractor(() => [{
    name: 'Qto_WallBaseQuantities',
    quantities: [
      { name: 'NetSideArea', type: QuantityType.Area, value: 5_000_000, explicitUnit: 'mm²', explicitUnitSiScale: 1e-6 },
      { name: 'GrossArea', type: QuantityType.Area, value: 6 },
    ],
  }]);
  return v;
}
const read = (v: MutablePropertyView, name: string) =>
  v.getQuantitiesForEntity(1)[0].quantities.find((q) => q.name === name);

describe('an edited quantity keeps its own Unit (#11592)', () => {
  it('keeps the explicit unit and its SI scale when only the value changes', () => {
    const v = view();
    v.setQuantity(1, 'Qto_WallBaseQuantities', 'NetSideArea', 7_000_000, QuantityType.Area);
    expect(read(v, 'NetSideArea')).toMatchObject({ value: 7_000_000, explicitUnit: 'mm²', explicitUnitSiScale: 1e-6 });
  });

  it('adds no explicit unit to a quantity that had none', () => {
    const v = view();
    v.setQuantity(1, 'Qto_WallBaseQuantities', 'GrossArea', 8, QuantityType.Area);
    expect(read(v, 'GrossArea')).not.toHaveProperty('explicitUnitSiScale');
  });

  it('drops it when the edit removes the unit, names its own, or changes the quantity type', () => {
    for (const edit of [
      (v: MutablePropertyView) => v.setQuantity(1, 'Qto_WallBaseQuantities', 'NetSideArea', 7, QuantityType.Area, null),
      (v: MutablePropertyView) => v.setQuantity(1, 'Qto_WallBaseQuantities', 'NetSideArea', 7, QuantityType.Area, 'm²'),
      (v: MutablePropertyView) => v.setQuantity(1, 'Qto_WallBaseQuantities', 'NetSideArea', 7, QuantityType.Length),
    ]) {
      const v = view();
      edit(v);
      const q = read(v, 'NetSideArea');
      expect(q).not.toHaveProperty('explicitUnitSiScale');
      expect(q).not.toHaveProperty('explicitUnit');
    }
  });

  it('keeps it when the edit repeats the quantity\'s own unit symbol', () => {
    const v = view();
    v.setQuantity(1, 'Qto_WallBaseQuantities', 'NetSideArea', 7_000_000, QuantityType.Area, 'mm²');
    expect(read(v, 'NetSideArea')).toMatchObject({ explicitUnit: 'mm²', explicitUnitSiScale: 1e-6 });
  });

  it('still has it after the edit is undone', () => {
    const v = view();
    const edit = v.setQuantity(1, 'Qto_WallBaseQuantities', 'NetSideArea', 7_000_000, QuantityType.Area);
    replayQuantityMutation(v, edit, 'undo');
    expect(read(v, 'NetSideArea')).toMatchObject({ value: 5_000_000, explicitUnit: 'mm²', explicitUnitSiScale: 1e-6 });
  });
});
