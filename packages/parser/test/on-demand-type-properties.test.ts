/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for on-demand type-level property extraction
 */

import { describe, it, expect } from 'vitest';
import { extractTypePropertiesOnDemand } from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';
import { RelationshipType } from '@ifc-lite/data';

/**
 * Helper: build a minimal IfcDataStore from STEP lines with relationship graph support.
 */
function buildStoreFromStep(
  lines: string[],
  opts?: {
    propertyMap?: Map<number, number[]>;
    relationships?: { entityId: number; relType: RelationshipType; direction: 'forward' | 'inverse'; targetIds: number[] }[];
  }
): IfcDataStore {
  const text = lines.join('\n');
  const source = new TextEncoder().encode(text);

  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();

  let offset = 0;
  for (const line of lines) {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)\(/);
    if (match) {
      const expressId = parseInt(match[1], 10);
      const type = match[2];
      const lineStart = text.indexOf(line, offset > 0 ? text.indexOf('\n', offset - 1) : 0);

      const ref: EntityRef = {
        expressId,
        type,
        byteOffset: lineStart >= 0 ? lineStart : offset,
        byteLength: line.length,
        lineNumber: 1,
      };

      byId.set(expressId, ref);
      const typeUpper = type.toUpperCase();
      let typeList = byType.get(typeUpper);
      if (!typeList) {
        typeList = [];
        byType.set(typeUpper, typeList);
      }
      typeList.push(expressId);

      offset = lineStart >= 0 ? lineStart + line.length : offset + line.length;
    }
  }

  // Build mock relationship graph
  const relData = opts?.relationships ?? [];
  const relationships = {
    getRelated: (entityId: number, relType: RelationshipType, direction: 'forward' | 'inverse') => {
      const matching = relData.filter(
        r => r.entityId === entityId && r.relType === relType && r.direction === direction
      );
      return matching.flatMap(r => r.targetIds);
    },
    hasRelationship: () => false,
    getRelationshipsBetween: () => [],
  };

  return {
    source,
    entityIndex: { byId, byType },
    onDemandPropertyMap: opts?.propertyMap,
    relationships,
  } as unknown as IfcDataStore;
}

