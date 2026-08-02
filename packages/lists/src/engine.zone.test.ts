/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Location-zone column/condition support (issue #1810). The `zone` source
 * bridges a viewer-computed classification (which zone box each element's
 * centroid falls into, plus a "straddles" flag when its bounds cross a
 * boundary) into a list column/filter, entirely independent of IFC pset
 * data — the assignment math itself is unit-tested in
 * `apps/viewer/src/lib/zones`; this only exercises the engine's resolution
 * of the `getZoneAssignment` provider hook.
 */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList } from './engine.js';
import type { ListDataProvider, ListDefinition } from './types.js';

type Assignment = { zoneName: string | null; straddles: boolean; touchedZoneNames: string[] };

function createProvider(assignments: Map<number, Assignment>): ListDataProvider {
  return {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1, 2, 3] : []),
    getEntityName: (id) => `Wall-${id}`,
    getEntityGlobalId: (id) => `guid-${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: () => 'IfcWall',
    getPropertySets: () => [],
    getQuantitySets: () => [],
    getZoneAssignment: (id, setId) => (setId === 'sections' ? assignments.get(id) ?? null : null),
    getZoneSetNames: () => [{ id: 'sections', name: 'Sections' }],
  };
}

function walls(columns: ListDefinition['columns'], conditions: ListDefinition['conditions'] = []): ListDefinition {
  return { id: 't', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], conditions, columns };
}

describe('zone column/condition (#1810)', () => {
  const assignments = new Map<number, Assignment>([
    [1, { zoneName: 'Section A', straddles: false, touchedZoneNames: [] }],
    [2, { zoneName: null, straddles: true, touchedZoneNames: ['Section A', 'Section B'] }],
    [3, { zoneName: null, straddles: false, touchedZoneNames: [] }], // unassigned
  ]);

  it('resolves the zone name for a cleanly-assigned element', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      createProvider(assignments),
    );
    expect(result.rows.find(r => r.entityId === 1)!.values[0]).toBe('Section A');
  });

  it('joins the touched zone names when the element straddles a boundary', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      createProvider(assignments),
    );
    expect(result.rows.find(r => r.entityId === 2)!.values[0]).toBe('Section A, Section B');
  });

  it('resolves null for an unassigned element', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      createProvider(assignments),
    );
    expect(result.rows.find(r => r.entityId === 3)!.values[0]).toBe(null);
  });

  it('resolves the Straddles boolean column independent of the Zone column', () => {
    const result = executeList(
      walls([{ id: 's', source: 'zone', psetName: 'sections', propertyName: 'Straddles' }]),
      createProvider(assignments),
    );
    expect(result.rows.map(r => r.values[0])).toEqual([false, true, false]);
  });

  it('an unknown zone-set id resolves to null (provider has no data for it)', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'takt', propertyName: 'Zone' }]),
      createProvider(assignments),
    );
    expect(result.rows.every(r => r.values[0] === null)).toBe(true);
  });

  it('filters rows via a zone equals condition', () => {
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }], [
        { source: 'zone', psetName: 'sections', propertyName: 'Zone', operator: 'equals', value: 'Section A' },
      ]),
      createProvider(assignments),
    );
    expect(result.rows.map(r => r.entityId)).toEqual([1]);
  });

  it('a provider with no getZoneAssignment resolves every zone column to null (backward compatible)', () => {
    const provider: ListDataProvider = {
      getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1] : []),
      getEntityName: () => 'Wall-1',
      getEntityGlobalId: () => 'guid-1',
      getEntityDescription: () => '',
      getEntityObjectType: () => '',
      getEntityTag: () => '',
      getEntityTypeName: () => 'IfcWall',
      getPropertySets: () => [],
      getQuantitySets: () => [],
    };
    const result = executeList(
      walls([{ id: 'z', source: 'zone', psetName: 'sections', propertyName: 'Zone' }]),
      provider,
    );
    expect(result.rows[0].values[0]).toBe(null);
  });
});
