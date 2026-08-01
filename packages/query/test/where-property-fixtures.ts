/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared fixtures for the `EntityQuery.whereProperty()` regression suites
 * (`where-property-fallback.test.ts`, `where-property-parity.test.ts`,
 * `where-property-duck-typed.test.ts`).
 *
 * The same four-element model is built two independent ways — as STEP text
 * parsed with `parseLite` (the on-demand shape) and as real
 * `PropertyTableBuilder` / `QuantityTableBuilder` rows (the IFCX and
 * cache-restore shape) — so the two strategies can be held to one set of
 * written-out expectations. `where-property-parity.test.ts` asserts that the
 * two really do carry the same data.
 */

import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import {
  IfcTypeEnum,
  type IfcStoreBase,
  type PropertyValue,
  type QuantitySet,
} from '@ifc-lite/data';
import { EntityQuery, type ComparisonOperator } from '../src/entity-query.js';
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
export async function parseStepFixture(): Promise<IfcStoreBase> {
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
export function createTableBackedStore(): IfcStoreBase {
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

export interface Filter {
  pset: string;
  prop: string;
  op: ComparisonOperator;
  value: string | number | boolean;
}

export function build(store: IfcStoreBase, type: IfcTypeEnum, filters: Filter[]): EntityQuery {
  const query = new EntityQuery(store, [type]);
  for (const f of filters) query.whereProperty(f.pset, f.prop, f.op, f.value);
  return query;
}

export async function runFilters(store: IfcStoreBase, type: IfcTypeEnum, filters: Filter[]): Promise<number[]> {
  const ids = await build(store, type, filters).ids();
  return ids.sort((a, b) => a - b);
}

export const WALL = IfcTypeEnum.IfcWallStandardCase;
export const SLAB = IfcTypeEnum.IfcSlab;

/**
 * A store implementing the required `IfcStoreBase` members only, plus what the
 * flags add. `count` and `findByQuantity` are OPTIONAL members of the
 * property/quantity tables, so this is the shape of a third-party store written
 * against the interface before those members existed.
 */
export function createMinimalStore(opts: {
  withCount: boolean;
  withFindByQuantity?: boolean;
  /** Overrides the quantity table's own row count, so the two tables can disagree. */
  quantityCount?: number;
  /** Makes `findByQuantity` answer like a genuinely empty index: always `[]`. */
  emptyQuantityIndex?: boolean;
}): IfcStoreBase {
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
  const quantityCount = opts.quantityCount ?? (opts.withCount ? 2 : undefined);
  const quantities = {
    ...(quantityCount === undefined ? {} : { count: quantityCount }),
    getForEntity: (id: number) => qsets.get(id) ?? [],
    ...(opts.withFindByQuantity
      ? {
          findByQuantity: (name: string, op: string, value: PropertyValue, qset?: string) =>
            opts.emptyQuantityIndex ? [] : [...qsets.entries()]
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
