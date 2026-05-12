/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkQueryEngine, MutablePropertyView } from '../src/index.js';

describe('MutablePropertyView', () => {
  it('creates a new property set automatically and returns mutated values', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);

    view.setProperty(42, 'Pset_Custom', 'Code', 'A-01', PropertyValueType.Label);

    expect(view.getPropertyValue(42, 'Pset_Custom', 'Code')).toBe('A-01');
    expect(view.getForEntity(42)).toMatchObject([
      {
        name: 'Pset_Custom',
        properties: [
          {
            name: 'Code',
            type: PropertyValueType.Label,
            value: 'A-01',
          },
        ],
      },
    ]);
  });

  it('deletes an existing property from the overlaid view', () => {
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor((entityId) => entityId === 7 ? [{
      name: 'Pset_Base',
      globalId: 'base-guid',
      properties: [
        { name: 'Status', type: PropertyValueType.Label, value: 'Existing' },
      ],
    }] : []);

    view.deleteProperty(7, 'Pset_Base', 'Status');

    expect(view.getPropertyValue(7, 'Pset_Base', 'Status')).toBeNull();
    expect(view.getForEntity(7)).toEqual([]);
  });

  describe('entity aliases (duplicate flow)', () => {
    it('routes base property reads to the source entity when aliased', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setOnDemandExtractor((entityId) => entityId === 100 ? [{
        name: 'Pset_WallCommon',
        globalId: 'wall-guid',
        properties: [
          { name: 'FireRating', type: PropertyValueType.Label, value: 'REI 60' },
        ],
      }] : []);

      // Without an alias, the duplicate (id 200) has no base props.
      expect(view.getForEntity(200)).toEqual([]);

      // After aliasing, the duplicate inherits the source's psets.
      view.setEntityAlias(200, 100);
      expect(view.getForEntity(200)).toMatchObject([
        {
          name: 'Pset_WallCommon',
          properties: [
            { name: 'FireRating', value: 'REI 60' },
          ],
        },
      ]);
    });

    it('keeps overrides scoped to the duplicate id, not the source', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setOnDemandExtractor((entityId) => entityId === 100 ? [{
        name: 'Pset_WallCommon',
        globalId: 'wall-guid',
        properties: [
          { name: 'FireRating', type: PropertyValueType.Label, value: 'REI 60' },
        ],
      }] : []);

      view.setEntityAlias(200, 100);

      // Edit on the duplicate.
      view.setProperty(200, 'Pset_WallCommon', 'FireRating', 'REI 120', PropertyValueType.Label);

      // Source's view of FireRating is unchanged.
      expect(view.getPropertyValue(100, 'Pset_WallCommon', 'FireRating')).toBe('REI 60');
      // Duplicate's view shows the override.
      expect(view.getPropertyValue(200, 'Pset_WallCommon', 'FireRating')).toBe('REI 120');
    });

    it('clears the alias when sourceId is null', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setEntityAlias(200, 100);
      expect(view.getEntityAlias(200)).toBe(100);
      view.setEntityAlias(200, null);
      expect(view.getEntityAlias(200)).toBeNull();
    });

    it('refuses self-aliases (no-op)', () => {
      const view = new MutablePropertyView(null, 'model-1');
      view.setEntityAlias(42, 42);
      expect(view.getEntityAlias(42)).toBeNull();
    });
  });
});

describe('BulkQueryEngine', () => {
  it('selects by GlobalId and applies property mutations', () => {
    const strings = ['guid-wall-a', 'guid-wall-b', 'Wall Alpha', 'Wall Beta'];
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);

    const entities = {
      count: 2,
      expressId: new Int32Array([1, 2]),
      typeEnum: new Uint32Array([10, 10]),
      globalId: new Int32Array([0, 1]),
      name: new Int32Array([2, 3]),
    } as any;

    const engine = new BulkQueryEngine(
      entities,
      view,
      null,
      null,
      { get: (idx: number) => strings[idx] },
    );

    const preview = engine.preview({
      select: { globalIds: ['guid-wall-b'] },
      action: {
        type: 'SET_PROPERTY',
        psetName: 'Pset_Bulk',
        propName: 'Zone',
        value: 'B',
        valueType: PropertyValueType.Label,
      },
    });

    expect(preview.matchedEntityIds).toEqual([2]);

    const result = engine.execute({
      select: { entityTypes: [10], namePattern: 'Wall' },
      action: {
        type: 'SET_PROPERTY',
        psetName: 'Pset_Bulk',
        propName: 'Zone',
        value: 'North',
        valueType: PropertyValueType.Label,
      },
    });

    expect(result.success).toBe(true);
    expect(result.affectedEntityCount).toBe(2);
    expect(view.getPropertyValue(1, 'Pset_Bulk', 'Zone')).toBe('North');
    expect(view.getPropertyValue(2, 'Pset_Bulk', 'Zone')).toBe('North');
  });
});
