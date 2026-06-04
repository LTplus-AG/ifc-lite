/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import { executeList, listResultToCSV } from './engine.js';
import { discoverColumns } from './discovery.js';
import { LIST_PRESETS } from './presets.js';
import type { ListDataProvider, ListDefinition } from './types.js';

// ============================================================================
// Mock Data Provider
// ============================================================================

function createMockProvider(): ListDataProvider {
  const entities = new Map<number, { name: string; globalId: string; type: string; desc: string; objType: string }>([
    [1, { name: 'Wall-01', globalId: '0abc', type: 'IfcWall', desc: 'Exterior wall', objType: 'Basic Wall' }],
    [2, { name: 'Wall-02', globalId: '1def', type: 'IfcWall', desc: 'Interior wall', objType: 'Basic Wall' }],
    [3, { name: 'Slab-01', globalId: '2ghi', type: 'IfcSlab', desc: 'Floor slab', objType: 'Floor' }],
  ]);

  const typeIndex = new Map<IfcTypeEnum, number[]>([
    [IfcTypeEnum.IfcWall, [1, 2]],
    [IfcTypeEnum.IfcSlab, [3]],
  ]);

  const propertySets = new Map<number, Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>>([
    [1, [
      { name: 'Pset_WallCommon', properties: [
        { name: 'IsExternal', value: ['IFCBOOLEAN', '.T.'] },
        { name: 'FireRating', value: 'REI 90' },
        { name: 'LoadBearing', value: ['IFCBOOLEAN', '.T.'] },
      ]},
    ]],
    [2, [
      { name: 'Pset_WallCommon', properties: [
        { name: 'IsExternal', value: ['IFCBOOLEAN', '.F.'] },
        { name: 'FireRating', value: 'EI 30' },
        { name: 'LoadBearing', value: ['IFCBOOLEAN', '.F.'] },
      ]},
    ]],
    [3, []],
  ]);

  const quantitySets = new Map<number, Array<{ name: string; quantities: Array<{ name: string; value: number; type: number }> }>>([
    [1, [
      { name: 'Qto_WallBaseQuantities', quantities: [
        { name: 'Length', value: 5.0, type: 0 },
        { name: 'Height', value: 2.8, type: 0 },
        { name: 'Width', value: 0.2, type: 0 },
      ]},
    ]],
    [2, [
      { name: 'Qto_WallBaseQuantities', quantities: [
        { name: 'Length', value: 3.5, type: 0 },
        { name: 'Height', value: 2.8, type: 0 },
        { name: 'Width', value: 0.15, type: 0 },
      ]},
    ]],
    [3, [
      { name: 'Qto_SlabBaseQuantities', quantities: [
        { name: 'GrossArea', value: 45.2, type: 1 },
        { name: 'GrossVolume', value: 9.04, type: 2 },
      ]},
    ]],
  ]);

  const materialNames = new Map<number, string[]>([
    [1, ['Concrete C30/37']],
    [2, ['Brick', 'Rigid Insulation']],
    [3, ['Concrete C30/37']],
  ]);

  const classifications = new Map<number, Array<{ system?: string; code?: string; name?: string }>>([
    [1, [{ system: 'Uniclass 2015', code: 'Pr_20_93', name: 'External wall' }]],
    [2, []],
    [3, [{ system: 'Uniclass 2015', code: 'Ss_30_10', name: 'Floor slab' }]],
  ]);

  const storeyNames = new Map<number, string>([
    [1, 'Level 0'],
    [2, 'Level 1'],
    [3, 'Level 0'],
  ]);

  return {
    getEntitiesByType: (type) => typeIndex.get(type) ?? [],
    getEntityName: (id) => entities.get(id)?.name ?? '',
    getEntityGlobalId: (id) => entities.get(id)?.globalId ?? '',
    getEntityDescription: (id) => entities.get(id)?.desc ?? '',
    getEntityObjectType: (id) => entities.get(id)?.objType ?? '',
    getEntityTag: () => '',
    getEntityTypeName: (id) => entities.get(id)?.type ?? '',
    getPropertySets: (id) => propertySets.get(id) ?? [],
    getQuantitySets: (id) => quantitySets.get(id) ?? [],
    getAllEntityIds: () => Array.from(entities.keys()),
    getMaterialNames: (id) => materialNames.get(id) ?? [],
    getClassifications: (id) => classifications.get(id) ?? [],
    getStoreyName: (id) => storeyNames.get(id) ?? '',
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('executeList', () => {
  it('returns rows for matching entity types', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'test-1',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall],
      conditions: [],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
        { id: 'class', source: 'attribute', propertyName: 'Class' },
      ],
    };

    const result = executeList(def, provider);
    expect(result.totalCount).toBe(2);
    expect(result.rows[0].values[0]).toBe('Wall-01');
    expect(result.rows[1].values[0]).toBe('Wall-02');
    expect(result.rows[0].values[1]).toBe('IfcWall');
  });

  it('extracts property values with IFC type resolution', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'test-2',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall],
      conditions: [],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
        { id: 'ext', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'IsExternal' },
        { id: 'fire', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating' },
      ],
    };

    const result = executeList(def, provider);
    expect(result.totalCount).toBe(2);
    // IsExternal should be resolved from ['IFCBOOLEAN', '.T.'] to 'True'
    expect(result.rows[0].values[1]).toBe('True');
    expect(result.rows[1].values[1]).toBe('False');
    // FireRating is a plain string
    expect(result.rows[0].values[2]).toBe('REI 90');
  });

  it('extracts quantity values with unit formatting', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'test-3',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall],
      conditions: [],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
        { id: 'len', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Length' },
      ],
    };

    const result = executeList(def, provider);
    expect(result.totalCount).toBe(2);
    // Length = 5.0, returned as raw number for sortability
    expect(result.rows[0].values[1]).toBe(5.0);
  });

  it('filters by conditions', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'test-4',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall],
      conditions: [
        { source: 'attribute', propertyName: 'Name', operator: 'contains', value: '01' },
      ],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
      ],
    };

    const result = executeList(def, provider);
    expect(result.totalCount).toBe(1);
    expect(result.rows[0].values[0]).toBe('Wall-01');
  });

  it('returns null for missing properties', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'test-5',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcSlab],
      conditions: [],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
        { id: 'ext', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'IsExternal' },
      ],
    };

    const result = executeList(def, provider);
    expect(result.totalCount).toBe(1);
    expect(result.rows[0].values[0]).toBe('Slab-01');
    expect(result.rows[0].values[1]).toBeNull();
  });

  it('handles multiple entity types', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'test-6',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall, IfcTypeEnum.IfcSlab],
      conditions: [],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
      ],
    };

    const result = executeList(def, provider);
    expect(result.totalCount).toBe(3);
  });

  it('targets all elements when entityTypes is empty (no class constraint)', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'test-all',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [],
      conditions: [
        { source: 'attribute', propertyName: 'Name', operator: 'contains', value: '01' },
      ],
      columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
    };

    const result = executeList(def, provider);
    // Wall-01 and Slab-01 match across all classes.
    expect(result.rows.map(r => r.values[0]).sort()).toEqual(['Slab-01', 'Wall-01']);
  });

  it('filters by material name (multi-valued, any-match)', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'test-mat',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [],
      conditions: [
        { source: 'material', propertyName: 'Material', operator: 'contains', value: 'insulation' },
      ],
      columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
    };
    const result = executeList(def, provider);
    // Only Wall-02 has an insulation layer.
    expect(result.rows.map(r => r.values[0])).toEqual(['Wall-02']);
  });

  it('filters by classification code or name', () => {
    const provider = createMockProvider();
    const byCode = executeList({
      id: 'c1', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [],
      conditions: [{ source: 'classification', propertyName: 'Classification', operator: 'contains', value: 'Pr_20' }],
      columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
    }, provider);
    expect(byCode.rows.map(r => r.values[0])).toEqual(['Wall-01']);

    const byName = executeList({
      id: 'c2', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [],
      conditions: [{ source: 'classification', propertyName: 'Classification', operator: 'contains', value: 'slab' }],
      columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
    }, provider);
    expect(byName.rows.map(r => r.values[0])).toEqual(['Slab-01']);
  });

  it('classification exists matches only classified elements', () => {
    const provider = createMockProvider();
    const result = executeList({
      id: 'c3', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [],
      conditions: [{ source: 'classification', propertyName: 'Classification', operator: 'exists', value: '' }],
      columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
    }, provider);
    // Wall-02 has no classification.
    expect(result.rows.map(r => r.values[0]).sort()).toEqual(['Slab-01', 'Wall-01']);
  });

  it('filters by storey (spatial source)', () => {
    const provider = createMockProvider();
    const result = executeList({
      id: 'sp1', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [],
      conditions: [{ source: 'spatial', propertyName: 'Storey', operator: 'equals', value: 'Level 0' }],
      columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
    }, provider);
    expect(result.rows.map(r => r.values[0]).sort()).toEqual(['Slab-01', 'Wall-01']);
  });

  it('class-less targeting yields nothing when the provider cannot enumerate', () => {
    const provider = createMockProvider();
    // Simulate an older provider without getAllEntityIds.
    delete (provider as { getAllEntityIds?: unknown }).getAllEntityIds;
    const result = executeList({
      id: 'noall', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [],
      conditions: [],
      columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
    }, provider);
    expect(result.totalCount).toBe(0);
  });

  it('sorts results when sortBy is configured', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'test-7',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall],
      conditions: [],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
      ],
      sortBy: { columnId: 'name', direction: 'desc' },
    };

    const result = executeList(def, provider);
    expect(result.rows[0].values[0]).toBe('Wall-02');
    expect(result.rows[1].values[0]).toBe('Wall-01');
  });
});

