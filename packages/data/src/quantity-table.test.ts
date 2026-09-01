/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StringTable } from './string-table.js';
import { QuantityTableBuilder } from './quantity-table.js';
import { QuantityType } from './types.js';

describe('QuantityTable.getForEntity distinct-instance grouping', () => {
  it('keeps two distinct qset INSTANCES that share a literal name separate, not merged', () => {
    // A federated merge, or an exporter that emits the same Qto_ set twice on
    // one element, can put two rows on one entity whose qsetName is
    // identical but whose qsetGlobalId (the real IfcElementQuantity
    // identity) differs. Grouping by name alone previously merged them into
    // one QuantitySet reporting only the first row's GlobalId, so a
    // quantity that actually belonged to the second instance came back
    // attributed to the wrong qset.
    const strings = new StringTable();
    const builder = new QuantityTableBuilder(strings);
    builder.add({
      entityId: 100,
      qsetName: 'Qto_WallBaseQuantities',
      qsetGlobalId: 'gid-AAA',
      quantityName: 'NetVolume',
      quantityType: QuantityType.Volume,
      value: 1.25,
    });
    builder.add({
      entityId: 100,
      qsetName: 'Qto_WallBaseQuantities',
      qsetGlobalId: 'gid-BBB',
      quantityName: 'NetArea',
      quantityType: QuantityType.Area,
      value: 5.0,
    });
    const table = builder.build();

    const sets = table.getForEntity(100);
    expect(sets).toHaveLength(2);
    const byGlobalId = new Map(sets.map((s) => [s.globalId, s]));
    expect(byGlobalId.get('gid-AAA')?.quantities).toEqual([
      { name: 'NetVolume', type: QuantityType.Volume, value: 1.25, formula: undefined },
    ]);
    expect(byGlobalId.get('gid-BBB')?.quantities).toEqual([
      { name: 'NetArea', type: QuantityType.Area, value: 5.0, formula: undefined },
    ]);
  });

  it('merges rows that genuinely belong to one qset instance (same name and globalId)', () => {
    const strings = new StringTable();
    const builder = new QuantityTableBuilder(strings);
    builder.add({
      entityId: 100,
      qsetName: 'Qto_WallBaseQuantities',
      qsetGlobalId: 'gid-AAA',
      quantityName: 'NetVolume',
      quantityType: QuantityType.Volume,
      value: 1.25,
    });
    builder.add({
      entityId: 100,
      qsetName: 'Qto_WallBaseQuantities',
      qsetGlobalId: 'gid-AAA',
      quantityName: 'NetArea',
      quantityType: QuantityType.Area,
      value: 5.0,
    });
    const table = builder.build();

    const sets = table.getForEntity(100);
    expect(sets).toHaveLength(1);
    expect(sets[0].globalId).toBe('gid-AAA');
    expect(sets[0].quantities).toEqual([
      { name: 'NetVolume', type: QuantityType.Volume, value: 1.25, formula: undefined },
      { name: 'NetArea', type: QuantityType.Area, value: 5.0, formula: undefined },
    ]);
  });

  it('still merges rows with no qsetGlobalId supplied at all (existing-producer regression guard)', () => {
    // Producers with no real qset identity (e.g. IFCX's buildQuantities)
    // omit qsetGlobalId, which defaults to '' for both rows and so still
    // collides into one QuantitySet — matching pre-fix behavior exactly.
    const strings = new StringTable();
    const builder = new QuantityTableBuilder(strings);
    builder.add({
      entityId: 100,
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'NetVolume',
      quantityType: QuantityType.Volume,
      value: 1.25,
    });
    builder.add({
      entityId: 100,
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'NetArea',
      quantityType: QuantityType.Area,
      value: 5.0,
    });
    const table = builder.build();

    const sets = table.getForEntity(100);
    expect(sets).toHaveLength(1);
    expect(sets[0].quantities).toHaveLength(2);
  });
});
