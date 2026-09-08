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
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
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

describe('MutablePropertyView.deletePropertySet — two same-named property sets', () => {
  it('marks properties on EVERY same-named pset deleted, not just the first', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) =>
      entityId === 1
        ? [
            { name: 'Pset_WallCommon', globalId: 'g1', properties: [{ name: 'IsExternal', type: 3, value: true }] },
            { name: 'Pset_WallCommon', globalId: 'g2', properties: [{ name: 'FireRating', type: 0, value: 'REI60' }] },
          ]
        : [],
    );

    view.deletePropertySet(1, 'Pset_WallCommon');

    // `deletedPsets` masks by NAME, so the panel already hides both sets.
    expect(view.getForEntity(1)).toEqual([]);
    // The per-property DELETE markers -- which the STEP exporter reads, and
    // which `getPropertyValue` answers from -- have to cover both sets, or
    // the two paths disagree about whether the second set still exists.
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'IsExternal')).toBeNull();
    expect(view.getPropertyValue(1, 'Pset_WallCommon', 'FireRating')).toBeNull();
  });
});

describe('MutablePropertyView.deleteQuantitySet — two same-named quantity sets', () => {
  it('marks quantities on EVERY same-named qset deleted, not just the first', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor((entityId) =>
      entityId === 1
        ? [
            { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', type: QuantityType.Length, value: 3 }] },
            { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossVolume', type: QuantityType.Volume, value: 12.5 }] },
          ]
        : [],
    );

    view.deleteQuantitySet(1, 'Qto_WallBaseQuantities');

    expect(view.getQuantitiesForEntity(1)).toEqual([]);
    // A quantity on the second same-named qset must not survive the delete:
    // if it does, re-setting it later resolves an oldValue against a set the
    // session has already removed.
    const after = view.setQuantity(1, 'Qto_WallBaseQuantities', 'GrossVolume', 20, QuantityType.Volume);
    expect(after.oldValue).toBeNull();
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

describe('MutablePropertyView.setProperty — a brand-new property on two same-named base psets', () => {
  // `setProperty` records the mutation under `propertyKey(entityId, psetName,
  // propName)`, which carries no identity beyond the pset NAME. Traced from
  // the bSDD "jump to added property" flow (#1107): `BsddCard` only knows a
  // pset by name, so adding a property that is new to both same-named sets
  // used to make `getForEntity` inject it into EVERY base pset sharing that
  // name -- a genuine duplicate write, not just a highlight ambiguity.
  it('lands the new property on the FIRST same-named pset only, not every one', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) =>
      entityId === 1
        ? [
            { name: 'Pset_Common', globalId: 'g1', properties: [{ name: 'Reference', type: PropertyValueType.Label, value: 'refA' }] },
            { name: 'Pset_Common', globalId: 'g2', properties: [{ name: 'Status', type: PropertyValueType.Label, value: 'NEW' }] },
          ]
        : [],
    );

    view.setProperty(1, 'Pset_Common', 'FireRating', 'RF60', PropertyValueType.Label);

    const result = view.getForEntity(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      globalId: 'g1',
      properties: [
        { name: 'Reference', value: 'refA' },
        { name: 'FireRating', value: 'RF60' },
      ],
    });
    // The second same-named pset keeps its own properties, unpolluted.
    expect(result[1]).toMatchObject({
      globalId: 'g2',
      properties: [{ name: 'Status', value: 'NEW' }],
    });
  });

  it('edits a property the SECOND same-named pset holds in place, without copying it onto the first', () => {
    // "First same-named instance" is the tie-break for a property NO instance
    // carries. One an instance already carries is not new at all -- the
    // per-property loop above applies the SET in place, on g2 -- so stamping a
    // copy onto g1 as well would re-create the very duplicate this file pins,
    // and would put the value on the opposite set from the one
    // `findPropertyInSets`/`getPropertyValue` resolve the read to.
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) =>
      entityId === 1
        ? [
            { name: 'Pset_Common', globalId: 'g1', properties: [{ name: 'Reference', type: PropertyValueType.Label, value: 'refA' }] },
            { name: 'Pset_Common', globalId: 'g2', properties: [{ name: 'FireRating', type: PropertyValueType.Label, value: 'RF30' }] },
          ]
        : [],
    );

    view.setProperty(1, 'Pset_Common', 'FireRating', 'RF60', PropertyValueType.Label);

    const result = view.getForEntity(1);
    expect(result[0]).toMatchObject({ globalId: 'g1', properties: [{ name: 'Reference', value: 'refA' }] });
    expect(result[1]).toMatchObject({ globalId: 'g2', properties: [{ name: 'FireRating', value: 'RF60' }] });
    // The read agrees with where the write landed.
    expect(view.getPropertyValue(1, 'Pset_Common', 'FireRating')).toBe('RF60');
  });

  it('control: a unique-named pset still receives the new property normally', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) =>
      entityId === 1
        ? [{ name: 'Pset_Unique', globalId: 'g1', properties: [{ name: 'Reference', type: PropertyValueType.Label, value: 'refA' }] }]
        : [],
    );

    view.setProperty(1, 'Pset_Unique', 'FireRating', 'RF60', PropertyValueType.Label);

    expect(view.getForEntity(1)).toMatchObject([
      {
        globalId: 'g1',
        properties: [
          { name: 'Reference', value: 'refA' },
          { name: 'FireRating', value: 'RF60' },
        ],
      },
    ]);
  });
});

