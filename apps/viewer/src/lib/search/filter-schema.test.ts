/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  PropertyValueType,
  QuantityType,
} from '@ifc-lite/data';
import type { SpatialHierarchy } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import { discoverFilterSchema, discoverPropertyAndQuantitySchema } from './filter-schema.js';

interface EntityRow {
  expressId: number;
  type: string;
  globalId: string;
  name: string;
}

/**
 * Build an in-memory IfcDataStore that exercises the schema discovery
 * fallbacks: empty `source` so the on-demand extractors short-circuit
 * to the pre-computed PropertyTable / QuantityTable lookup.
 */
function buildStore(args: {
  entities: EntityRow[];
  storeys?: Array<{ id: number; name: string; elevation?: number }>;
  elementToStorey?: Array<[number, number]>;
  psetRows?: Array<{ entityId: number; psetName: string; propName: string }>;
  qtoRows?: Array<{ entityId: number; qsetName: string; quantityName: string }>;
}): IfcDataStore {
  const strings = new StringTable();
  const builder = new EntityTableBuilder(args.entities.length, strings);
  for (const r of args.entities) {
    builder.add(r.expressId, r.type, r.globalId, r.name, '', '', false, false);
  }
  const entities = builder.build();

  const propertyBuilder = new PropertyTableBuilder(strings);
  for (const r of args.psetRows ?? []) {
    propertyBuilder.add({
      entityId: r.entityId,
      psetName: r.psetName,
      psetGlobalId: '',
      propName: r.propName,
      propType: PropertyValueType.String,
      value: '',
    });
  }
  const properties = propertyBuilder.build();

  const quantityBuilder = new QuantityTableBuilder(strings);
  for (const r of args.qtoRows ?? []) {
    quantityBuilder.add({
      entityId: r.entityId,
      qsetName: r.qsetName,
      quantityName: r.quantityName,
      quantityType: QuantityType.Length,
      value: 0,
    });
  }
  const quantities = quantityBuilder.build();

  const byType = new Map<string, number[]>();
  for (const r of args.entities) {
    const upper = r.type.toUpperCase();
    let bucket = byType.get(upper);
    if (!bucket) { bucket = []; byType.set(upper, bucket); }
    bucket.push(r.expressId);
  }

  let spatialHierarchy: SpatialHierarchy | undefined;
  if (args.storeys && args.storeys.length > 0) {
    const byStorey = new Map<number, number[]>();
    const storeyElevations = new Map<number, number>();
    const elementToStorey = new Map<number, number>(args.elementToStorey ?? []);
    for (const s of args.storeys) {
      byStorey.set(s.id, []);
      if (s.elevation !== undefined) storeyElevations.set(s.id, s.elevation);
    }
    spatialHierarchy = {
      project: { expressId: 1, type: 'IfcProject', name: '', children: [], elements: [] },
      byStorey,
      byBuilding: new Map(),
      bySite: new Map(),
      bySpace: new Map(),
      storeyElevations,
      storeyHeights: new Map(),
      elementToStorey,
      getStoreyElements: () => [],
      getStoreyByElevation: () => null,
      getContainingSpace: () => null,
      getPath: () => [],
    };
  }

  // Build expressId → entityId-list map for properties / quantities so
  // the on-demand maps have the right shape.
  const onDemandPropertyMap = new Map<number, number[]>();
  for (const r of args.psetRows ?? []) {
    const list = onDemandPropertyMap.get(r.entityId) ?? [];
    list.push(r.entityId); // dummy pset id; the value is unused on the
                            // PropertyTable fallback path because source=''
    onDemandPropertyMap.set(r.entityId, list);
  }
  const onDemandQuantityMap = new Map<number, number[]>();
  for (const r of args.qtoRows ?? []) {
    const list = onDemandQuantityMap.get(r.entityId) ?? [];
    list.push(r.entityId);
    onDemandQuantityMap.set(r.entityId, list);
  }

  return {
    fileSize: 0,
    schemaVersion: 'IFC4',
    entityCount: args.entities.length,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: { ranges: new Uint32Array(0), index: new Map() }, byType },
    strings,
    entities,
    properties,
    quantities,
    relationships: { count: 0 } as unknown as IfcDataStore['relationships'],
    spatialHierarchy,
    onDemandPropertyMap,
    onDemandQuantityMap,
  } as unknown as IfcDataStore;
}

