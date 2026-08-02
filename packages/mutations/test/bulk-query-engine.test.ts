/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkQueryEngine, MutablePropertyView } from '../src/index.js';

/**
 * BulkQueryEngine.select() with propertyFilters exercises the private
 * matchesFilter/filterByProperty operator branches. This is the core
 * selection predicate for bulk edits: a broken operator silently selects
 * the wrong entity set and mass-mutates entities the user never intended.
 */
function makeEntities(count: number) {
  const expressId = new Int32Array(count);
  const typeEnum = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    expressId[i] = i + 1;
    typeEnum[i] = 10;
  }
  return {
    count,
    expressId,
    typeEnum,
    globalId: new Int32Array(count),
    name: new Int32Array(count),
  } as any;
}

/** Build an engine whose entities each carry `value` under Pset_Test/Prop. */
function makeEngineWithProperty(values: Array<string | number | boolean | null>) {
  const entities = makeEntities(values.length);
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor(() => []);

  values.forEach((value, i) => {
    const entityId = i + 1;
    if (value === null) return; // leave unset -> property absent
    const valueType =
      typeof value === 'string'
        ? PropertyValueType.Label
        : typeof value === 'number'
          ? PropertyValueType.Real
          : PropertyValueType.Boolean;
    view.setProperty(entityId, 'Pset_Test', 'Prop', value, valueType);
  });

  const engine = new BulkQueryEngine(entities, view, null, null, null);
  return engine;
}

describe('BulkQueryEngine property filter operators', () => {
  describe('string operators', () => {
    const engine = makeEngineWithProperty(['Alpha', 'Beta', 'Gamma', null]);

    it('= matches exact string', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 'Beta' }],
      });
      expect(ids).toEqual([2]);
    });

    it('!= excludes the exact match but keeps unset entities excluded too (value required)', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '!=', value: 'Beta' }],
      });
      // Entity 4 has no property at all -> null value never matches non-null ops.
      expect(ids).toEqual([1, 3]);
    });

    it('CONTAINS is case-insensitive substring match', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'CONTAINS', value: 'amm' }],
      });
      expect(ids).toEqual([3]);
    });

    it('STARTS_WITH is case-insensitive prefix match', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'STARTS_WITH', value: 'al' }],
      });
      expect(ids).toEqual([1]);
    });

    it('ENDS_WITH is case-insensitive suffix match', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'ENDS_WITH', value: 'MA' }],
      });
      expect(ids).toEqual([3]);
    });

    it('IS_NULL selects only entities missing the property', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'IS_NULL' }],
      });
      expect(ids).toEqual([4]);
    });

    it('IS_NOT_NULL selects only entities that have the property', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'IS_NOT_NULL' }],
      });
      expect(ids).toEqual([1, 2, 3]);
    });
  });

  describe('numeric operators', () => {
    const engine = makeEngineWithProperty([10, 20, 30]);

    it('= matches exact number', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 20 }] })
      ).toEqual([2]);
    });

    it('!= excludes the exact number', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '!=', value: 20 }] })
      ).toEqual([1, 3]);
    });

    it('> selects strictly greater values', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>', value: 20 }] })
      ).toEqual([3]);
    });

    it('< selects strictly lesser values', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '<', value: 20 }] })
      ).toEqual([1]);
    });

    it('>= includes the boundary value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>=', value: 20 }] })
      ).toEqual([2, 3]);
    });

    it('<= includes the boundary value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '<=', value: 20 }] })
      ).toEqual([1, 2]);
    });
  });

  describe('boolean operators', () => {
    const engine = makeEngineWithProperty([true, false, true]);

    it('= matches the boolean value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: true }] })
      ).toEqual([1, 3]);
    });

    it('!= matches the opposite boolean value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '!=', value: true }] })
      ).toEqual([2]);
    });

    it('= accepts a string "true"/"false" filter value (UI form input)', () => {
      expect(
        engine.select({
          propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 'false' as any }],
        })
      ).toEqual([2]);
    });
  });
});