describe('extractTypePropertiesOnDemand', () => {
  it('should return null when no relationship graph', () => {
    const store = buildStoreFromStep([]);
    (store as any).relationships = undefined;
    const result = extractTypePropertiesOnDemand(store, 100);
    expect(result).toBeNull();
  });

  it('should return null when entity has no type relationship', () => {
    const store = buildStoreFromStep([], { relationships: [] });
    const result = extractTypePropertiesOnDemand(store, 100);
    expect(result).toBeNull();
  });

  it('should extract type properties from HasPropertySets attribute (IFC2X3 pattern)', () => {
    // Simulates: IfcWallType has HasPropertySets directly in its attributes
    const lines = [
      // Wall occurrence
      `#100=IFCWALLSTANDARDCASE('guid1',$,'My Wall',$,$,$,$,$);`,
      // Wall type with HasPropertySets at index 5
      // IfcWallType: [GlobalId, OwnerHistory, Name, Description, ApplicableOccurrence, HasPropertySets, ...]
      `#200=IFCWALLTYPE('guid2',$,'Wall Type A',$,$,(#300,#400),$,'tag',$,.STANDARD.);`,
      // Property sets owned by the type
      `#300=IFCPROPERTYSET('guid3',$,'Graphics',$,(#310,#320));`,
      `#310=IFCPROPERTYSINGLEVALUE('Color',$,'White',$);`,
      `#320=IFCPROPERTYSINGLEVALUE('Pattern',$,'Solid',$);`,
      `#400=IFCPROPERTYSET('guid4',$,'Materials and Finishes',$,(#410));`,
      `#410=IFCPROPERTYSINGLEVALUE('Structural Material',$,'Concrete',$);`,
    ];

    const store = buildStoreFromStep(lines, {
      relationships: [
        { entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] },
      ],
    });

    const result = extractTypePropertiesOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.typeName).toBe('Wall Type A');
    expect(result!.typeId).toBe(200);
    expect(result!.properties).toHaveLength(2);

    const graphicsPset = result!.properties.find(p => p.name === 'Graphics');
    expect(graphicsPset).toBeDefined();
    expect(graphicsPset!.properties).toHaveLength(2);
    expect(graphicsPset!.properties[0].name).toBe('Color');
    expect(graphicsPset!.properties[0].value).toBe('White');
    expect(graphicsPset!.properties[1].name).toBe('Pattern');
    expect(graphicsPset!.properties[1].value).toBe('Solid');

    const matPset = result!.properties.find(p => p.name === 'Materials and Finishes');
    expect(matPset).toBeDefined();
    expect(matPset!.properties).toHaveLength(1);
    expect(matPset!.properties[0].name).toBe('Structural Material');
  });

  it('should extract type properties from onDemandPropertyMap (IFC4 pattern)', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      // Type entity without HasPropertySets in attributes (using $)
      `#200=IFCWALLTYPE('guid2',$,'Wall Type B',$,$,$,$,'tag',$,.STANDARD.);`,
      // Property set linked via IFCRELDEFINESBYPROPERTIES -> onDemandPropertyMap
      `#300=IFCPROPERTYSET('guid3',$,'Construction',$,(#310));`,
      `#310=IFCPROPERTYSINGLEVALUE('Function',$,'Exterior',$);`,
    ];

    const propertyMap = new Map<number, number[]>([
      [200, [300]], // Type entity has pset #300 via rel
    ]);

    const store = buildStoreFromStep(lines, {
      propertyMap,
      relationships: [
        { entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] },
      ],
    });

    const result = extractTypePropertiesOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.typeName).toBe('Wall Type B');
    expect(result!.properties).toHaveLength(1);
    expect(result!.properties[0].name).toBe('Construction');
    expect(result!.properties[0].properties[0].name).toBe('Function');
  });

  it('should merge HasPropertySets and onDemandPropertyMap without duplicates', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      `#200=IFCWALLTYPE('guid2',$,'Wall Type C',$,$,(#300),$,'tag',$,.STANDARD.);`,
      // Pset from HasPropertySets
      `#300=IFCPROPERTYSET('guid3',$,'Graphics',$,(#310));`,
      `#310=IFCPROPERTYSINGLEVALUE('Color',$,'Blue',$);`,
      // Different pset via onDemandPropertyMap
      `#400=IFCPROPERTYSET('guid4',$,'Analytics',$,(#410));`,
      `#410=IFCPROPERTYSINGLEVALUE('Area',$,42.5,$);`,
    ];

    const propertyMap = new Map<number, number[]>([
      [200, [300, 400]], // Both psets via rel
    ]);

    const store = buildStoreFromStep(lines, {
      propertyMap,
      relationships: [
        { entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] },
      ],
    });

    const result = extractTypePropertiesOnDemand(store, 100);
    expect(result).not.toBeNull();
    // #300 (Graphics) should appear once (from HasPropertySets), #400 (Analytics) once (from onDemandPropertyMap)
    expect(result!.properties).toHaveLength(2);
    const names = result!.properties.map(p => p.name);
    expect(names).toContain('Graphics');
    expect(names).toContain('Analytics');
  });

  it('should skip quantity sets and only extract property sets', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      // Type with both property set and quantity set in HasPropertySets
      `#200=IFCWALLTYPE('guid2',$,'Wall Type D',$,$,(#300,#400),$,'tag',$,.STANDARD.);`,
      `#300=IFCPROPERTYSET('guid3',$,'Graphics',$,(#310));`,
      `#310=IFCPROPERTYSINGLEVALUE('Color',$,'Red',$);`,
      `#400=IFCELEMENTQUANTITY('guid4',$,'BaseQuantities',$,$,(#410));`,
      `#410=IFCQUANTITYLENGTH('Width',$,0.3,$);`,
    ];

    const store = buildStoreFromStep(lines, {
      relationships: [
        { entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] },
      ],
    });

    const result = extractTypePropertiesOnDemand(store, 100);
    expect(result).not.toBeNull();
    // Only property sets should be returned, not quantity sets
    expect(result!.properties).toHaveLength(1);
    expect(result!.properties[0].name).toBe('Graphics');
  });

  it('should handle numeric property values correctly', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      `#200=IFCWALLTYPE('guid2',$,'Wall Type E',$,$,(#300),$,'tag',$,.STANDARD.);`,
      `#300=IFCPROPERTYSET('guid3',$,'Dimensions',$,(#310,#320));`,
      `#310=IFCPROPERTYSINGLEVALUE('Width',$,0.517,$);`,
      `#320=IFCPROPERTYSINGLEVALUE('Height',$,3.0,$);`,
    ];

    const store = buildStoreFromStep(lines, {
      relationships: [
        { entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] },
      ],
    });

    const result = extractTypePropertiesOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.properties[0].properties[0].value).toBe(0.517);
    expect(result!.properties[0].properties[0].type).toBe(1); // Real
    expect(result!.properties[0].properties[1].value).toBe(3.0);
  });

  it('should return null when type entity has no property sets', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      // Type with empty HasPropertySets ($)
      `#200=IFCWALLTYPE('guid2',$,'Wall Type F',$,$,$,$,'tag',$,.STANDARD.);`,
    ];

    const store = buildStoreFromStep(lines, {
      relationships: [
        { entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] },
      ],
    });

    const result = extractTypePropertiesOnDemand(store, 100);
    expect(result).toBeNull();
  });
});
