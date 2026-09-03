/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `QuantityTable.sumByType` declares an optional `elementType` parameter,
 * but neither this cache-restored implementation nor the columnar one in
 * `@ifc-lite/data` has per-row entity-type data to honor it. Before this
 * test existed, both silently dropped `elementType` and returned the
 * unfiltered total — a caller who trusted the type signature would get a
 * wrong-but-plausible number instead of an error. They now throw instead.
 */

import { describe, it, expect } from 'vitest';
import { StringTable, QuantityTableBuilder, quantityTableToColumns } from '@ifc-lite/data';
import { QuantityType } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import { writeQuantities, readQuantities } from './quantities.js';

function buildFixture() {
  const strings = new StringTable();
  const builder = new QuantityTableBuilder(strings);
  // Two entities, same quantity name, deliberately different values so a
  // filtered vs. unfiltered sum cannot accidentally coincide.
  builder.add({ entityId: 1, qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetArea', quantityType: QuantityType.Area, value: 10 });
  builder.add({ entityId: 2, qsetName: 'Qto_DoorBaseQuantities', quantityName: 'NetArea', quantityType: QuantityType.Area, value: 100 });
  return { strings, table: builder.build() };
}

function roundTrip(strings: StringTable, table: ReturnType<typeof buildFixture>['table']) {
  const writer = new BufferWriter();
  writeQuantities(writer, table);
  return readQuantities(new BufferReader(writer.build()), strings);
}

describe('cache QuantityTable formula round-trip', () => {
  // `formula` was written/read (writeQuantities/readQuantities) but no cache
  // test ever asserted it survived the round-trip: a mutation changing the
  // read-side "no formula" sentinel check from `> 0` to `>= 0` (which would
  // make every row with no formula answer the *first* interned string instead
  // of `undefined`, since the 0 slot is `formula`'s explicit "unset" value —
  // see `@ifc-lite/data`'s `quantityTableFromColumns`) still passed the full
  // suite. This pins both the present and absent cases.
  it('preserves a present formula and answers undefined when none was set', () => {
    const strings = new StringTable();
    const builder = new QuantityTableBuilder(strings);
    builder.add({
      entityId: 1,
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'NetArea',
      quantityType: QuantityType.Area,
      value: 10,
      formula: 'Length * Height',
    });
    builder.add({
      entityId: 2,
      qsetName: 'Qto_WallBaseQuantities',
      quantityName: 'GrossVolume',
      quantityType: QuantityType.Volume,
      value: 5,
    });
    const table = builder.build();
    const restored = roundTrip(strings, table);

    const qsets = restored.getForEntity(1);
    const netArea = qsets[0].quantities.find((q) => q.name === 'NetArea');
    expect(netArea?.formula).toBe('Length * Height');

    const qsets2 = restored.getForEntity(2);
    const grossVolume = qsets2[0].quantities.find((q) => q.name === 'GrossVolume');
    expect(grossVolume?.formula).toBeUndefined();
  });
});

describe('cache QuantityTable.sumByType', () => {
  it('sums across entities when no elementType is given (unfiltered)', () => {
    const { strings, table } = buildFixture();
    const restored = roundTrip(strings, table);
    // Fixture property: both rows are included, so the sum is neither row's
    // value alone — this pins down that "unfiltered" really means "all rows".
    expect(restored.sumByType('NetArea')).toBeCloseTo(110);
  });

  it('throws when elementType is passed, instead of silently ignoring it', () => {
    const { strings, table } = buildFixture();
    const restored = roundTrip(strings, table);
    expect(() => restored.sumByType('NetArea', 42)).toThrow(/elementType/);
  });
});


describe('cache QuantityTable.getForEntity distinct-instance grouping (parity with @ifc-lite/data)', () => {
  it('keeps two distinct same-named qset instances separate after a cache round-trip, matching the fresh-parse result', () => {
    // Same fixture shape as `@ifc-lite/data`'s
    // `quantity-table.test.ts` ("keeps two distinct qset INSTANCES that
    // share a literal name separate, not merged"): a federated merge, or an
    // exporter emitting the same Qto_ set twice on one element, puts two
    // rows on one entity whose qsetName is identical but whose
    // qsetGlobalId differs. `readQuantities`'s `getForEntity` must key on
    // (qsetName, qsetGlobalId), same as the columnar implementation, or a
    // cache-loaded model answers differently than a fresh parse.
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

    // Parity assertion: the cache-loaded result must equal the fresh-parse
    // result for this fixture -- that is the guard that actually prevents
    // the two grouping loops from re-diverging, not just this one fixture
    // passing.
    const fresh = table.getForEntity(100);
    const restored = roundTrip(strings, table).getForEntity(100);
    expect(restored).toEqual(fresh);

    expect(restored).toHaveLength(2);
    const byGlobalId = new Map(restored.map((s) => [s.globalId, s]));
    expect(byGlobalId.get('gid-AAA')?.quantities).toEqual([
      { name: 'NetVolume', type: QuantityType.Volume, value: 1.25, formula: undefined },
    ]);
    expect(byGlobalId.get('gid-BBB')?.quantities).toEqual([
      { name: 'NetArea', type: QuantityType.Area, value: 5.0, formula: undefined },
    ]);
  });
});
