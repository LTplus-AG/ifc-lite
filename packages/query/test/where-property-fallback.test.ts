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
 * same written-out expectations, which is what makes the two strategies
 * interchangeable — no expectation is derived from the other strategy, so a
 * test cannot pass by both strategies being equally broken.
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
 *   #11 in the fixture below is exactly that case, and the disagreement is
 *   pinned by a test so neither side gets "fixed" into the other by accident.
 */

import { describe, it, expect, vi } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import {
  IfcTypeEnum,
  type IfcStoreBase,
  type PropertyValue,
  type QuantitySet,
} from '@ifc-lite/data';
import { EntityQuery, type ComparisonOperator } from '../src/entity-query.js';
import { EntityNode } from '../src/entity-node.js';
import {
  createMockStore,
  PropertyValueType,
  QuantityType,
  type MockProperty,
  type MockQuantity,
} from './mock-store.js';

// Three walls plus a slab.
//   #10 wall A: Pset_WallCommon with FireRating/IsExternal/ThermalTransmittance/
//               Reference, plus Qto_WallBaseQuantities.
//   #11 wall B: Pset_WallCommon with FireRating/IsExternal, and the `Status`
//               property TWICE across two same-named property sets. This is the
//               ANY-match vs FIRST-match case.
//   #12 slab:   FireRating 'REI60' in Pset_SlabCommon, so property-set scoping
//               has something to exclude.
//   #13 wall C: no property sets at all — absence must never match, not even
//               with `!=`.
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-a-guid',#1,'Wall A',$,$,$,$,$);
#11=IFCWALLSTANDARDCASE('wall-b-guid',#1,'Wall B',$,$,$,$,$);
#12=IFCSLAB('slab-guid',#1,'Slab A',$,$,$,$,$,$);
#13=IFCWALLSTANDARDCASE('wall-c-guid',#1,'Wall C',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('FireRating',$,'REI60',$);
#21=IFCPROPERTYSINGLEVALUE('IsExternal',$,.T.,$);
#22=IFCPROPERTYSINGLEVALUE('ThermalTransmittance',$,0.24,$);
#23=IFCPROPERTYSINGLEVALUE('Reference',$,'W-01',$);
#30=IFCPROPERTYSET('pset-a-guid',#1,'Pset_WallCommon',$,(#20,#21,#22,#23));
#40=IFCRELDEFINESBYPROPERTIES('rel-a-guid',#1,$,$,(#10),#30);
#24=IFCPROPERTYSINGLEVALUE('FireRating',$,'REI30',$);
#25=IFCPROPERTYSINGLEVALUE('IsExternal',$,.F.,$);
#26=IFCPROPERTYSINGLEVALUE('Status',$,'New',$);
#31=IFCPROPERTYSET('pset-b-guid',#1,'Pset_WallCommon',$,(#24,#25,#26));
#41=IFCRELDEFINESBYPROPERTIES('rel-b-guid',#1,$,$,(#11),#31);
#27=IFCPROPERTYSINGLEVALUE('Status',$,'Demolish',$);
#32=IFCPROPERTYSET('pset-c-guid',#1,'Pset_WallCommon',$,(#27));
#42=IFCRELDEFINESBYPROPERTIES('rel-c-guid',#1,$,$,(#11),#32);
#28=IFCPROPERTYSINGLEVALUE('FireRating',$,'REI60',$);
#33=IFCPROPERTYSET('pset-d-guid',#1,'Pset_SlabCommon',$,(#28));
#43=IFCRELDEFINESBYPROPERTIES('rel-d-guid',#1,$,$,(#12),#33);
#50=IFCQUANTITYLENGTH('Length',$,$,5.0);
#51=IFCQUANTITYAREA('NetSideArea',$,$,12.5);
#60=IFCELEMENTQUANTITY('qto-guid',#1,'Qto_WallBaseQuantities',$,$,(#50,#51));
#70=IFCRELDEFINESBYPROPERTIES('qto-rel-guid',#1,$,$,(#10),#60);`;

/** Parse the fixture the way the viewer/CLI do: STEP scan then `parseLite`. */
async function parseStepFixture(): Promise<IfcStoreBase> {
  const source = new TextEncoder().encode(IFC);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: Array<{
    expressId: number;
    type: string;
    byteOffset: number;
    byteLength: number;
    lineNumber: number;
  }> = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0), entityRefs, {});
}

