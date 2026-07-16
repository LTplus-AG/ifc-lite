/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for on-demand type-level quantity extraction (issue #1745).
 *
 * Mirrors on-demand-type-properties.test.ts but for IfcElementQuantity sets
 * that live on an element's IfcTypeProduct (e.g. type-level
 * Qto_WallBaseQuantities), so instance schedules can resolve type QTOs.
 */

import { describe, it, expect } from 'vitest';
import { extractTypeQuantitiesOnDemand } from '../src/columnar-parser.js';
import type { IfcDataStore } from '../src/columnar-parser.js';
import type { EntityRef } from '../src/types.js';
import { RelationshipType, QuantityType } from '@ifc-lite/data';

function buildStoreFromStep(
  lines: string[],
  opts?: {
    quantityMap?: Map<number, number[]>;
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

      byId.set(expressId, {
        expressId,
        type,
        byteOffset: lineStart >= 0 ? lineStart : offset,
        byteLength: line.length,
        lineNumber: 1,
      });
      const typeUpper = type.toUpperCase();
      let typeList = byType.get(typeUpper);
      if (!typeList) { typeList = []; byType.set(typeUpper, typeList); }
      typeList.push(expressId);

      offset = lineStart >= 0 ? lineStart + line.length : offset + line.length;
    }
  }

  const relData = opts?.relationships ?? [];
  const relationships = {
    getRelated: (entityId: number, relType: RelationshipType, direction: 'forward' | 'inverse') =>
      relData.filter(r => r.entityId === entityId && r.relType === relType && r.direction === direction)
        .flatMap(r => r.targetIds),
    hasRelationship: () => false,
    getRelationshipsBetween: () => [],
  };

  return {
    source,
    entityIndex: { byId, byType },
    onDemandQuantityMap: opts?.quantityMap,
    relationships,
  } as unknown as IfcDataStore;
}

describe('extractTypeQuantitiesOnDemand', () => {
  it('returns null when the element has no type relationship', () => {
    const store = buildStoreFromStep([], { relationships: [] });
    expect(extractTypeQuantitiesOnDemand(store, 100)).toBeNull();
  });

  it('extracts a quantity set from the type HasPropertySets attribute (IFC2X3 pattern)', () => {
    const lines = [
      `#100=IFCWALLSTANDARDCASE('guid1',$,'My Wall',$,$,$,$,$);`,
      // Type carries an IfcElementQuantity in its HasPropertySets list (index 5).
      `#200=IFCWALLTYPE('guid2',$,'Wall Type A',$,$,(#400),$,'tag',$,.STANDARD.);`,
      `#400=IFCELEMENTQUANTITY('guid4',$,'Qto_WallBaseQuantities',$,$,(#410,#420));`,
      `#410=IFCQUANTITYLENGTH('Width',$,$,0.3);`,
      `#420=IFCQUANTITYAREA('GrossSideArea',$,$,12.5);`,
    ];
    const store = buildStoreFromStep(lines, {
      relationships: [{ entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] }],
    });

    const result = extractTypeQuantitiesOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.typeName).toBe('Wall Type A');
    expect(result!.typeId).toBe(200);
    expect(result!.quantities).toHaveLength(1);
    const qset = result!.quantities[0];
    expect(qset.name).toBe('Qto_WallBaseQuantities');
    expect(qset.quantities.map(q => q.name)).toEqual(['Width', 'GrossSideArea']);
    expect(qset.quantities[0].value).toBe(0.3);
    expect(qset.quantities[0].type).toBe(QuantityType.Length);
    expect(qset.quantities[1].value).toBe(12.5);
    expect(qset.quantities[1].type).toBe(QuantityType.Area);
  });

  it('extracts a quantity set from onDemandQuantityMap (IFC4 pattern)', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      `#200=IFCWALLTYPE('guid2',$,'Wall Type B',$,$,$,$,'tag',$,.STANDARD.);`,
      `#400=IFCELEMENTQUANTITY('guid4',$,'Qto_WallBaseQuantities',$,$,(#410));`,
      `#410=IFCQUANTITYVOLUME('NetVolume',$,$,0.84);`,
    ];
    const store = buildStoreFromStep(lines, {
      quantityMap: new Map<number, number[]>([[200, [400]]]),
      relationships: [{ entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] }],
    });

    const result = extractTypeQuantitiesOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.quantities[0].name).toBe('Qto_WallBaseQuantities');
    expect(result!.quantities[0].quantities[0].name).toBe('NetVolume');
    expect(result!.quantities[0].quantities[0].value).toBe(0.84);
    expect(result!.quantities[0].quantities[0].type).toBe(QuantityType.Volume);
  });

  it('skips property sets and only extracts element quantities', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      // HasPropertySets mixes a property set and a quantity set.
      `#200=IFCWALLTYPE('guid2',$,'Wall Type C',$,$,(#300,#400),$,'tag',$,.STANDARD.);`,
      `#300=IFCPROPERTYSET('guid3',$,'Pset_WallCommon',$,(#310));`,
      `#310=IFCPROPERTYSINGLEVALUE('FireRating',$,'REI 60',$);`,
      `#400=IFCELEMENTQUANTITY('guid4',$,'Qto_WallBaseQuantities',$,$,(#410));`,
      `#410=IFCQUANTITYLENGTH('Width',$,$,0.25);`,
    ];
    const store = buildStoreFromStep(lines, {
      relationships: [{ entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] }],
    });

    const result = extractTypeQuantitiesOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.quantities).toHaveLength(1);
    expect(result!.quantities[0].name).toBe('Qto_WallBaseQuantities');
  });

  it('an empty same-named set does not suppress a populated one from the other source', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      // Source 1 (HasPropertySets): an EMPTY Qto_WallBaseQuantities.
      `#200=IFCWALLTYPE('guid2',$,'Wall Type E',$,$,(#300),$,'tag',$,.STANDARD.);`,
      `#300=IFCELEMENTQUANTITY('guid3',$,'Qto_WallBaseQuantities',$,$,());`,
      // Source 2 (onDemandQuantityMap): a POPULATED set with the same name.
      `#400=IFCELEMENTQUANTITY('guid4',$,'Qto_WallBaseQuantities',$,$,(#410));`,
      `#410=IFCQUANTITYLENGTH('Width',$,$,0.3);`,
    ];
    const store = buildStoreFromStep(lines, {
      quantityMap: new Map<number, number[]>([[200, [400]]]),
      relationships: [{ entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] }],
    });

    const result = extractTypeQuantitiesOnDemand(store, 100);
    expect(result).not.toBeNull();
    expect(result!.quantities).toHaveLength(1);
    expect(result!.quantities[0].name).toBe('Qto_WallBaseQuantities');
    expect(result!.quantities[0].quantities[0].name).toBe('Width');
  });

  it('returns null when the type carries no quantities', () => {
    const lines = [
      `#100=IFCWALL('guid1',$,'My Wall',$,$,$,$,$);`,
      `#200=IFCWALLTYPE('guid2',$,'Wall Type D',$,$,(#300),$,'tag',$,.STANDARD.);`,
      `#300=IFCPROPERTYSET('guid3',$,'Pset_WallCommon',$,(#310));`,
      `#310=IFCPROPERTYSINGLEVALUE('FireRating',$,'REI 60',$);`,
    ];
    const store = buildStoreFromStep(lines, {
      relationships: [{ entityId: 100, relType: RelationshipType.DefinesByType, direction: 'inverse', targetIds: [200] }],
    });

    expect(extractTypeQuantitiesOnDemand(store, 100)).toBeNull();
  });
});
