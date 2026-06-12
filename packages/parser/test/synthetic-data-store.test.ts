/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { createSyntheticDataStore } from '../src/synthetic-data-store.js';

describe('createSyntheticDataStore', () => {
  it('builds an entity-less GLB store with the full IfcDataStore contract', () => {
    // Mirrors `createMinimalGlbDataStore`: renderable meshes, no IFC entities.
    const store = createSyntheticDataStore({
      schemaVersion: 'IFC4',
      fileSize: 1234,
      entityCount: 7, // mesh count, not entity-row count
    });

    // The four lazy accessors the query path relies on must all be wired —
    // the crash class (#950/#1004) was these arriving as undefined behind an
    // `as unknown as IfcDataStore` cast.
    expect(typeof store.getEntity).toBe('function');
    expect(typeof store.getEntitiesByType).toBe('function');
    expect(typeof store.getProperties).toBe('function');
    expect(typeof store.getQuantities).toBe('function');

    expect(store.schemaVersion).toBe('IFC4');
    expect(store.fileSize).toBe(1234);
    expect(store.entityCount).toBe(7);
    expect(store.entities.count).toBe(0);

    // No entities / properties to resolve, but the calls must not throw.
    expect(store.getEntity(1)).toBeNull();
    expect(store.getEntitiesByType('IfcWall')).toEqual([]);
    expect(store.getProperties(1)).toEqual([]);
    expect(store.getQuantities(1)).toEqual([]);
  });

  it('builds a single-entity point-cloud store whose entity table answers picking queries', () => {
    // Mirrors the LAS/LAZ `emptyDataStore`: one synthetic IfcGeographicElement.
    const expressId = 42;
    const store = createSyntheticDataStore({
      schemaVersion: 'IFC4',
      fileSize: 9999,
      entityCount: 1,
      entities: [{
        expressId,
        type: 'IfcGeographicElement',
        globalId: `pointcloud-${expressId}`,
        name: 'scan.las',
        hasGeometry: true,
      }],
    });

    expect(store.entities.count).toBe(1);
    // Picking reads these directly off the entity table.
    expect(store.entities.getTypeName(expressId)).toBe('IfcGeographicElement');
    expect(store.entities.getTypeEnum(expressId)).toBe(58); // IfcTypeEnum.IfcGeographicElement
    expect(store.entities.getName(expressId)).toBe('scan.las');
    expect(store.entities.getGlobalId(expressId)).toBe(`pointcloud-${expressId}`);
    expect(store.entities.hasGeometry(expressId)).toBe(true);

    // GlobalId ↔ expressId mapping (used by BCF / federation lookups).
    expect(store.entities.getExpressIdByGlobalId(`pointcloud-${expressId}`)).toBe(expressId);
    expect(store.entities.getGlobalIdMap().get(`pointcloud-${expressId}`)).toBe(expressId);

    // Index wiring.
    expect(store.entityIndex.byType.get('IFCGEOGRAPHICELEMENT')).toEqual([expressId]);
    expect(store.entityIndex.byId.has(expressId)).toBe(true);

    // No properties/quantities, but the accessors resolve cleanly.
    expect(store.getProperties(expressId)).toEqual([]);
    expect(store.getQuantities(expressId)).toEqual([]);
    // Empty source ⇒ getEntity resolves the ref then extracts nothing.
    expect(store.getEntity(expressId)).toBeNull();
  });
});