/**
 * The same model as a table-backed store — real `PropertyTableBuilder` /
 * `QuantityTableBuilder` rows, i.e. the IFCX and cache-restore shape.
 */
function createTableBackedStore(): IfcStoreBase {
  const properties: MockProperty[] = [
    { entityId: 10, psetName: 'Pset_WallCommon', propName: 'FireRating', propType: PropertyValueType.String, value: 'REI60' },
    { entityId: 10, psetName: 'Pset_WallCommon', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: true },
    { entityId: 10, psetName: 'Pset_WallCommon', propName: 'ThermalTransmittance', propType: PropertyValueType.Real, value: 0.24 },
    { entityId: 10, psetName: 'Pset_WallCommon', propName: 'Reference', propType: PropertyValueType.String, value: 'W-01' },
    { entityId: 11, psetName: 'Pset_WallCommon', propName: 'FireRating', propType: PropertyValueType.String, value: 'REI30' },
    { entityId: 11, psetName: 'Pset_WallCommon', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: false },
    { entityId: 11, psetName: 'Pset_WallCommon', propName: 'Status', propType: PropertyValueType.String, value: 'New' },
    { entityId: 11, psetName: 'Pset_WallCommon', propName: 'Status', propType: PropertyValueType.String, value: 'Demolish' },
    { entityId: 12, psetName: 'Pset_SlabCommon', propName: 'FireRating', propType: PropertyValueType.String, value: 'REI60' },
  ];
  const quantities: MockQuantity[] = [
    { entityId: 10, qsetName: 'Qto_WallBaseQuantities', quantityName: 'Length', quantityType: QuantityType.Length, value: 5.0 },
    { entityId: 10, qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetSideArea', quantityType: QuantityType.Area, value: 12.5 },
  ];
  return createMockStore({
    entities: [
      { expressId: 10, type: 'IFCWALLSTANDARDCASE', globalId: 'wall-a-guid', name: 'Wall A' },
      { expressId: 11, type: 'IFCWALLSTANDARDCASE', globalId: 'wall-b-guid', name: 'Wall B' },
      { expressId: 12, type: 'IFCSLAB', globalId: 'slab-guid', name: 'Slab A' },
      // Wall C carries no rows at all, the same as in the STEP fixture.
      { expressId: 13, type: 'IFCWALLSTANDARDCASE', globalId: 'wall-c-guid', name: 'Wall C' },
    ],
    properties,
    quantities,
  });
}

interface Filter {
  pset: string;
  prop: string;
  op: ComparisonOperator;
  value: string | number | boolean;
}

function build(store: IfcStoreBase, type: IfcTypeEnum, filters: Filter[]): EntityQuery {
  const query = new EntityQuery(store, [type]);
  for (const f of filters) query.whereProperty(f.pset, f.prop, f.op, f.value);
  return query;
}

async function runFilters(store: IfcStoreBase, type: IfcTypeEnum, filters: Filter[]): Promise<number[]> {
  const ids = await build(store, type, filters).ids();
  return ids.sort((a, b) => a - b);
}

const WALL = IfcTypeEnum.IfcWallStandardCase;
const SLAB = IfcTypeEnum.IfcSlab;

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
    // NOTE: a cost contract, not a correctness one — an implementation that
    // resolved every candidate returns the same ids, so this does not fail when
    // the filter fix is reverted. It is here because the per-candidate path is
    // O(candidates x extraction), and folding quantities that way made an
    // unscoped filter on a 153,815-quantity-row model ~30x slower until
    // `findByQuantity` existed.
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

/**
 * `count` and `findByQuantity` are OPTIONAL members of the property/quantity
 * tables on `IfcStoreBase`, and @ifc-lite/data is published: stores written
 * against the interface before those members existed must keep working. These
 * pin what omitting them does.
 */
describe('whereProperty on duck-typed stores that omit the optional table members', () => {
  /** A store implementing the required members only, plus what the flags add. */
  function createMinimalStore(opts: { withCount: boolean; withFindByQuantity?: boolean }): IfcStoreBase {
    const rows: Array<{ id: number; pset: string; prop: string; value: PropertyValue }> = [
      { id: 1, pset: 'Pset_WallCommon', prop: 'IsExternal', value: true },
      { id: 2, pset: 'Pset_WallCommon', prop: 'IsExternal', value: false },
    ];
    const qsets = new Map<number, QuantitySet[]>([
      [1, [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', type: QuantityType.Length, value: 5 }] }]],
      [2, [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', type: QuantityType.Length, value: 1 }] }]],
    ]);
    const properties = {
      ...(opts.withCount ? { count: rows.length } : {}),
      getForEntity: (id: number) => {
        const own = rows.filter((r) => r.id === id);
        return own.length === 0
          ? []
          : [{ name: own[0].pset, globalId: '', properties: own.map((r) => ({ name: r.prop, type: PropertyValueType.Boolean, value: r.value })) }];
      },
      getPropertyValue: (id: number, pset: string, prop: string) =>
        rows.find((r) => r.id === id && r.pset === pset && r.prop === prop)?.value ?? null,
      findByProperty: (prop: string, op: string, value: PropertyValue, pset?: string) =>
        rows
          .filter((r) => r.prop === prop && (pset === undefined || r.pset === pset) && op === '=' && r.value === value)
          .map((r) => r.id),
    };
    const quantities = {
      ...(opts.withCount ? { count: 2 } : {}),
      getForEntity: (id: number) => qsets.get(id) ?? [],
      ...(opts.withFindByQuantity
        ? {
            findByQuantity: (name: string, op: string, value: PropertyValue, qset?: string) =>
              [...qsets.entries()]
                .filter(([, sets]) =>
                  sets.some(
                    (s) =>
                      (qset === undefined || s.name === qset) &&
                      s.quantities.some((q) => q.name === name && op === '>' && typeof value === 'number' && q.value > value),
                  ),
                )
                .map(([id]) => id),
          }
        : {}),
    };
    return {
      schemaVersion: 'IFC4',
      entityCount: 2,
      fileSize: 0,
      entities: {
        count: 2,
        expressId: [1, 2],
        getGlobalId: () => '',
        getName: () => '',
        getDescription: () => '',
        getObjectType: () => '',
        getTypeName: () => 'IFCWALL',
        getByType: () => [1, 2],
      },
      relationships: {
        forward: { getEdges: () => [] },
        inverse: { getEdges: () => [] },
        getRelated: () => [],
      },
      properties,
      quantities,
      entityIndex: { byId: new Map(), byType: new Map() },
      getEntity: () => null,
      getEntitiesByType: () => [],
      getProperties: (id: number) => properties.getForEntity(id),
      getQuantities: (id: number) => quantities.getForEntity(id),
    } as unknown as IfcStoreBase;
  }

  it('a table without `count` still answers through findByProperty', async () => {
    // `count` is new on this interface. Reading a missing `count` as zero would
    // route every store written against the older interface to the on-demand
    // fallback, silently returning [] for stores whose `findByProperty` works.
    const store = createMinimalStore({ withCount: false });
    const spy = vi.spyOn(store.properties, 'findByProperty');
    expect(await runFilters(store, IfcTypeEnum.IfcWall, [{ pset: 'Pset_WallCommon', prop: 'IsExternal', op: '=', value: true }])).toEqual([1]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a table reporting a count answers identically', async () => {
    const store = createMinimalStore({ withCount: true });
    expect(await runFilters(store, IfcTypeEnum.IfcWall, [{ pset: 'Pset_WallCommon', prop: 'IsExternal', op: '=', value: true }])).toEqual([1]);
  });

  it('a quantity table without findByQuantity is resolved per candidate instead', async () => {
    // Omitting the optional index must cost work, never correctness.
    const withoutIndex = createMinimalStore({ withCount: true, withFindByQuantity: false });
    const spy = vi.spyOn(withoutIndex, 'getQuantities');
    expect(await runFilters(withoutIndex, IfcTypeEnum.IfcWall, [{ pset: 'Qto_WallBaseQuantities', prop: 'Length', op: '>', value: 3 }])).toEqual([1]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const withIndex = createMinimalStore({ withCount: true, withFindByQuantity: true });
    const spy2 = vi.spyOn(withIndex, 'getQuantities');
    expect(await runFilters(withIndex, IfcTypeEnum.IfcWall, [{ pset: 'Qto_WallBaseQuantities', prop: 'Length', op: '>', value: 3 }])).toEqual([1]);
    expect(spy2).not.toHaveBeenCalled();
    spy2.mockRestore();
  });
});
