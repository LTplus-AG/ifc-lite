/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `EntityQuery.whereProperty()` must answer the same ids whichever strategy the
 * store selects: the on-demand path taken by a STEP parse (see
 * `where-property-fallback.test.ts` for the defect this fixes) or the indexed
 * path taken by a table-backed store (IFCX / cache restore).
 *
 * The fixture is built two independent ways in `where-property-fixtures.ts`,
 * and both are held to the same written-out expectations here.
 */

import { describe, it, expect, vi } from 'vitest';
import { IfcTypeEnum, type IfcStoreBase } from '@ifc-lite/data';
import { type ComparisonOperator } from '../src/entity-query.js';
import {
  parseStepFixture,
  createTableBackedStore,
  runFilters,
  WALL,
  SLAB,
  type Filter,
} from './where-property-fixtures.js';

/**
 * Expectations are written out per case and asserted against BOTH store shapes.
 * Nothing here is derived from one strategy and compared to the other.
 */
describe('whereProperty answers the same concrete ids on a STEP store and a table-backed store', () => {
  interface Probe {
    filters: Filter[];
    expected: number[];
  }
  interface Case {
    label: string;
    type: IfcTypeEnum;
    /** At least one probe must expect a non-empty result (asserted below). */
    probes: Probe[];
  }

  const p = (pset: string, prop: string, op: ComparisonOperator, value: string | number | boolean): Filter => ({ pset, prop, op, value });

  const cases: Case[] = [
    { label: '= string', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'FireRating', '=', 'REI60')], expected: [10] },
      { filters: [p('Pset_WallCommon', 'FireRating', '=', 'REI30')], expected: [11] },
    ] },
    { label: '!= string', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'FireRating', '!=', 'REI60')], expected: [11] },
    ] },
    { label: 'contains', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'FireRating', 'contains', 'REI')], expected: [10, 11] },
      { filters: [p('Pset_WallCommon', 'FireRating', 'contains', '60')], expected: [10] },
    ] },
    { label: 'startsWith', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'Reference', 'startsWith', 'W-')], expected: [10] },
      { filters: [p('Pset_WallCommon', 'Reference', 'startsWith', 'X-')], expected: [] },
    ] },
    { label: '= boolean', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'IsExternal', '=', true)], expected: [10] },
      { filters: [p('Pset_WallCommon', 'IsExternal', '=', false)], expected: [11] },
    ] },
    { label: '!= boolean', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'IsExternal', '!=', true)], expected: [11] },
    ] },
    { label: 'numeric comparisons', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'ThermalTransmittance', '>', 0.1)], expected: [10] },
      { filters: [p('Pset_WallCommon', 'ThermalTransmittance', '>=', 0.24)], expected: [10] },
      { filters: [p('Pset_WallCommon', 'ThermalTransmittance', '<', 0.24)], expected: [] },
      { filters: [p('Pset_WallCommon', 'ThermalTransmittance', '<=', 0.24)], expected: [10] },
    ] },
    { label: 'duplicate property name across two same-named sets (ANY-match)', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'Status', '=', 'New')], expected: [11] },
      { filters: [p('Pset_WallCommon', 'Status', '=', 'Demolish')], expected: [11] },
    ] },
    { label: 'unknown property set', type: WALL, probes: [
      { filters: [p('Pset_Nope', 'FireRating', '=', 'REI60')], expected: [] },
      // Control in the same case, so the case still bites.
      { filters: [p('Pset_WallCommon', 'FireRating', '=', 'REI60')], expected: [10] },
    ] },
    { label: 'unknown property', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'Nope', '=', 1)], expected: [] },
      { filters: [p('Pset_WallCommon', 'IsExternal', '=', true)], expected: [10] },
    ] },
    { label: 'cross-type value is not coerced', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'ThermalTransmittance', '=', '0.24')], expected: [] },
      { filters: [p('Pset_WallCommon', 'ThermalTransmittance', '=', 0.24)], expected: [10] },
    ] },
    { label: 'quantity >', type: WALL, probes: [
      { filters: [p('Qto_WallBaseQuantities', 'Length', '>', 4)], expected: [10] },
      { filters: [p('Qto_WallBaseQuantities', 'Length', '>', 6)], expected: [] },
    ] },
    { label: 'quantity =', type: WALL, probes: [
      { filters: [p('Qto_WallBaseQuantities', 'NetSideArea', '=', 12.5)], expected: [10] },
    ] },
    { label: 'a quantity-set name is scoped like a property-set name', type: WALL, probes: [
      { filters: [p('Qto_SlabBaseQuantities', 'Length', '>', 4)], expected: [] },
      { filters: [p('Qto_WallBaseQuantities', 'Length', '>', 4)], expected: [10] },
    ] },
    { label: 'two filters ANDed', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'IsExternal', '=', true), p('Pset_WallCommon', 'FireRating', '=', 'REI60')], expected: [10] },
      { filters: [p('Pset_WallCommon', 'IsExternal', '=', true), p('Pset_WallCommon', 'FireRating', '=', 'REI30')], expected: [] },
    ] },
    { label: 'a property filter ANDed with a quantity filter', type: WALL, probes: [
      { filters: [p('Pset_WallCommon', 'IsExternal', '=', true), p('Qto_WallBaseQuantities', 'Length', '>', 4)], expected: [10] },
      { filters: [p('Pset_WallCommon', 'IsExternal', '=', false), p('Qto_WallBaseQuantities', 'Length', '>', 4)], expected: [] },
    ] },
    { label: 'property-set scoping across types', type: SLAB, probes: [
      { filters: [p('Pset_WallCommon', 'FireRating', '=', 'REI60')], expected: [] },
      { filters: [p('Pset_SlabCommon', 'FireRating', '=', 'REI60')], expected: [12] },
    ] },
    { label: '!= against entities with no sets at all', type: WALL, probes: [
      // Wall C (#13) has no sets; it must not be swept in by `!=`.
      { filters: [p('Pset_WallCommon', 'FireRating', '!=', 'REI60')], expected: [11] },
    ] },
  ];

  for (const { label, type, probes } of cases) {
    it(label, async () => {
      // Guard against a table of purely negative expectations, which an
      // implementation that matches nothing would satisfy.
      expect(probes.some((probe) => probe.expected.length > 0)).toBe(true);

      const stepStore = await parseStepFixture();
      const tableStore = createTableBackedStore();
      expect(stepStore.properties.count).toBe(0);
      expect(tableStore.properties.count).toBeGreaterThan(0);

      for (const { filters, expected } of probes) {
        expect(await runFilters(stepStore, type, filters)).toEqual(expected);
        expect(await runFilters(tableStore, type, filters)).toEqual(expected);
      }
    });
  }

  it('the two fixtures carry the same (set, name, value) triples', async () => {
    // Justifies holding both to one set of expectations: they are built
    // independently (STEP text vs table builders), so if they drifted, the
    // shared expectations above would be pinning two different models.
    //
    // Compared as flattened triples rather than as set objects, because the two
    // shapes group differently and legitimately so: the columnar
    // `getForEntity` keys sets by NAME, so wall #11's two distinct same-named
    // `Pset_WallCommon` sets come back as one set of four properties, while the
    // STEP on-demand extractor returns them as two sets. ANY-match reads every
    // property either way, which is why the filter results agree.
    const flatten = (store: IfcStoreBase, id: number) => [
      ...store.getProperties(id).flatMap((s) => s.properties.map((prop) => `P|${s.name}|${prop.name}|${String(prop.value)}`)),
      ...store.getQuantities(id).flatMap((s) => s.quantities.map((q) => `Q|${s.name}|${q.name}|${q.value}`)),
    ].sort();

    const stepStore = await parseStepFixture();
    const tableStore = createTableBackedStore();
    for (const id of [10, 11, 12, 13]) {
      expect(flatten(tableStore, id)).toEqual(flatten(stepStore, id));
    }
    // Not vacuous: the walls really do carry rows.
    expect(flatten(stepStore, 10).length).toBe(6);
    expect(flatten(stepStore, 13)).toEqual([]);
  });
});

