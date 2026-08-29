/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An entity can legitimately carry two distinct property (or quantity)
 * sets that share the same name (e.g. one from the type definition, one
 * from the occurrence). `getPropertyValue()`'s base-table fallback and
 * `setQuantity()`'s old-value lookup used to do a two-step
 * `sets.find(s => s.name === setName)` -> `.find(v => v.name === valName)`,
 * which only ever sees the FIRST same-named set -- a property/quantity
 * that lives on the SECOND same-named set was wrongly reported missing
 * (and, for `setQuantity`, wrongly recorded as a CREATE instead of an
 * UPDATE, with `oldValue: null`, which the undo handler treats as
 * "nothing to revert to").
 */

import { describe, expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from '../src/index.js';

describe('MutablePropertyView — two same-named property sets', () => {
  it('getPropertyValue finds a property on the SECOND same-named base pset', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) =>
      entityId === 1
        ? [
            { name: 'Pset_WallCommon', globalId: 'g1', properties: [{ name: 'IsExternal', type: 3, value: true }] },
            { name: 'Pset_WallCommon', globalId: 'g2', properties: [{ name: 'FireRating', type: 0, value: 'REI60' }] },
          ]
        : [],
    );

    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBe('REI60');
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'IsExternal')).toBe(true);
  });
});

describe('MutablePropertyView.setQuantity — two same-named quantity sets', () => {
  it('resolves oldValue/UPDATE against a quantity on the SECOND same-named base qset', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor((entityId) =>
      entityId === 1
        ? [
            { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', type: QuantityType.Length, value: 3 }] },
            { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossVolume', type: QuantityType.Volume, value: 12.5 }] },
          ]
        : [],
    );

    const mutation = view.setQuantity(1, 'Qto_WallBaseQuantities', 'GrossVolume', 20, QuantityType.Volume);

    expect(mutation.type).toBe('UPDATE_QUANTITY');
    expect(mutation.oldValue).toBe(12.5);
  });
});