describe('listResultToCSV', () => {
  it('produces valid CSV output', () => {
    const provider = createMockProvider();
    const def: ListDefinition = {
      id: 'csv-test',
      name: 'Test',
      createdAt: 0,
      updatedAt: 0,
      entityTypes: [IfcTypeEnum.IfcWall],
      conditions: [],
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
        { id: 'fire', source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating', label: 'Fire Rating' },
      ],
    };

    const result = executeList(def, provider);
    const csv = listResultToCSV(result);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('Name,Fire Rating');
    expect(lines.length).toBe(3); // header + 2 rows
  });

  it('escapes values with commas and quotes', () => {
    const csv = listResultToCSV({
      columns: [{ id: 'a', source: 'attribute', propertyName: 'Name' }],
      rows: [{ entityId: 1, modelId: 'default', values: ['Hello, "World"'] }],
      totalCount: 1,
      executionTime: 0,
    });

    expect(csv).toContain('"Hello, ""World"""');
  });
});

describe('discoverColumns', () => {
  it('discovers attributes, properties and quantities', () => {
    const provider = createMockProvider();
    const result = discoverColumns(provider, [IfcTypeEnum.IfcWall]);

    expect(result.attributes).toContain('Name');
    expect(result.attributes).toContain('GlobalId');

    expect(result.properties.has('Pset_WallCommon')).toBe(true);
    expect(result.properties.get('Pset_WallCommon')).toContain('IsExternal');
    expect(result.properties.get('Pset_WallCommon')).toContain('FireRating');

    expect(result.quantities.has('Qto_WallBaseQuantities')).toBe(true);
    expect(result.quantities.get('Qto_WallBaseQuantities')).toContain('Length');
  });

  it('works with multiple providers', () => {
    const p1 = createMockProvider();
    const p2 = createMockProvider();
    const result = discoverColumns([p1, p2], [IfcTypeEnum.IfcWall]);

    expect(result.properties.has('Pset_WallCommon')).toBe(true);
  });

  it('discovers columns across multiple types', () => {
    const provider = createMockProvider();
    const result = discoverColumns(provider, [IfcTypeEnum.IfcWall, IfcTypeEnum.IfcSlab]);

    expect(result.quantities.has('Qto_WallBaseQuantities')).toBe(true);
    expect(result.quantities.has('Qto_SlabBaseQuantities')).toBe(true);
  });
});

describe('LIST_PRESETS', () => {
  it('contains at least 3 presets', () => {
    expect(LIST_PRESETS.length).toBeGreaterThanOrEqual(3);
  });

  it('all presets have required fields', () => {
    for (const preset of LIST_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(preset.entityTypes.length).toBeGreaterThan(0);
      expect(preset.columns.length).toBeGreaterThan(0);
    }
  });
});