describe('whereProperty on a store whose tables are populated (IFCX / cache shape)', () => {
  it('folds quantities on the table path too', async () => {
    // The quantity side is answered off `QuantityTable.findByQuantity`; before
    // that existed, a Qto_ filter matched nothing on the table path either.
    const store = createTableBackedStore();
    expect(await runFilters(store, WALL, [{ pset: 'Qto_WallBaseQuantities', prop: 'Length', op: '>', value: 4 }])).toEqual([10]);
    expect(await runFilters(store, WALL, [{ pset: 'Qto_WallBaseQuantities', prop: 'NetSideArea', op: '<', value: 20 }])).toEqual([10]);
    expect(await runFilters(store, WALL, [{ pset: 'Qto_WallBaseQuantities', prop: 'NetSideArea', op: '<', value: 5 }])).toEqual([]);
  });

  it('answers off the indices, never per candidate', async () => {
    // NOTE: this pins the STRATEGY, not the ids. An implementation that
    // resolved every candidate would return the same entities, so nothing here
    // would catch it by comparing results; the assertions below watch which
    // accessors were called instead, which is why reverting the filter fix does
    // fail this test.
    //
    // It is here because the two paths scale on different quantities. The index
    // answers a filter from the rows carrying that quantity name, so its cost
    // tracks how much of the model actually uses the name. Resolving per
    // candidate instead extracts the quantity sets of each candidate not
    // already matched on the property side, so its cost tracks the candidate
    // count and the size of those sets, which on an unscoped filter over a
    // quantity-heavy model is most of the model whether or not a single row
    // carries the name.
    const store = createTableBackedStore();
    const findByProperty = vi.spyOn(store.properties, 'findByProperty');
    const findByQuantity = vi.spyOn(store.quantities, 'findByQuantity' as never);
    const getProperties = vi.spyOn(store, 'getProperties');
    const getQuantities = vi.spyOn(store, 'getQuantities');

    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI60' }])).toEqual([10]);

    expect(findByProperty).toHaveBeenCalledWith('FireRating', '=', 'REI60', 'Pset_WallCommon');
    expect(findByQuantity).toHaveBeenCalledWith('FireRating', '=', 'REI60', 'Pset_WallCommon');
    expect(getProperties).not.toHaveBeenCalled();
    expect(getQuantities).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
