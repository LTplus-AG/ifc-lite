/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
  PropertyValueType,
} from '@ifc-lite/data';
import { toCacheDataStore, type ParsedIfcStore } from './adapt.js';
import { SchemaVersion } from './types.js';
import type { SpatialHierarchy } from '@ifc-lite/data';

function buildSpatialHierarchy(): SpatialHierarchy {
  const project = { id: 1, type: 'IfcProject', name: 'Project', children: [], elements: [] };
  return {
    project,
    byStorey: new Map([[2, [1]]]),
    byBuilding: new Map(),
    bySite: new Map(),
    bySpace: new Map(),
    storeyElevations: new Map([[2, 0]]),
    storeyHeights: new Map(),
    elementToStorey: new Map([[1, 2]]),
    getStoreyElements: () => [1],
    getStoreyByElevation: () => 2,
    getContainingSpace: () => null,
    getPath: () => [project],
  } as unknown as SpatialHierarchy;
}

function buildParsedStore(overrides: Partial<ParsedIfcStore> = {}): ParsedIfcStore {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(1, strings);
  entityBuilder.add(1, 'IfcWall', 'guid-wall', 'Wall', '', '', true, false);
  const entities = entityBuilder.build();
  const properties = new PropertyTableBuilder(strings).build();
  const quantities = new QuantityTableBuilder(strings).build();
  const relationships = new RelationshipGraphBuilder().build();

  return {
    schemaVersion: 'IFC4',
    entityCount: 1,
    strings,
    entities,
    properties,
    quantities,
    relationships,
    ...overrides,
  };
}

describe('toCacheDataStore', () => {
  it('maps every known schemaVersion string to its SchemaVersion enum value', () => {
    expect(toCacheDataStore(buildParsedStore({ schemaVersion: 'IFC2X3' })).schema).toBe(SchemaVersion.IFC2X3);
    expect(toCacheDataStore(buildParsedStore({ schemaVersion: 'IFC4' })).schema).toBe(SchemaVersion.IFC4);
    expect(toCacheDataStore(buildParsedStore({ schemaVersion: 'IFC4X3' })).schema).toBe(SchemaVersion.IFC4X3);
  });

  it('falls back an IFC5 source to SchemaVersion.IFC2X3, since the binary format predates IFC5', () => {
    expect(toCacheDataStore(buildParsedStore({ schemaVersion: 'IFC5' })).schema).toBe(SchemaVersion.IFC2X3);
  });

  it('carries the data tables straight through unchanged', () => {
    const store = buildParsedStore();
    const cacheStore = toCacheDataStore(store);
    expect(cacheStore.entityCount).toBe(store.entityCount);
    expect(cacheStore.strings).toBe(store.strings);
    expect(cacheStore.entities).toBe(store.entities);
    expect(cacheStore.properties).toBe(store.properties);
    expect(cacheStore.quantities).toBe(store.quantities);
    expect(cacheStore.relationships).toBe(store.relationships);
  });

  it('falls back to entities.count when entityCount is 0, so a store that never set it still writes a real count', () => {
    // The viewer's write path carried this fallback inline
    // (`dataStore.entityCount || dataStore.entities?.count || 0`) before it
    // moved onto this adapter. Without it, migrating the viewer here would
    // have started writing entityCount 0 for any store that leaves the field
    // unset -- a header field the reader hands straight back to callers.
    const store = buildParsedStore({ entityCount: 0 });
    expect(store.entities.count).toBeGreaterThan(0);
    expect(toCacheDataStore(store).entityCount).toBe(store.entities.count);
  });

  it('prefers the store\'s own entityCount when it is set', () => {
    const store = buildParsedStore({ entityCount: 7 });
    expect(toCacheDataStore(store).entityCount).toBe(7);
  });

  it('passes a present entityIndex straight through, so the write can emit an entity-index section', () => {
    const entityIndex = {
      byId: new Map([[1, { expressId: 1, type: 'IfcWall', byteOffset: 0, byteLength: 42, lineNumber: 1 }]]),
    };
    const cacheStore = toCacheDataStore(buildParsedStore({ entityIndex }));
    expect(cacheStore.entityIndex).toBe(entityIndex);
  });

  it('leaves entityIndex undefined when the source has none', () => {
    const cacheStore = toCacheDataStore(buildParsedStore());
    expect(cacheStore.entityIndex).toBeUndefined();
  });

  it('serializes exactly what the store carries: an empty property table stays empty (the STEP lazy-properties case, issue #3759)', () => {
    const store = buildParsedStore();
    expect(store.properties.count).toBe(0);
    const cacheStore = toCacheDataStore(store);
    expect(cacheStore.properties.count).toBe(0);
  });

  it('passes a present spatialHierarchy through unchanged', () => {
    const spatialHierarchy = buildSpatialHierarchy();
    const store = buildParsedStore({ spatialHierarchy });
    const cacheStore = toCacheDataStore(store);
    expect(cacheStore.spatialHierarchy).toBe(spatialHierarchy);
  });

  it('leaves spatialHierarchy undefined when the source has none', () => {
    const store = buildParsedStore();
    expect(store.spatialHierarchy).toBeUndefined();
    const cacheStore = toCacheDataStore(store);
    expect(cacheStore.spatialHierarchy).toBeUndefined();
  });

  it('does not touch a property table that is already populated (a pre-materialized/columnar source)', () => {
    const strings = new StringTable();
    const propertyBuilder = new PropertyTableBuilder(strings);
    propertyBuilder.add({
      entityId: 1,
      psetName: 'Pset_WallCommon',
      psetGlobalId: 'pset-guid-1',
      propName: 'IsExternal',
      propType: PropertyValueType.Boolean,
      value: true,
    });
    const properties = propertyBuilder.build();
    const store = buildParsedStore({ strings, properties });
    expect(store.properties.count).toBeGreaterThan(0);

    const cacheStore = toCacheDataStore(store);
    expect(cacheStore.properties.count).toBe(store.properties.count);
    expect(cacheStore.properties).toBe(store.properties);
  });
});
