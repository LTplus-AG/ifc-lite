/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `runListFederated` (#5142) is the federation run `ListPanel` used to do
 * inline; a document table block now runs a list through the same function.
 * These pin the three things a caller relies on: rows of every model in
 * scope come back merged, the execution-time unit annotation survives the
 * merge (the #1573 P0 that `mergeResultColumns` exists for), and a scope
 * that selects nothing throws instead of returning an empty result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeList, migrateLegacyListConditions, type ConditionOperator, type ListDataProvider, type ListDefinition, type PropertyCondition } from '@ifc-lite/lists';
import { IfcTypeEnum, QuantityType, type QuantitySet } from '@ifc-lite/data';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { Rule, type ModelTag } from '@ifc-lite/rules';
import { IFC, IDS, listCases } from '../lens/__fixtures__/legacy-operator.js';
import { createListDataProvider } from './adapter.js';
import { runListFederated, type ModelProviderPair } from './run-list.js';

/** One IfcWall per model, named after the model, with a NetVolume quantity. */
function pair(modelId: string, qsets: QuantitySet[] = []): ModelProviderPair {
  const provider: ListDataProvider = {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1] : []),
    getEntityName: () => `Wall of ${modelId}`,
    getEntityGlobalId: (id) => `${modelId}-${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: () => 'IfcWall',
    getPropertySets: () => [],
    getQuantitySets: () => qsets,
    getStoreyName: () => (modelId === 'a' ? 'Level 1' : 'Level 2'),
  };
  // The runner never reads the store; it only travels with the pair.
  return { modelId, provider, store: {} as IfcDataStore };
}

const definition = (extra: Partial<ListDefinition> = {}): ListDefinition => ({
  id: 'l1',
  name: 'Walls',
  createdAt: 0,
  updatedAt: 0,
  entityTypes: [IfcTypeEnum.IfcWall],
  conditions: [],
  columns: [
    { id: 'name', source: 'attribute', propertyName: 'Name' },
    { id: 'vol', source: 'quantity', psetName: 'Qto', propertyName: 'NetVolume' },
    { id: 'storey', source: 'spatial', propertyName: 'Storey' },
  ],
  ...extra,
});

async function parsedPairs(): Promise<ModelProviderPair[]> {
  const bytes = new TextEncoder().encode(IFC);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const edited = new MutablePropertyView(store.properties, 'm2');
  edited.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  edited.setProperty(10, 'Pset_Test', 'Text', 'Blue');
  return [
    { modelId: 'm1', store, provider: createListDataProvider(store, 'Model 1') },
    { modelId: 'm2', store, provider: createListDataProvider(store, 'Model 2', undefined, edited), mutationView: edited },
  ];
}

describe('#5894 Rules-backed Lists over parsed IFC', () => {
  const state = {
    models: new Map([['m1', {}], ['m2', {}]]),
    modelTags: new Map<string, ModelTag>(),
    modelTagAssignments: new Map<string, ReadonlySet<string>>(),
  };
  const property: PropertyCondition = {
    source: 'property', psetName: 'Pset_Test', propertyName: 'Text', operator: 'equals', value: 'Blue',
  };
  const name: PropertyCondition = { source: 'attribute', propertyName: 'Name', operator: 'contains', value: 'wall' };

  it('keeps authored zone and exact Building filters scoped to the owning model at 1 and N (#5894)', async () => {
    const zone: PropertyCondition = { source: 'zone', psetName: 'sections', propertyName: 'Zone', operator: 'equals', value: 'Section A' };
    const building: PropertyCondition = { source: 'spatial', propertyName: 'Building', operator: 'contains', value: 'East' };
    const pairs = (await parsedPairs()).map((pair) => ({
      ...pair,
      provider: {
        ...pair.provider,
        getZoneAssignment: (id: number, setId: string) => setId === 'sections'
          ? { zoneName: id === (pair.modelId === 'm1' ? 20 : 10) ? 'Section A' : 'Section B', straddles: false, touchedZoneNames: [] }
          : null,
        getBuildingName: (id: number) => id === (pair.modelId === 'm1' ? 20 : 10) ? 'East Wing' : 'West Wing',
      },
    }));
    const def = definition({
      entityTypes: [IfcTypeEnum.IfcWall], conditions: [zone, building],
      groups: [{ rules: [], combinator: 'AND' }],
      unreadableConditions: [
        { condition: zone, reason: 'unsupported-source' },
        { condition: building, reason: 'unsupported-source' },
      ],
      columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
    });
    for (const selected of [pairs.slice(0, 1), pairs]) {
      const result = await runListFederated(def, selected, state);
      const expected = selected.map(({ modelId }) => [modelId, modelId === 'm1' ? 20 : 10]);
      assert.deepEqual(result.rows.map(({ modelId, entityId }) => [modelId, entityId]), expected);
    }
  });

  it('preserves saved v1 rows and order in one and two models, including a live property edit', async () => {
    const pairs = await parsedPairs();
    const conditions = [property, name];
    const migrated = migrateLegacyListConditions(conditions);
    const def = definition({
      entityTypes: [IfcTypeEnum.IfcWall], conditions, ...migrated,
      columns: [
        { id: 'name', source: 'attribute', propertyName: 'Name' },
        { id: 'text', source: 'property', psetName: 'Pset_Test', propertyName: 'Text' },
      ],
    });
    for (const selected of [pairs.slice(0, 1), pairs]) {
      const old = selected.flatMap(({ modelId, provider }) => executeList(def, provider, modelId).rows);
      const result = await runListFederated(def, selected, state, {
        evaluatorModels: selected.map(({ modelId, store, mutationView }) => ({ id: modelId, store, mutationView })),
      });
      assert.deepEqual(result.rows, old, 'Rules groups, unreadable Name predicate, and live edit retain each model’s rows');
      assert.equal(result.rows[0]?.modelId, 'm1');
      assert.equal(result.rows[0]?.entityId, 20);
      if (selected.length === 2) {
        assert.ok(result.rows.some(({ modelId, entityId }) => modelId === 'm2' && entityId === 10),
          'the edited property also matches in the second model');
        assert.ok(result.rows.some(({ modelId, entityId }) => modelId === 'm2' && entityId === 20),
          'an untouched base property remains visible beside the live edit');
      }
    }
  });

  it('keeps all eight migrated v1 operator results through the actual federated runner', async () => {
    const [model] = await parsedPairs();
    for (const [operator, [field, value]] of Object.entries(listCases) as [ConditionOperator, [string, string]][]) {
      const conditions: PropertyCondition[] = [{
        source: 'property', psetName: 'Pset_Test', propertyName: field, operator, value,
      }];
      const def = definition({ conditions, expressIdsByModel: { m1: IDS }, ...migrateLegacyListConditions(conditions) });
      const old = executeList(def, model.provider, model.modelId).rows.map(({ entityId }) => entityId);
      const result = await runListFederated(def, [model], state);
      assert.deepEqual(result.rows.map(({ entityId }) => entityId), old, operator);
    }
  });

  it('applies model tags and snapshot IDs without cross-model Express ID mixing', async () => {
    const pairs = await parsedPairs();
    const tagged = {
      ...state,
      modelTags: new Map<string, ModelTag>([['architecture', { id: 'architecture', name: 'Architecture' }]]),
      modelTagAssignments: new Map<string, ReadonlySet<string>>([['m2', new Set(['architecture'])]]),
    };
    const def = definition({
      entityTypes: [IfcTypeEnum.IfcWall], conditions: [],
      expressIdsByModel: { m1: [10], m2: [20] },
      groups: [{ combinator: 'AND', rules: [Rule.modelTag('hasAny', ['architecture'])] }],
    });
    const result = await runListFederated(def, pairs, tagged, {
      evaluatorModels: pairs.map(({ modelId, store, mutationView }) => ({ id: modelId, store, mutationView })),
    });
    assert.deepEqual(result.rows.map(({ modelId, entityId }) => [modelId, entityId]), [['m2', 20]]);
  });

  it('uses edited Rules groups instead of stale readable v1 conditions', async () => {
    const [model] = await parsedPairs();
    const def = definition({
      conditions: [property],
      groups: [{ combinator: 'AND', rules: [Rule.property('Pset_Test', 'Text', 'eq', 'Red')] }],
    });
    const result = await runListFederated(def, [model], state);
    assert.deepEqual(result.rows.map(({ entityId }) => entityId), [10, 30]);
    for (const groups of [[], [{ combinator: 'AND' as const, rules: [] }]]) {
      const cleared = await runListFederated({ ...def, groups }, [model], state);
      assert.deepEqual(cleared.rows.map(({ entityId }) => entityId), [10, 20, 30, 40],
        'clearing Rules filters cannot reapply stale readable v1 conditions');
    }
  });

  it('keeps an unreadable v1 predicate active alongside new Rules groups', async () => {
    const [model] = await parsedPairs();
    const migrated = migrateLegacyListConditions([{
      source: 'attribute', propertyName: 'Name', operator: 'contains', value: 'Missing',
    }]);
    const def = definition({
      conditions: [], ...migrated,
      groups: [{ combinator: 'AND', rules: [Rule.property('Pset_Test', 'Text', 'eq', 'Blue')] }],
    });
    const result = await runListFederated(def, [model], state);
    assert.deepEqual(result.rows, [], 'the unreadable Name predicate still excludes the Blue wall');
  });

  it('reports a malformed saved condition for removal instead of evaluating it (#5894)', async () => {
    const [model] = await parsedPairs();
    const migrated = migrateLegacyListConditions([null]);
    const def = definition({ conditions: [], ...migrated });
    await assert.rejects(() => runListFederated(def, [model], state),
      /malformed condition.*Remove it in the list editor/);
  });
});

const noTags = { modelTags: new Map<string, ModelTag>(), modelTagAssignments: new Map<string, ReadonlySet<string>>() };

describe('runListFederated (#5142)', () => {
  it('rejects null and invalid-value saved List rows with a removable-filter message (#5894)', async () => {
    const state = { models: new Map([['a', {}]]), ...noTags };
    const malformed = [
      null,
      { condition: { source: 'property', psetName: 'Pset_Test', propertyName: 'Code', operator: 'equals', value: { raw: 1 } }, reason: 'invalid-value' },
      { condition: { source: 'property', psetName: 'Pset_Test', propertyName: 'Code', operator: 'equals', value: { raw: 1 } }, reason: 'unsupported-source' },
      { condition: { source: 'property', psetName: 'Pset_Test', propertyName: 'Code', operator: 'equals', value: 'A' }, reason: 'future-reason' },
    ];
    for (const row of malformed) {
      const def = definition({ groups: [{ rules: [], combinator: 'AND' }],
        unreadableConditions: [row] as ListDefinition['unreadableConditions'] });
      await assert.rejects(() => runListFederated(def, [pair('a')], state), /malformed condition.*Remove it in the list editor/);
    }
  });

  it('merges the rows of every model in scope and sums execution time', async () => {
    const pairs = [pair('a'), pair('b')];
    const result = await runListFederated(definition(), pairs, { models: new Map([['a', {}], ['b', {}]]), ...noTags });
    assert.deepEqual(result.rows.map((r) => [r.modelId, r.values[0]]), [['a', 'Wall of a'], ['b', 'Wall of b']]);
    assert.equal(result.totalCount, 2);
    assert.ok(Number.isFinite(result.executionTime) && result.executionTime >= 0);
  });

  it('carries the unit annotation executeList resolved onto the result columns (#1573)', async () => {
    const qto: QuantitySet[] = [{ name: 'Qto', quantities: [{ name: 'NetVolume', value: 2.5, type: QuantityType.Volume }] }];
    // Only the second model carries the quantity — first-defined-wins across parts.
    const def = definition();
    const result = await runListFederated(def, [pair('a'), pair('b', qto)], { models: new Map([['a', {}], ['b', {}]]), ...noTags });
    assert.equal(result.columns[1].quantityType, QuantityType.Volume);
    assert.equal(def.columns[1].quantityType, undefined, 'the authoring definition is never annotated');
  });

  it('derives groups and the summary over the merged rows, across models', async () => {
    const def = definition({ grouping: { columnId: 'storey', columnIds: ['storey'], sumColumnIds: [] } });
    const result = await runListFederated(def, [pair('a'), pair('b')], { models: new Map([['a', {}], ['b', {}]]), ...noTags });
    assert.deepEqual(result.groups?.map((g) => [g.label, g.count]), [['Level 1', 1], ['Level 2', 1]]);
    assert.equal(result.summary?.count, 2);
  });

  it('throws the scope reason instead of returning an empty result when no model is in scope', async () => {
    const tags = new Map<string, ModelTag>([['t-mep', { id: 't-mep', name: 'MEP' }]]);
    const def = definition({ modelTagScope: { op: 'hasAny', tagIds: ['t-mep'] } });
    await assert.rejects(
      () => runListFederated(def, [pair('a')], { models: new Map([['a', {}]]), modelTags: tags, modelTagAssignments: new Map() }),
      /No loaded model matches this list's model tag scope/,
    );
  });
});