describe('MutablePropertyView.setQuantity — a brand-new quantity on two same-named base qsets', () => {
  // `getQuantitiesForEntity` is `getForEntity`'s sibling and had the identical
  // defect: `quantityKey` stops at the qset NAME too, and `BsddCard`'s add
  // path routes a `Qto_*` name straight through `setQuantity`. The duplicate
  // reaches the properties panel AND the STEP exporter, which regenerates
  // every same-named `IfcElementQuantity` from this output, so a phantom
  // quantity is written into the saved IFC file.
  it('lands the new quantity on the FIRST same-named qset only, not every one', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor((entityId) =>
      entityId === 1
        ? [
            { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', type: QuantityType.Length, value: 3 }] },
            { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossVolume', type: QuantityType.Volume, value: 12.5 }] },
          ]
        : [],
    );

    view.setQuantity(1, 'Qto_WallBaseQuantities', 'NetArea', 7, QuantityType.Area);

    const result = view.getQuantitiesForEntity(1);
    expect(result).toHaveLength(2);
    expect(result[0].quantities.map((q) => q.name)).toEqual(['Length', 'NetArea']);
    // The second same-named qset keeps its own quantities, unpolluted.
    expect(result[1].quantities.map((q) => q.name)).toEqual(['GrossVolume']);
  });

  it('edits a quantity the SECOND same-named qset holds in place, without copying it onto the first', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor((entityId) =>
      entityId === 1
        ? [
            { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', type: QuantityType.Length, value: 3 }] },
            { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossVolume', type: QuantityType.Volume, value: 12.5 }] },
          ]
        : [],
    );

    view.setQuantity(1, 'Qto_WallBaseQuantities', 'GrossVolume', 20, QuantityType.Volume);

    expect(view.getQuantitiesForEntity(1)).toMatchObject([
      { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 3 }] },
      { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossVolume', value: 20 }] },
    ]);
  });

  it('control: a unique-named qset still receives the new quantity normally', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor((entityId) =>
      entityId === 1
        ? [{ name: 'Qto_Unique', quantities: [{ name: 'Length', type: QuantityType.Length, value: 3 }] }]
        : [],
    );

    view.setQuantity(1, 'Qto_Unique', 'NetArea', 7, QuantityType.Area);

    expect(view.getQuantitiesForEntity(1)).toMatchObject([
      { name: 'Qto_Unique', quantities: [{ name: 'Length', value: 3 }, { name: 'NetArea', value: 7 }] },
    ]);
  });
});

// Two same-named base psets that BOTH already carry a property of the same
// name (e.g. a type pset and an occurrence pset that happen to share a
// name, each with their own FireRating). setProperty/deleteProperty key
// mutations purely as `${entityId}:${psetName}:${propName}` -- one key with
// no instance identity -- and getForEntity's per-pset loop re-applies that
// single mutation to every base pset instance whose properties contain a
// matching name. Editing one row must not silently change the other same-
// named pset's row too: `getForEntity` should apply the edit to the FIRST
// same-named instance that carries the property, matching the "first match
// across the sequence wins" semantics `findPropertyInSets`/
// `PropertyTable.getProperty` already use for reads (#3468).
describe('MutablePropertyView.setProperty — two same-named base psets both carrying the edited property', () => {
  const twoSets = (entityId: number) =>
    entityId === 1
      ? [
          {
            name: 'Pset_WallCommon',
            globalId: 'g1',
            properties: [
              { name: 'IsExternal', type: 3, value: true },
              { name: 'FireRating', type: 0, value: 'RF30' },
            ],
          },
          {
            name: 'Pset_WallCommon',
            globalId: 'g2',
            properties: [
              { name: 'Reference', type: 0, value: 'REF-2' },
              { name: 'FireRating', type: 0, value: 'RF60' },
            ],
          },
        ]
      : [];

  it('mutates FireRating on only the FIRST same-named pset, not both', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(twoSets);

    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'RF90');

    const psets = view.getForEntity(1);
    const g1 = psets.find((p) => p.globalId === 'g1')!;
    const g2 = psets.find((p) => p.globalId === 'g2')!;
    expect(g1.properties.find((p) => p.name === 'FireRating')?.value).toBe('RF90');
    expect(g2.properties.find((p) => p.name === 'FireRating')?.value).toBe('RF60');
  });

  it('control: a property present on only ONE of the two sets mutates only that set', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(twoSets);

    view.setProperty(1, 'Pset_WallCommon', 'Reference', 'REF-9');

    const psets = view.getForEntity(1);
    const g1 = psets.find((p) => p.globalId === 'g1')!;
    const g2 = psets.find((p) => p.globalId === 'g2')!;
    expect(g1.properties.find((p) => p.name === 'Reference')).toBeUndefined();
    expect(g2.properties.find((p) => p.name === 'Reference')?.value).toBe('REF-9');
  });
});

