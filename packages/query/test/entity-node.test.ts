/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityNode } from '../src/entity-node.js';
import {
  createMockStore,
  IfcTypeEnum,
  RelationshipType,
  PropertyValueType,
  QuantityType,
} from './mock-store.js';

// ── Fixtures ────────────────────────────────────────────────────

function buildSpatialStore() {
  return createMockStore({
    entities: [
      { expressId: 1, type: 'IFCPROJECT', globalId: 'proj-1', name: 'My Project' },
      { expressId: 2, type: 'IFCSITE', globalId: 'site-1', name: 'My Site' },
      { expressId: 3, type: 'IFCBUILDING', globalId: 'bldg-1', name: 'Building A', description: 'Main building', objectType: 'Office' },
      { expressId: 4, type: 'IFCBUILDINGSTOREY', globalId: 'storey-1', name: 'Level 0' },
      { expressId: 5, type: 'IFCBUILDINGSTOREY', globalId: 'storey-2', name: 'Level 1' },
      { expressId: 10, type: 'IFCWALL', globalId: 'wall-1', name: 'Exterior Wall' },
      { expressId: 11, type: 'IFCDOOR', globalId: 'door-1', name: 'Main Door' },
      { expressId: 20, type: 'IFCOPENINGELEMENT', globalId: 'opening-1', name: 'Wall Opening' },
      { expressId: 30, type: 'IFCWALLTYPE', globalId: 'wtype-1', name: 'Standard Wall Type' },
    ],
    properties: [
      { entityId: 10, psetName: 'Pset_WallCommon', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: true },
      { entityId: 10, psetName: 'Pset_WallCommon', propName: 'FireRating', propType: PropertyValueType.Label, value: 'REI60' },
      { entityId: 10, psetName: 'Custom_Props', propName: 'Color', propType: PropertyValueType.Label, value: 'White' },
    ],
    quantities: [
      { entityId: 10, qsetName: 'Qto_WallBaseQuantities', quantityName: 'Length', quantityType: QuantityType.Length, value: 5.0 },
      { entityId: 10, qsetName: 'Qto_WallBaseQuantities', quantityName: 'Height', quantityType: QuantityType.Length, value: 3.0 },
      { entityId: 10, qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetSideArea', quantityType: QuantityType.Area, value: 15.0 },
    ],
    relationships: [
      // Project -> Site (aggregation)
      { source: 1, target: 2, type: RelationshipType.Aggregates, relId: 100 },
      // Site -> Building
      { source: 2, target: 3, type: RelationshipType.Aggregates, relId: 101 },
      // Building -> Storey
      { source: 3, target: 4, type: RelationshipType.Aggregates, relId: 102 },
      { source: 3, target: 5, type: RelationshipType.Aggregates, relId: 103 },
      // Storey contains wall
      { source: 4, target: 10, type: RelationshipType.ContainsElements, relId: 200 },
      // Storey contains door
      { source: 4, target: 11, type: RelationshipType.ContainsElements, relId: 201 },
      // Wall voids opening
      { source: 10, target: 20, type: RelationshipType.VoidsElement, relId: 300 },
      // Wall defined by type (forward = instance -> type; inverse = type -> instances)
      { source: 10, target: 30, type: RelationshipType.DefinesByType, relId: 400 },
    ],
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe('EntityNode', () => {
  // ── Basic attribute access ────────────────────────────────────

  describe('attribute access', () => {
    it('should expose the expressId', () => {
      const store = buildSpatialStore();
      const node = new EntityNode(store as any, 10);
      expect(node.expressId).toBe(10);
    });

    it('should return the stored name', () => {
      const store = buildSpatialStore();
      const node = new EntityNode(store as any, 10);
      expect(node.name).toBe('Exterior Wall');
    });

    it('should return the stored globalId', () => {
      const store = buildSpatialStore();
      const node = new EntityNode(store as any, 10);
      expect(node.globalId).toBe('wall-1');
    });

    it('should return the IFC type name', () => {
      const store = buildSpatialStore();
      const node = new EntityNode(store as any, 10);
      expect(node.type).toBe('IfcWall');
    });

    it('should return description when present', () => {
      const store = buildSpatialStore();
      const node = new EntityNode(store as any, 3);
      expect(node.description).toBe('Main building');
    });

    it('should return objectType when present', () => {
      const store = buildSpatialStore();
      const node = new EntityNode(store as any, 3);
      expect(node.objectType).toBe('Office');
    });

    it('should return empty string for name of non-existent entity', () => {
      const store = buildSpatialStore();
      const node = new EntityNode(store as any, 9999);
      expect(node.name).toBe('');
    });

    it('should return empty globalId for non-existent entity', () => {
      const store = buildSpatialStore();
      const node = new EntityNode(store as any, 9999);
      expect(node.globalId).toBe('');
    });
  });

  // ── Spatial containment ───────────────────────────────────────

  describe('spatial containment', () => {
    it('contains() should return child elements of a spatial container', () => {
      const store = buildSpatialStore();
      const storey = new EntityNode(store as any, 4);
      const children = storey.contains();
      expect(children).toHaveLength(2);
      const childIds = children.map(c => c.expressId).sort();
      expect(childIds).toEqual([10, 11]);
    });

    it('contains() should return empty array when no children', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      expect(wall.contains()).toEqual([]);
    });

    it('containedIn() should return the spatial container', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const container = wall.containedIn();
      expect(container).not.toBeNull();
      expect(container!.expressId).toBe(4);
    });

    it('containedIn() should return null when no container', () => {
      const store = buildSpatialStore();
      const project = new EntityNode(store as any, 1);
      expect(project.containedIn()).toBeNull();
    });
  });

  // ── Aggregation ───────────────────────────────────────────────

  describe('aggregation', () => {
    it('decomposes() should return aggregate children', () => {
      const store = buildSpatialStore();
      const building = new EntityNode(store as any, 3);
      const storeys = building.decomposes();
      expect(storeys).toHaveLength(2);
      expect(storeys.map(s => s.expressId).sort()).toEqual([4, 5]);
    });

    it('decomposedBy() should return the aggregate parent', () => {
      const store = buildSpatialStore();
      const storey = new EntityNode(store as any, 4);
      const parent = storey.decomposedBy();
      expect(parent).not.toBeNull();
      expect(parent!.expressId).toBe(3);
    });

    it('decomposedBy() should return null for root entity', () => {
      const store = buildSpatialStore();
      const project = new EntityNode(store as any, 1);
      expect(project.decomposedBy()).toBeNull();
    });
  });

  // ── Type relationships ────────────────────────────────────────

  describe('type relationships', () => {
    it('definingType() should return the type entity', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const typeNode = wall.definingType();
      expect(typeNode).not.toBeNull();
      expect(typeNode!.expressId).toBe(30);
      expect(typeNode!.name).toBe('Standard Wall Type');
    });

    it('instances() should return entities of a given type', () => {
      const store = buildSpatialStore();
      const wallType = new EntityNode(store as any, 30);
      const instances = wallType.instances();
      expect(instances).toHaveLength(1);
      expect(instances[0].expressId).toBe(10);
    });

    it('definingType() should return null when entity has no type', () => {
      const store = buildSpatialStore();
      const door = new EntityNode(store as any, 11);
      expect(door.definingType()).toBeNull();
    });
  });

  // ── Openings ──────────────────────────────────────────────────

  describe('openings', () => {
    it('voids() should return openings in the element', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const openings = wall.voids();
      expect(openings).toHaveLength(1);
      expect(openings[0].expressId).toBe(20);
    });

    it('voids() should return empty for element with no openings', () => {
      const store = buildSpatialStore();
      const door = new EntityNode(store as any, 11);
      expect(door.voids()).toEqual([]);
    });
  });

  // ── Spatial shortcuts: building(), storey() ───────────────────

  describe('spatial shortcuts', () => {
    it('building() should walk up to the IfcBuilding', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const building = wall.building();
      expect(building).not.toBeNull();
      expect(building!.expressId).toBe(3);
      expect(building!.type).toBe('IfcBuilding');
    });

    it('storey() should walk up to the IfcBuildingStorey', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const storey = wall.storey();
      expect(storey).not.toBeNull();
      expect(storey!.expressId).toBe(4);
      expect(storey!.type).toBe('IfcBuildingStorey');
    });

    it('building() should return itself if already IfcBuilding', () => {
      const store = buildSpatialStore();
      const building = new EntityNode(store as any, 3);
      const result = building.building();
      expect(result).not.toBeNull();
      expect(result!.expressId).toBe(3);
    });

    it('storey() should return itself if already IfcBuildingStorey', () => {
      const store = buildSpatialStore();
      const storey = new EntityNode(store as any, 4);
      const result = storey.storey();
      expect(result).not.toBeNull();
      expect(result!.expressId).toBe(4);
    });

    it('building() should return null when cannot reach a building', () => {
      const store = buildSpatialStore();
      const project = new EntityNode(store as any, 1);
      const result = project.building();
      expect(result).toBeNull();
    });

    it('storey() should return null when cannot reach a storey', () => {
      const store = buildSpatialStore();
      const project = new EntityNode(store as any, 1);
      const result = project.storey();
      expect(result).toBeNull();
    });
  });

  // ── Traverse ──────────────────────────────────────────────────

  describe('traverse', () => {
    it('should traverse aggregation forward with depth 1', () => {
      const store = buildSpatialStore();
      const building = new EntityNode(store as any, 3);
      const result = building.traverse(RelationshipType.Aggregates, 1, 'forward');
      expect(result.map(n => n.expressId).sort()).toEqual([4, 5]);
    });

    it('should traverse aggregation forward with depth 2 (building -> storeys)', () => {
      const store = buildSpatialStore();
      const site = new EntityNode(store as any, 2);
      const result = site.traverse(RelationshipType.Aggregates, 2, 'forward');
      // depth 1: building(3), depth 2: storeys(4,5)
      expect(result.map(n => n.expressId).sort()).toEqual([3, 4, 5]);
    });

    it('should not revisit nodes (cycle safety)', () => {
      const store = buildSpatialStore();
      const building = new EntityNode(store as any, 3);
      const result = building.traverse(RelationshipType.Aggregates, 100, 'forward');
      const ids = result.map(n => n.expressId);
      // No duplicates
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should return empty array when no edges of the given type', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const result = wall.traverse(RelationshipType.Aggregates, 5, 'forward');
      expect(result).toEqual([]);
    });
  });

  // ── Properties ────────────────────────────────────────────────

  describe('properties', () => {
    it('properties() should return property sets (via fallback table)', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const props = wall.properties();
      expect(props.length).toBeGreaterThan(0);
      const psetNames = props.map(p => p.name);
      expect(psetNames).toContain('Pset_WallCommon');
    });

    it('property() should return a single property value', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const value = wall.property('Pset_WallCommon', 'FireRating');
      expect(value).toBe('REI60');
    });

    it('property() should return null for non-existent property', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const value = wall.property('Pset_WallCommon', 'NoSuchProp');
      expect(value).toBeNull();
    });

    it('properties() should return empty for entity with no properties', () => {
      const store = buildSpatialStore();
      const project = new EntityNode(store as any, 1);
      expect(project.properties()).toEqual([]);
    });
  });

  // ── Quantities ────────────────────────────────────────────────

  describe('quantities', () => {
    it('quantities() should return quantity sets', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const qsets = wall.quantities();
      expect(qsets.length).toBe(1);
      expect(qsets[0].name).toBe('Qto_WallBaseQuantities');
      expect(qsets[0].quantities).toHaveLength(3);
    });

    it('quantity() should return a single quantity value', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const length = wall.quantity('Qto_WallBaseQuantities', 'Length');
      expect(length).toBe(5.0);
    });

    it('quantity() should return null for non-existent quantity', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const val = wall.quantity('Qto_WallBaseQuantities', 'NoSuchQty');
      expect(val).toBeNull();
    });

    it('quantities() should return empty for entity with no quantities', () => {
      const store = buildSpatialStore();
      const door = new EntityNode(store as any, 11);
      expect(door.quantities()).toEqual([]);
    });
  });

  // ── allAttributes fallback ────────────────────────────────────

  describe('allAttributes', () => {
    it('should return known attributes when no source buffer is available', () => {
      const store = buildSpatialStore();
      const building = new EntityNode(store as any, 3);
      const attrs = building.allAttributes();
      const attrNames = attrs.map(a => a.name);
      expect(attrNames).toContain('Name');
      expect(attrNames).toContain('Description');
      expect(attrNames).toContain('ObjectType');
    });

    it('should omit attributes that are empty strings', () => {
      const store = buildSpatialStore();
      const wall = new EntityNode(store as any, 10);
      const attrs = wall.allAttributes();
      // Wall has no description or objectType set, so those should be omitted
      for (const attr of attrs) {
        expect(attr.value).not.toBe('');
      }
    });
  });

  // ── Caching ───────────────────────────────────────────────────

  describe('attribute caching', () => {
    it('repeated access to the same attribute should be consistent', () => {
      const store = buildSpatialStore();
      const node = new EntityNode(store as any, 3);
      const name1 = node.name;
      const name2 = node.name;
      expect(name1).toBe(name2);
      expect(name1).toBe('Building A');
    });
  });
});
