/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `inherit: 'aggregation'` on a list condition (#5433): a part with no value
 * of its own takes its assembly's; its own value wins; without the option
 * nothing is inherited; a cyclic aggregation ends.
 *
 *   10 Assembly (Pset_Asm.FireRating = REI60) aggregates 11 (none) and 12 (REI30)
 *   13 <-> 14 aggregate each other (broken file), neither has a value
 */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import type { PropertySet } from '@ifc-lite/data';
import { executeList } from './engine.js';
import type { ListDataProvider, ListDefinition, PropertyCondition } from './types.js';

const rating = (value: string): PropertySet[] => [{ name: 'Pset_Asm', globalId: 'p', properties: [{ name: 'FireRating', type: 0, value }] }];

function provider(): ListDataProvider {
  const psets = new Map<number, PropertySet[]>([[10, rating('REI60')], [12, rating('REI30')]]);
  const parents = new Map<number, number[]>([[11, [10]], [12, [10]], [13, [14]], [14, [13]]]);
  return {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcPlate ? [11, 12, 13, 14] : []),
    getEntityName: (id) => `E${id}`,
    getEntityGlobalId: (id) => `g${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: () => 'IfcPlate',
    getPropertySets: (id) => psets.get(id) ?? [],
    getQuantitySets: () => [],
    getAggregateParents: (id) => parents.get(id) ?? [],
  };
}

function rows(condition: PropertyCondition): string[] {
  const definition: ListDefinition = {
    id: 'l', name: 'l', createdAt: 0, updatedAt: 0,
    entityTypes: [IfcTypeEnum.IfcPlate],
    conditions: [condition],
    columns: [{ id: 'n', source: 'attribute', propertyName: 'Name' }],
  };
  return executeList(definition, provider()).rows.map((r) => String(r.values[0])).sort();
}

const fire: PropertyCondition = { source: 'property', psetName: 'Pset_Asm', propertyName: 'FireRating', operator: 'equals', value: 'REI60' };

describe('list condition inherit (#5433)', () => {
  it('without the option nothing is inherited', () => {
    expect(rows(fire)).toEqual([]);
  });

  it('aggregation: the part takes its assembly\'s value; its own value wins', () => {
    expect(rows({ ...fire, inherit: 'aggregation' })).toEqual(['E11']);
    expect(rows({ ...fire, value: 'REI30', inherit: 'aggregation' })).toEqual(['E12']);
  });

  it('a cyclic aggregation ends', () => {
    expect(rows({ ...fire, operator: 'exists', inherit: 'aggregation' })).toEqual(['E11', 'E12']);
  });
});