describe('discoverFilterSchema — basic pass', () => {
  it('returns an empty schema when no models / no spatial hierarchy', () => {
    const store = buildStore({ entities: [] });
    const schema = discoverFilterSchema(store);
    assert.deepStrictEqual(schema.storeys, []);
    assert.deepStrictEqual(schema.ifcTypes, []);
  });

  it('collects unique IFC types in canonical PascalCase, sorted', () => {
    const store = buildStore({
      entities: [
        { expressId: 1, type: 'IFCWALL',   globalId: '', name: '' },
        { expressId: 2, type: 'IFCWALL',   globalId: '', name: '' },
        { expressId: 3, type: 'IFCDOOR',   globalId: '', name: '' },
        { expressId: 4, type: 'IFCWINDOW', globalId: '', name: '' },
      ],
    });
    const schema = discoverFilterSchema(store);
    assert.deepStrictEqual(schema.ifcTypes, ['IfcDoor', 'IfcWall', 'IfcWindow']);
  });

  it('collects storeys with elevations sorted by name, deduped', () => {
    const store = buildStore({
      entities: [
        { expressId: 100, type: 'IFCBUILDINGSTOREY', globalId: '', name: 'Level 1' },
        { expressId: 101, type: 'IFCBUILDINGSTOREY', globalId: '', name: 'Level 2' },
        { expressId: 102, type: 'IFCBUILDINGSTOREY', globalId: '', name: 'Level 1' /* duplicate name */ },
      ],
      storeys: [
        { id: 100, name: 'Level 1', elevation: 0.0 },
        { id: 101, name: 'Level 2', elevation: 3.0 },
        { id: 102, name: 'Level 1', elevation: 0.0 },
      ],
    });
    const schema = discoverFilterSchema(store);
    // Two unique names; "Level 1" is kept once.
    assert.strictEqual(schema.storeys.length, 2);
    assert.deepStrictEqual(schema.storeys.map(([n]) => n), ['Level 1', 'Level 2']);
  });

  it('treats missing elevation as null', () => {
    const store = buildStore({
      entities: [{ expressId: 10, type: 'IFCBUILDINGSTOREY', globalId: '', name: 'Roof' }],
      storeys: [{ id: 10, name: 'Roof' /* no elevation */ }],
    });
    const schema = discoverFilterSchema(store);
    assert.deepStrictEqual(schema.storeys, [['Roof', null]]);
  });
});

describe('discoverPropertyAndQuantitySchema — fallback pass via PropertyTable', () => {
  it('returns empty schema when no on-demand maps', () => {
    const store = buildStore({ entities: [{ expressId: 1, type: 'IFCWALL', globalId: '', name: '' }] });
    // Strip the on-demand maps for the test.
    delete (store as { onDemandPropertyMap?: unknown }).onDemandPropertyMap;
    delete (store as { onDemandQuantityMap?: unknown }).onDemandQuantityMap;
    const schema = discoverPropertyAndQuantitySchema(store);
    assert.deepStrictEqual(schema.psets, []);
    assert.deepStrictEqual(schema.qtos, []);
  });

  it('harvests pset → property names from the on-demand iteration', () => {
    const store = buildStore({
      entities: [
        { expressId: 1, type: 'IFCWALL', globalId: '', name: '' },
        { expressId: 2, type: 'IFCDOOR', globalId: '', name: '' },
      ],
      psetRows: [
        { entityId: 1, psetName: 'Pset_WallCommon', propName: 'IsExternal' },
        { entityId: 1, psetName: 'Pset_WallCommon', propName: 'LoadBearing' },
        { entityId: 2, psetName: 'Pset_DoorCommon', propName: 'FireRating' },
      ],
    });
    const schema = discoverPropertyAndQuantitySchema(store);
    assert.deepStrictEqual(schema.psets.map(([n]) => n).sort(), ['Pset_DoorCommon', 'Pset_WallCommon']);
    const wall = schema.psets.find(([n]) => n === 'Pset_WallCommon');
    assert.deepStrictEqual(wall?.[1].sort(), ['IsExternal', 'LoadBearing']);
  });

  it('harvests qto → quantity names with empty unit', () => {
    const store = buildStore({
      entities: [{ expressId: 1, type: 'IFCWALL', globalId: '', name: '' }],
      qtoRows: [
        { entityId: 1, qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetSideArea' },
        { entityId: 1, qsetName: 'Qto_WallBaseQuantities', quantityName: 'GrossVolume' },
      ],
    });
    const schema = discoverPropertyAndQuantitySchema(store);
    assert.strictEqual(schema.qtos.length, 1);
    const [qsetName, quantities] = schema.qtos[0];
    assert.strictEqual(qsetName, 'Qto_WallBaseQuantities');
    assert.deepStrictEqual(quantities.map(([n]) => n).sort(), ['GrossVolume', 'NetSideArea']);
    // Unit is "" until on-demand extractors materialise it.
    assert.ok(quantities.every(([, unit]) => unit === ''));
  });
});
