/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for `EntityQuery.whereProperty()` on STEP-parsed stores.
 *
 * `parseColumnar` / `parseLite` deliberately leave the pre-parsed property and
 * quantity tables empty (issue #577) and route reads through the on-demand
 * maps. `applyPropertyFilters` only consulted `store.properties.findByProperty`,
 * which on such a store can only ever return `[]` — so every `whereProperty`
 * call against a `.ifc` file silently matched nothing, for any property-set
 * name, with no error and no warning. The read path (`EntityNode.property`,
 * `QueryResultEntity.getProperty`) resolved the same data correctly, so a
 * `.ifc` model that plainly carried the property still filtered to nothing.
 *
 * What is pinned here: the **concrete id sets** `whereProperty` returns on a
 * STEP-parsed (on-demand) store. The table-backed store is asserted against the
 * same written-out expectations in `where-property-parity.test.ts`, which is
 * what makes the two strategies interchangeable — no expectation is derived
 * from the other strategy, so a test cannot pass by both strategies being
 * equally broken.
 *
 * Semantics that ship, stated plainly because they are not self-evident:
 *
 * - The filter is **ANY-match**: an entity passes when *any* property of that
 *   name, in *any* set of that name, satisfies the operator. That is what
 *   `PropertyTable.findByProperty` does (it walks every row carrying the
 *   property name), so both strategies agree with each other.
 * - The single-value read path is **FIRST-match**: `EntityNode.property` and
 *   `QueryResultEntity.getProperty` return the first set/property they find.
 * - For an entity carrying the same property twice, those two disagree. Wall
 *   #11 in the shared fixture is exactly that case, and the disagreement is
 *   pinned by a test so neither side gets "fixed" into the other by accident.
 *
 * The fixture itself lives in `where-property-fixtures.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { EntityNode } from '../src/entity-node.js';
import {
  parseStepFixture,
  build,
  runFilters,
  WALL,
  SLAB,
  type Filter,
} from './where-property-fixtures.js';

describe('EntityQuery.whereProperty on STEP-parsed stores (issue #577 follow-up)', () => {
  it('matches string properties resolved through the on-demand map', async () => {
    const store = await parseStepFixture();
    // Guard: this really is the empty-table shape the defect lived in.
    expect(store.properties.count).toBe(0);

    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI60' }])).toEqual([10]);
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI30' }])).toEqual([11]);
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: 'startsWith', value: 'REI' }])).toEqual([10, 11]);
  });

  it('matches boolean and numeric properties', async () => {
    const store = await parseStepFixture();
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'IsExternal', op: '=', value: true }])).toEqual([10]);
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'IsExternal', op: '=', value: false }])).toEqual([11]);
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'ThermalTransmittance', op: '<', value: 0.3 }])).toEqual([10]);
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'ThermalTransmittance', op: '>', value: 0.3 }])).toEqual([]);
  });

  it('reads back the same value it filtered on (EntityNode.property)', async () => {
    const store = await parseStepFixture();
    expect(new EntityNode(store, 10).property('Pset_WallCommon', 'FireRating')).toBe('REI60');
    expect(new EntityNode(store, 11).property('Pset_WallCommon', 'FireRating')).toBe('REI30');
    // Filtering on the read value returns exactly the entity it was read from.
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI60' }])).toEqual([10]);
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI30' }])).toEqual([11]);
  });

  it('filters ANY-match while the read path is FIRST-match, and they disagree on a duplicated property', async () => {
    // Wall #11 carries `Status` twice, in two distinct but same-named
    // `Pset_WallCommon` sets ('New' in #31, 'Demolish' in #32).
    //
    // The read path (`EntityNode.property`, `QueryResultEntity.getProperty`)
    // returns the FIRST it finds. The filter walks every row, exactly like
    // `PropertyTable.findByProperty`, so it matches BOTH values. That is the
    // shipped behaviour: the filter agrees with `findByProperty`, not with the
    // single-value getter. Changing either side to match the other breaks this
    // test on purpose.
    const store = await parseStepFixture();

    expect(new EntityNode(store, 11).property('Pset_WallCommon', 'Status')).toBe('New');

    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'Status', op: '=', value: 'New' }])).toEqual([11]);
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'Status', op: '=', value: 'Demolish' }])).toEqual([11]);
    // A value carried by neither set still matches nothing.
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'Status', op: '=', value: 'Existing' }])).toEqual([]);
  });

  it('scopes to the named property set (a same-named property elsewhere does not match)', async () => {
    const store = await parseStepFixture();
    // #12 (slab) carries FireRating 'REI60' too, but in Pset_SlabCommon.
    expect(await runFilters(store, SLAB, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI60' }])).toEqual([]);
    expect(await runFilters(store, SLAB, [{ pset: 'Pset_SlabCommon', prop: 'FireRating', op: '=', value: 'REI60' }])).toEqual([12]);
    // ...and the wall's REI60 is not reachable through the slab's set name.
    expect(await runFilters(store, WALL, [{ pset: 'Pset_SlabCommon', prop: 'FireRating', op: '=', value: 'REI60' }])).toEqual([]);
  });

  it('an unknown set or property name matches nothing, while the known one still matches', async () => {
    const store = await parseStepFixture();
    expect(await runFilters(store, WALL, [{ pset: 'Pset_DoesNotExist', prop: 'FireRating', op: '=', value: 'REI60' }])).toEqual([]);
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'NoSuchProp', op: '=', value: 'x' }])).toEqual([]);
    // Control in the same test: with the real names the answer is not empty, so
    // an implementation that matches nothing cannot satisfy this.
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI60' }])).toEqual([10]);
  });

  it('absence never matches, not even with != (wall C has no property sets)', async () => {
    const store = await parseStepFixture();
    // Wall C (#13) carries no sets. `!=` must not sweep it in.
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '!=', value: 'REI60' }])).toEqual([11]);
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '!=', value: 'REI30' }])).toEqual([10]);
  });

  it('folds quantities in, making the documented Qto_ example true (docs/guide/querying.md)', async () => {
    const store = await parseStepFixture();
    expect(await runFilters(store, WALL, [{ pset: 'Qto_WallBaseQuantities', prop: 'Length', op: '>', value: 4 }])).toEqual([10]);
    expect(await runFilters(store, WALL, [{ pset: 'Qto_WallBaseQuantities', prop: 'NetSideArea', op: '>', value: 10 }])).toEqual([10]);
    expect(await runFilters(store, WALL, [{ pset: 'Qto_WallBaseQuantities', prop: 'NetSideArea', op: '>', value: 20 }])).toEqual([]);
    // Quantity values are numbers; a string filter value is not coerced.
    expect(await runFilters(store, WALL, [{ pset: 'Qto_WallBaseQuantities', prop: 'NetSideArea', op: '=', value: '12.5' }])).toEqual([]);
  });

  it('ANDs multiple filters, and execute()/ids()/count()/first() agree', async () => {
    const store = await parseStepFixture();
    const both: Filter[] = [
      { pset: 'Pset_WallCommon', prop: 'IsExternal', op: '=', value: true },
      { pset: 'Qto_WallBaseQuantities', prop: 'Length', op: '>', value: 4 },
    ];
    expect(await runFilters(store, WALL, both)).toEqual([10]);

    // Contradictory filters (IsExternal is true only on #10, FireRating REI30
    // only on #11) intersect to nothing.
    expect(
      await runFilters(store, WALL, [
        { pset: 'Pset_WallCommon', prop: 'IsExternal', op: '=', value: true },
        { pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI30' },
      ]),
    ).toEqual([]);

    expect(build(store, WALL, both).execute().map((e) => e.expressId)).toEqual([10]);
    expect(await build(store, WALL, both).count()).toBe(1);
    expect((await build(store, WALL, both).first())?.expressId).toBe(10);
  });

  it('answers without populating store.properties (IDS reads the table first)', async () => {
    // packages/ids/src/bridge/properties.ts prefers `store.properties` whenever
    // it has rows, because a PropertyRow cannot carry dataType/values[].
    // Materialising the table here would silently downgrade IDS unit conversion
    // (#1573) and any-match candidates (#1766).
    const store = await parseStepFixture();
    expect(await runFilters(store, WALL, [{ pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI60' }])).toEqual([10]);
    expect(store.properties.count).toBe(0);
    expect(store.quantities?.count ?? 0).toBe(0);
  });

  it('tripwire: a parseLite store never has both table rows and on-demand rows', async () => {
    // NOTE: this asserts a property of the PARSER, not of
    // `applyPropertyFilters`, so it holds with or without the filter fix and is
    // deliberately not part of the mutation-checked set. It exists because
    // `applyPropertyFilters` discriminates on `store.properties.count === 0`,
    // which is only sound while the two shapes are mutually exclusive. If a
    // later change starts materialising the table at parse time, this fails
    // first and points at the discriminator rather than at a silently wrong
    // filter result.
    const store = await parseStepFixture();
    const onDemandRows = store.onDemandPropertyMap?.size ?? 0;
    expect(store.properties.count > 0 && onDemandRows > 0).toBe(false);
    expect(onDemandRows).toBeGreaterThan(0);
  });

  it('resolves each candidate at most once across multiple filters', async () => {
    const store = await parseStepFixture();
    const spy = vi.spyOn(store, 'getProperties');
    expect(
      await runFilters(store, WALL, [
        { pset: 'Pset_WallCommon', prop: 'IsExternal', op: '=', value: true },
        { pset: 'Pset_WallCommon', prop: 'FireRating', op: '=', value: 'REI60' },
      ]),
    ).toEqual([10]);
    const distinct = new Set(spy.mock.calls.map((c) => c[0]));
    // All three walls are resolved, and none of them twice.
    expect(distinct.size).toBe(3);
    expect(spy.mock.calls.length).toBe(distinct.size);
    spy.mockRestore();
  });
});
