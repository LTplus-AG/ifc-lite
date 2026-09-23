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
import type { ListDataProvider, ListDefinition } from '@ifc-lite/lists';
import { IfcTypeEnum, QuantityType, type QuantitySet } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ModelTag } from '@ifc-lite/rules';
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

const noTags = { modelTags: new Map<string, ModelTag>(), modelTagAssignments: new Map<string, ReadonlySet<string>>() };

describe('runListFederated (#5142)', () => {
  it('merges the rows of every model in scope and sums execution time', () => {
    const pairs = [pair('a'), pair('b')];
    const result = runListFederated(definition(), pairs, { models: new Map([['a', {}], ['b', {}]]), ...noTags });
    assert.deepEqual(result.rows.map((r) => [r.modelId, r.values[0]]), [['a', 'Wall of a'], ['b', 'Wall of b']]);
    assert.equal(result.totalCount, 2);
    assert.ok(Number.isFinite(result.executionTime) && result.executionTime >= 0);
  });

  it('carries the unit annotation executeList resolved onto the result columns (#1573)', () => {
    const qto: QuantitySet[] = [{ name: 'Qto', quantities: [{ name: 'NetVolume', value: 2.5, type: QuantityType.Volume }] }];
    // Only the second model carries the quantity — first-defined-wins across parts.
    const def = definition();
    const result = runListFederated(def, [pair('a'), pair('b', qto)], { models: new Map([['a', {}], ['b', {}]]), ...noTags });
    assert.equal(result.columns[1].quantityType, QuantityType.Volume);
    assert.equal(def.columns[1].quantityType, undefined, 'the authoring definition is never annotated');
  });

  it('derives groups and the summary over the merged rows, across models', () => {
    const def = definition({ grouping: { columnId: 'storey', columnIds: ['storey'], sumColumnIds: [] } });
    const result = runListFederated(def, [pair('a'), pair('b')], { models: new Map([['a', {}], ['b', {}]]), ...noTags });
    assert.deepEqual(result.groups?.map((g) => [g.label, g.count]), [['Level 1', 1], ['Level 2', 1]]);
    assert.equal(result.summary?.count, 2);
  });

  it('throws the scope reason instead of returning an empty result when no model is in scope', () => {
    const tags = new Map<string, ModelTag>([['t-mep', { id: 't-mep', name: 'MEP' }]]);
    const def = definition({ modelTagScope: { op: 'hasAny', tagIds: ['t-mep'] } });
    assert.throws(
      () => runListFederated(def, [pair('a')], { models: new Map([['a', {}]]), modelTags: tags, modelTagAssignments: new Map() }),
      /No loaded model matches this list's model tag scope/,
    );
  });
});
