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
