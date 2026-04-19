/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { discoverClasses, discoverDataSources } from './discovery.js';
import type { LensDataProvider } from './types.js';

function createMockProvider(overrides: Partial<LensDataProvider> = {}): LensDataProvider {
  return {
    getEntityCount: () => 3,
    forEachEntity: (cb) => {
      cb(1, 'model-1');
      cb(2, 'model-1');
      cb(3, 'model-1');
    },
    getEntityType: (id) => {
      if (id === 1) return 'IfcWall';
      if (id === 2) return 'IfcSlab';
      if (id === 3) return 'IfcWall';
      return undefined;
    },
    getPropertyValue: () => undefined,
    getPropertySets: (id) => {
      if (id === 1) return [
        { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }, { name: 'FireRating', value: '30' }] },
      ];
      if (id === 2) return [
        { name: 'Pset_SlabCommon', properties: [{ name: 'IsExternal', value: false }] },
      ];
      return [];
    },
    ...overrides,
  };
}

describe('discoverClasses', () => {
  it('discovers IFC classes from all entities (instant)', () => {
    const provider = createMockProvider();
    const classes = discoverClasses(provider);
    expect(classes).toEqual(['IfcSlab', 'IfcWall']);
  });

  it('returns empty array for empty model', () => {
    const provider = createMockProvider({
      forEachEntity: () => {},
    });
    expect(discoverClasses(provider)).toEqual([]);
  });

  it('deduplicates classes across entities', () => {
    const provider = createMockProvider({
      forEachEntity: (cb) => {
        cb(1, 'm'); cb(3, 'm'); // Both IfcWall
      },
    });
    const classes = discoverClasses(provider);
    expect(classes).toEqual(['IfcWall']);
  });
});

describe('discoverDataSources', () => {
  it('discovers property sets when requested', () => {
    const provider = createMockProvider();
    const result = discoverDataSources(provider, { properties: true });
    expect(result.propertySets?.get('Pset_WallCommon')).toEqual(['FireRating', 'IsExternal']);
    expect(result.propertySets?.get('Pset_SlabCommon')).toEqual(['IsExternal']);
    expect(result.quantitySets).toBeUndefined();
    expect(result.materials).toBeUndefined();
  });

  it('discovers quantity sets when requested', () => {
    const provider = createMockProvider({
      getQuantitySets: (id) => {
        if (id === 1) return [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length' }, { name: 'Height' }] }];
        return [];
      },
    });
    const result = discoverDataSources(provider, { quantities: true });
    expect(result.quantitySets?.get('Qto_WallBaseQuantities')).toEqual(['Height', 'Length']);
    expect(result.propertySets).toBeUndefined();
  });

  it('discovers classifications when requested', () => {
    const provider = createMockProvider({
      getClassifications: (id) => {
        if (id === 1) return [{ system: 'Uniclass', identification: 'Pr_60' }];
        return [];
      },
    });
    const result = discoverDataSources(provider, { classifications: true });
    expect(result.classificationSystems).toEqual(['Uniclass']);
  });

  it('discovers materials when requested', () => {
    const provider = createMockProvider({
      getMaterialName: (id) => {
        if (id === 1) return 'Concrete';
        if (id === 2) return 'Steel';
        return undefined;
      },
    });
    const result = discoverDataSources(provider, { materials: true });
    expect(result.materials).toEqual(['Concrete', 'Steel']);
  });

  it('returns empty result when no categories requested', () => {
    const provider = createMockProvider();
    const result = discoverDataSources(provider, {});
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('discovers multiple categories at once', () => {
    const provider = createMockProvider({
      getMaterialName: (id) => id === 1 ? 'Concrete' : undefined,
    });
    const result = discoverDataSources(provider, { properties: true, materials: true });
    expect(result.propertySets?.has('Pset_WallCommon')).toBe(true);
    expect(result.materials).toEqual(['Concrete']);
    expect(result.quantitySets).toBeUndefined();
  });
});