describe('MutablePropertyView.deleteProperty — two same-named base psets both carrying the deleted property', () => {
  const twoSets = (entityId: number) =>
    entityId === 1
      ? [
          {
            name: 'Pset_WallCommon',
            globalId: 'g1',
            properties: [
              { name: 'IsExternal', type: 3, value: true },
              { name: 'FireRating', type: 0, value: 'RF30' },
            ],
          },
          {
            name: 'Pset_WallCommon',
            globalId: 'g2',
            properties: [
              { name: 'Reference', type: 0, value: 'REF-2' },
              { name: 'FireRating', type: 0, value: 'RF60' },
            ],
          },
        ]
      : [];

  it('removes FireRating from only the FIRST same-named pset, not both', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(twoSets);

    view.deleteProperty(1, 'Pset_WallCommon', 'FireRating');

    const psets = view.getForEntity(1);
    const g1 = psets.find((p) => p.globalId === 'g1')!;
    const g2 = psets.find((p) => p.globalId === 'g2')!;
    expect(g1.properties.find((p) => p.name === 'FireRating')).toBeUndefined();
    expect(g2.properties.find((p) => p.name === 'FireRating')?.value).toBe('RF60');
  });
});

// Twin of the property block above: two same-named base qsets that BOTH
// already carry a quantity of the same name. `setQuantity` keys its
// mutation purely as `${entityId}:${qsetName}:${quantName}` -- same
// no-instance-identity key as properties -- so `getQuantitiesForEntity`'s
// per-qset loop used to re-apply a single SET to every same-named qset
// instance whose quantities contained a matching name. There is no
// single-quantity `deleteQuantity` method (only whole-set
// `deleteQuantitySet`, which intentionally covers every same-named
// instance -- see the "marks quantities on EVERY same-named qset deleted"
// case above), so DELETE has no twin to pin here.
describe('MutablePropertyView.setQuantity — two same-named base qsets both carrying the edited quantity', () => {
  const twoQsets = (entityId: number) =>
    entityId === 1
      ? [
          {
            name: 'Qto_WallBaseQuantities',
            quantities: [
              { name: 'Length', type: QuantityType.Length, value: 3 },
              { name: 'Width', type: QuantityType.Length, value: 1 },
            ],
          },
          {
            name: 'Qto_WallBaseQuantities',
            quantities: [
              { name: 'Height', type: QuantityType.Length, value: 5 },
              { name: 'Width', type: QuantityType.Length, value: 2 },
            ],
          },
        ]
      : [];

  it('mutates Width on only the FIRST same-named qset, not both', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor(twoQsets);

    view.setQuantity(1, 'Qto_WallBaseQuantities', 'Width', 99, QuantityType.Length);

    const result = view.getQuantitiesForEntity(1);
    expect(result[0].quantities.find((q) => q.name === 'Width')?.value).toBe(99);
    expect(result[1].quantities.find((q) => q.name === 'Width')?.value).toBe(2);
  });

  it('control: a quantity present on only ONE of the two sets mutates only that set', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setQuantityExtractor(twoQsets);

    view.setQuantity(1, 'Qto_WallBaseQuantities', 'Height', 77, QuantityType.Length);

    const result = view.getQuantitiesForEntity(1);
    expect(result[0].quantities.find((q) => q.name === 'Height')).toBeUndefined();
    expect(result[1].quantities.find((q) => q.name === 'Height')?.value).toBe(77);
  });
});
