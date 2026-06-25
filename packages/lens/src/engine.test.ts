/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { evaluateLens, evaluateAutoColorLens } from './engine.js';
import { GHOST_COLOR, hexToRgba } from './colors.js';
import type { Lens, LensDataProvider, AutoColorSpec } from './types.js';

/** Simple mock provider from entity list */
function createMockProvider(entities: Array<{
  id: number;
  type: string;
}>): LensDataProvider {
  const entityMap = new Map(entities.map(e => [e.id, e]));

  return {
    getEntityCount: () => entities.length,
    forEachEntity: (cb) => {
      for (const e of entities) cb(e.id, 'model-1');
    },
    getEntityType: (id) => entityMap.get(id)?.type,
    getPropertyValue: () => undefined,
    getPropertySets: () => [],
  };
}

describe('evaluateLens', () => {
  it('should return empty results for lens with no enabled rules', () => {
    const lens: Lens = {
      id: 'test',
      name: 'Test',
      rules: [
        { id: 'r1', name: 'Disabled', enabled: false, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#FF0000' },
      ],
    };
    const provider = createMockProvider([{ id: 1, type: 'IfcWall' }]);
    const result = evaluateLens(lens, provider);

    expect(result.colorMap.size).toBe(0);
    expect(result.hiddenIds.size).toBe(0);
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });

  it('should colorize matching entities and ghost non-matches', () => {
    const lens: Lens = {
      id: 'test',
      name: 'Test',
      rules: [
        { id: 'r1', name: 'Walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#FF0000' },
      ],
    };
    const provider = createMockProvider([
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcSlab' },
    ]);
    const result = evaluateLens(lens, provider);

    expect(result.colorMap.get(1)).toEqual(hexToRgba('#FF0000', 1));
    expect(result.colorMap.get(2)).toEqual(GHOST_COLOR);
    expect(result.ruleCounts.get('r1')).toBe(1);
  });

  it('should hide entities with hide action', () => {
    const lens: Lens = {
      id: 'test',
      name: 'Test',
      rules: [
        { id: 'r1', name: 'Hide Slabs', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcSlab' }, action: 'hide', color: '#000000' },
      ],
    };
    const provider = createMockProvider([
      { id: 1, type: 'IfcSlab' },
      { id: 2, type: 'IfcWall' },
    ]);
    const result = evaluateLens(lens, provider);

    expect(result.hiddenIds.has(1)).toBe(true);
    expect(result.hiddenIds.has(2)).toBe(false);
    expect(result.colorMap.has(1)).toBe(false); // Hidden, not colored
    expect(result.colorMap.get(2)).toEqual(GHOST_COLOR);
  });

  it('should apply transparent action with alpha 0.3', () => {
    const lens: Lens = {
      id: 'test',
      name: 'Test',
      rules: [
        { id: 'r1', name: 'Transparent Walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'transparent', color: '#00FF00' },
      ],
    };
    const provider = createMockProvider([{ id: 1, type: 'IfcWall' }]);
    const result = evaluateLens(lens, provider);

    const color = result.colorMap.get(1);
    expect(color).toBeDefined();
    expect(color![3]).toBeCloseTo(0.3);
  });

  it('should match first rule only (short-circuit)', () => {
    const lens: Lens = {
      id: 'test',
      name: 'Test',
      rules: [
        { id: 'r1', name: 'Walls Red', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#FF0000' },
        { id: 'r2', name: 'Walls Blue', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#0000FF' },
      ],
    };
    const provider = createMockProvider([{ id: 1, type: 'IfcWall' }]);
    const result = evaluateLens(lens, provider);

    // First rule (red) should win
    expect(result.colorMap.get(1)).toEqual(hexToRgba('#FF0000', 1));
    expect(result.ruleCounts.get('r1')).toBe(1);
    expect(result.ruleCounts.get('r2')).toBe(0);
  });

  it('should count matches per rule correctly', () => {
    const lens: Lens = {
      id: 'test',
      name: 'Test',
      rules: [
        { id: 'r-wall', name: 'Walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#FF0000' },
        { id: 'r-slab', name: 'Slabs', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcSlab' }, action: 'colorize', color: '#0000FF' },
      ],
    };
    const provider = createMockProvider([
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcWall' },
      { id: 3, type: 'IfcSlab' },
      { id: 4, type: 'IfcDoor' },
    ]);
    const result = evaluateLens(lens, provider);

    expect(result.ruleCounts.get('r-wall')).toBe(2);
    expect(result.ruleCounts.get('r-slab')).toBe(1);
    // Door is ghosted
    expect(result.colorMap.get(4)).toEqual(GHOST_COLOR);
  });

  it('should return execution time', () => {
    const lens: Lens = {
      id: 'test',
      name: 'Test',
      rules: [
        { id: 'r1', name: 'Walls', enabled: true, criteria: { type: 'ifcType', ifcType: 'IfcWall' }, action: 'colorize', color: '#FF0000' },
      ],
    };
    const provider = createMockProvider([{ id: 1, type: 'IfcWall' }]);
    const result = evaluateLens(lens, provider);

    expect(typeof result.executionTime).toBe('number');
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// evaluateAutoColorLens
// ============================================================================

describe('evaluateAutoColorLens', () => {
  it('should group entities by IFC type and assign distinct colors', () => {
    const provider = createMockProvider([
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcWall' },
      { id: 3, type: 'IfcSlab' },
      { id: 4, type: 'IfcColumn' },
    ]);

    const spec: AutoColorSpec = { source: 'ifcType' };
    const result = evaluateAutoColorLens(spec, provider);

    // All 4 entities should have colors (3 groups)
    expect(result.colorMap.size).toBe(4);
    expect(result.legend.length).toBe(3);

    // Walls (2 entities) should be the largest group → first color
    const wallEntry = result.legend.find(e => e.name === 'IfcWall');
    expect(wallEntry).toBeDefined();
    expect(wallEntry!.count).toBe(2);

    // Each group gets a distinct color from uniqueColor()
    const colors = result.legend.map(e => e.color);
    expect(new Set(colors).size).toBe(3); // all distinct
  });

  it('should ghost entities with empty/null values', () => {
    const provider = createMockProvider([
      { id: 1, type: 'IfcWall' },
      { id: 2, type: '' },
    ]);

    const spec: AutoColorSpec = { source: 'ifcType' };
    const result = evaluateAutoColorLens(spec, provider);

    // Entity with empty type should be ghosted
    expect(result.colorMap.get(2)).toEqual(GHOST_COLOR);
    expect(result.legend.length).toBe(1); // Only "IfcWall"
  });

  it('should auto-color by attribute when provider supports it', () => {
    const entities = [
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcWall' },
      { id: 3, type: 'IfcSlab' },
    ];
    const provider = createMockProvider(entities);
    (provider as Record<string, unknown>).getEntityAttribute = (id: number, attr: string) => {
      if (attr === 'Name') {
        if (id === 1) return 'Wall A';
        if (id === 2) return 'Wall A';
        if (id === 3) return 'Slab B';
      }
      return undefined;
    };

    const spec: AutoColorSpec = { source: 'attribute', propertyName: 'Name' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(result.legend.length).toBe(2); // "Wall A" and "Slab B"
    const wallGroup = result.legend.find(e => e.name === 'Wall A');
    expect(wallGroup!.count).toBe(2);
  });

  it('should sort legend by count descending (largest group first)', () => {
    const provider = createMockProvider([
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcWall' },
      { id: 3, type: 'IfcWall' },
      { id: 4, type: 'IfcSlab' },
      { id: 5, type: 'IfcColumn' },
      { id: 6, type: 'IfcColumn' },
    ]);

    const spec: AutoColorSpec = { source: 'ifcType' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(result.legend[0].name).toBe('IfcWall');
    expect(result.legend[0].count).toBe(3);
    expect(result.legend[1].count).toBe(2);
    expect(result.legend[2].count).toBe(1);
  });

  it('should populate ruleEntityIds for isolation', () => {
    const provider = createMockProvider([
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcSlab' },
    ]);

    const spec: AutoColorSpec = { source: 'ifcType' };
    const result = evaluateAutoColorLens(spec, provider);

    // Each legend entry has a corresponding ruleEntityIds entry
    for (const entry of result.legend) {
      const ids = result.ruleEntityIds.get(entry.id);
      expect(ids).toBeDefined();
      expect(ids!.length).toBe(entry.count);
    }
  });

  it('should return execution time', () => {
    const provider = createMockProvider([{ id: 1, type: 'IfcWall' }]);
    const spec: AutoColorSpec = { source: 'ifcType' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(typeof result.executionTime).toBe('number');
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });

  it('should group a multi-material element under EVERY one of its materials (#1366)', () => {
    // 4 walls with Gypsum, plus Insulation on three of them; one is single-mat.
    const materials = new Map<number, string[]>([
      [1, ['Gypsum']],
      [2, ['Gypsum', 'Insulation']],
      [3, ['Gypsum', 'Insulation']],
      [4, ['Insulation']],
    ]);
    const provider: LensDataProvider = {
      getEntityCount: () => materials.size,
      forEachEntity: (cb) => { for (const id of materials.keys()) cb(id, 'm1'); },
      getEntityType: () => 'IfcWall',
      getPropertyValue: () => undefined,
      getPropertySets: () => [],
      getMaterialNames: (id) => materials.get(id) ?? [],
    };

    const result = evaluateAutoColorLens({ source: 'material' }, provider);

    const byName = new Map(result.legend.map(e => [e.name, e]));
    expect(new Set(byName.keys())).toEqual(new Set(['Gypsum', 'Insulation']));
    // Gypsum: walls 1,2,3 — Insulation: walls 2,3,4. Multi-material walls
    // appear in BOTH buckets (previously they bucketed by the layer-set name).
    expect(new Set(result.ruleEntityIds.get(byName.get('Gypsum')!.id))).toEqual(new Set([1, 2, 3]));
    expect(new Set(result.ruleEntityIds.get(byName.get('Insulation')!.id))).toEqual(new Set([2, 3, 4]));
    expect(byName.get('Gypsum')!.count).toBe(3);
    expect(byName.get('Insulation')!.count).toBe(3);
    // Every element still renders in exactly one colour.
    for (const id of materials.keys()) {
      expect(result.colorMap.has(id)).toBe(true);
    }
  });

  it('falls back to single getMaterialName when getMaterialNames is absent', () => {
    const provider: LensDataProvider = {
      getEntityCount: () => 1,
      forEachEntity: (cb) => cb(1, 'm1'),
      getEntityType: () => 'IfcWall',
      getPropertyValue: () => undefined,
      getPropertySets: () => [],
      getMaterialName: () => 'Concrete',
    };
    const result = evaluateAutoColorLens({ source: 'material' }, provider);
    expect(result.legend.map(e => e.name)).toEqual(['Concrete']);
    expect(result.ruleEntityIds.get(result.legend[0].id)).toEqual([1]);
  });

  it('should auto-color by property when provider supports getPropertyValue', () => {
    const entities = [
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcWall' },
      { id: 3, type: 'IfcSlab' },
    ];
    const provider = createMockProvider(entities);
    (provider as Record<string, unknown>).getPropertyValue = (id: number, pset: string, prop: string) => {
      if (pset === 'Pset_WallCommon' && prop === 'IsExternal') {
        if (id === 1) return 'True';
        if (id === 2) return 'False';
      }
      return undefined;
    };

    const spec: AutoColorSpec = { source: 'property', psetName: 'Pset_WallCommon', propertyName: 'IsExternal' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(result.legend.length).toBe(2); // "True" and "False"
    expect(result.colorMap.size).toBe(3); // 2 matched + 1 ghosted (entity 3)
    expect(result.colorMap.get(3)).toEqual(GHOST_COLOR);
  });

  it('should auto-color by quantity when provider supports getQuantityValue', () => {
    const entities = [
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcWall' },
      { id: 3, type: 'IfcSlab' },
    ];
    const provider = createMockProvider(entities);
    (provider as Record<string, unknown>).getQuantityValue = (id: number, qset: string, qname: string) => {
      if (qset === 'Qto_WallBaseQuantities' && qname === 'Width') {
        if (id === 1) return 0.3;
        if (id === 2) return 0.3;
      }
      return undefined;
    };

    const spec: AutoColorSpec = { source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Width' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(result.legend.length).toBe(1); // "0.3"
    const group = result.legend[0];
    expect(group.count).toBe(2);
    expect(result.colorMap.get(3)).toEqual(GHOST_COLOR);
  });

  it('should auto-color by classification when provider supports getClassifications', () => {
    const entities = [
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcSlab' },
      { id: 3, type: 'IfcColumn' },
    ];
    const provider = createMockProvider(entities);
    (provider as Record<string, unknown>).getClassifications = (id: number) => {
      if (id === 1) return [{ system: 'Uniclass', identification: 'EF_25_10', name: 'Walls' }];
      if (id === 2) return [{ system: 'Uniclass', identification: 'EF_25_30', name: 'Floors' }];
      return [];
    };

    const spec: AutoColorSpec = { source: 'classification', psetName: 'Uniclass' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(result.legend.length).toBe(2); // two classification values
    expect(result.colorMap.get(3)).toEqual(GHOST_COLOR); // no classification → ghost
  });

  it('should honor psetName as a classification-system filter for multi-system entities', () => {
    const entities = [
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcSlab' },
    ];
    const provider = createMockProvider(entities);
    // Each entity carries references from two classification systems. The first
    // reference is Uniclass; psetName must steer grouping to OmniClass instead.
    (provider as Record<string, unknown>).getClassifications = (id: number) => {
      if (id === 1) {
        return [
          { system: 'Uniclass', identification: 'EF_25_10', name: 'Walls' },
          { system: 'OmniClass', identification: '23-13', name: 'Walls' },
        ];
      }
      if (id === 2) {
        return [
          { system: 'Uniclass', identification: 'EF_25_30', name: 'Floors' },
          { system: 'OmniClass', identification: '23-13', name: 'Floors' },
        ];
      }
      return [];
    };

    const spec: AutoColorSpec = { source: 'classification', psetName: 'OmniClass' };
    const result = evaluateAutoColorLens(spec, provider);

    // Both entities share the same OmniClass code → a single group.
    expect(result.legend.length).toBe(1);
    expect(result.legend[0].name).toBe('OmniClass: 23-13');
    expect(result.legend[0].count).toBe(2);
  });

  it('should auto-color by material when provider supports getMaterialName', () => {
    const entities = [
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcWall' },
      { id: 3, type: 'IfcSlab' },
    ];
    const provider = createMockProvider(entities);
    (provider as Record<string, unknown>).getMaterialName = (id: number) => {
      if (id === 1) return 'Concrete';
      if (id === 2) return 'Concrete';
      if (id === 3) return 'Steel';
      return undefined;
    };

    const spec: AutoColorSpec = { source: 'material' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(result.legend.length).toBe(2); // "Concrete" and "Steel"
    const concreteGroup = result.legend.find(e => e.name === 'Concrete');
    expect(concreteGroup!.count).toBe(2);
  });

  it('should gracefully handle missing optional provider methods', () => {
    const provider = createMockProvider([
      { id: 1, type: 'IfcWall' },
      { id: 2, type: 'IfcSlab' },
    ]);
    // Provider has no getPropertyValue, getMaterialName, etc.

    const spec: AutoColorSpec = { source: 'property', psetName: 'Pset_WallCommon', propertyName: 'IsExternal' };
    const result = evaluateAutoColorLens(spec, provider);

    // All entities should be ghosted (no property data available)
    expect(result.legend.length).toBe(0);
    for (const [, color] of result.colorMap) {
      expect(color).toEqual(GHOST_COLOR);
    }
  });

  it('should generate unique colors for any number of distinct values', () => {
    const entities = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      type: `IfcType${i}`,
    }));
    const provider = createMockProvider(entities);

    const spec: AutoColorSpec = { source: 'ifcType' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(result.legend.length).toBe(30);
    // All 30 colors should be unique (no repeats)
    const colors = new Set(result.legend.map(l => l.color));
    expect(colors.size).toBe(30);
  });

  it('should auto-color by model when provider supports getModelId', () => {
    const entities = [
      { id: 1, type: 'IfcWall', modelId: 'model-a' },
      { id: 2, type: 'IfcWall', modelId: 'model-a' },
      { id: 3, type: 'IfcSlab', modelId: 'model-b' },
    ];
    const entityMap = new Map(entities.map(e => [e.id, e]));
    const modelNames = new Map([
      ['model-a', 'Building A.ifc'],
      ['model-b', 'Building B.ifc'],
    ]);

    const provider = createMockProvider(entities);
    (provider as LensDataProvider).getModelId = (id) => entityMap.get(id)?.modelId;
    (provider as LensDataProvider).getModelName = (modelId) => modelNames.get(modelId);

    const spec: AutoColorSpec = { source: 'model' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(result.legend.length).toBe(2);
    expect(result.colorMap.size).toBe(3);

    const groupA = result.legend.find(e => e.name === 'Building A.ifc');
    const groupB = result.legend.find(e => e.name === 'Building B.ifc');
    expect(groupA).toBeDefined();
    expect(groupA!.count).toBe(2);
    expect(groupB).toBeDefined();
    expect(groupB!.count).toBe(1);

    const colors = new Set(result.legend.map(e => e.color));
    expect(colors.size).toBe(2);
  });

  it('should auto-color single model as one group', () => {
    const entities = [
      { id: 1, type: 'IfcWall', modelId: 'legacy' },
      { id: 2, type: 'IfcSlab', modelId: 'legacy' },
    ];
    const entityMap = new Map(entities.map(e => [e.id, e]));

    const provider = createMockProvider(entities);
    (provider as LensDataProvider).getModelId = (id) => entityMap.get(id)?.modelId;
    (provider as LensDataProvider).getModelName = () => 'Model';

    const spec: AutoColorSpec = { source: 'model' };
    const result = evaluateAutoColorLens(spec, provider);

    expect(result.legend.length).toBe(1);
    expect(result.legend[0].name).toBe('Model');
    expect(result.legend[0].count).toBe(2);
  });
});

// ============================================================================
// evaluateAutoColorLens — "By Zone" (group) source (#1075)
// ============================================================================

/** Mock provider where each entity belongs to a set of groups/zones. */
function createGroupProvider(
  entities: Array<{ id: number; groups: Array<{ id: number; name?: string; type: string; objectType?: string }> }>,
): LensDataProvider {
  const map = new Map(entities.map((e) => [e.id, e]));
  return {
    getEntityCount: () => entities.length,
    forEachEntity: (cb) => { for (const e of entities) cb(e.id, 'model-1'); },
    getEntityType: () => 'IfcSpace',
    getPropertyValue: () => undefined,
    getPropertySets: () => [],
    getEntityGroups: (id) => map.get(id)?.groups ?? [],
  };
}

describe('evaluateAutoColorLens — By Zone', () => {
  it('buckets by distinct named zones instead of collapsing to one (#1075 47-vs-4)', () => {
    // Each space sits in its own named zone — must yield one legend entry per zone.
    const provider = createGroupProvider([
      { id: 1, groups: [{ id: 100, name: 'Dwelling A', type: 'IfcZone' }] },
      { id: 2, groups: [{ id: 101, name: 'Dwelling B', type: 'IfcZone' }] },
      { id: 3, groups: [{ id: 102, name: 'Dwelling C', type: 'IfcZone' }] },
    ]);
    const result = evaluateAutoColorLens({ source: 'group' }, provider);
    expect(result.legend.map((e) => e.name).sort()).toEqual(['Dwelling A', 'Dwelling B', 'Dwelling C']);
  });

  it('prefers the IfcZone membership when an element is in several groups', () => {
    const provider = createGroupProvider([
      { id: 1, groups: [
        { id: 200, name: 'HVAC', type: 'IfcDistributionSystem' },
        { id: 201, name: 'Fire Compartment 1', type: 'IfcZone' },
      ] },
    ]);
    const result = evaluateAutoColorLens({ source: 'group' }, provider);
    expect(result.legend).toHaveLength(1);
    expect(result.legend[0].name).toBe('Fire Compartment 1');
  });

  it('falls back to ObjectType (system type) when a group has no name', () => {
    const provider = createGroupProvider([
      { id: 1, groups: [{ id: 300, type: 'IfcDistributionSystem', objectType: 'AHU-01' }] },
    ]);
    const result = evaluateAutoColorLens({ source: 'group' }, provider);
    expect(result.legend[0].name).toBe('IfcDistributionSystem: AHU-01');
  });

  it('ghosts elements with no group membership', () => {
    const provider = createGroupProvider([
      { id: 1, groups: [{ id: 400, name: 'Zone A', type: 'IfcZone' }] },
      { id: 2, groups: [] },
    ]);
    const result = evaluateAutoColorLens({ source: 'group' }, provider);
    expect(result.legend).toHaveLength(1);
    expect(result.colorMap.get(2)).toEqual(GHOST_COLOR);
  });
});
