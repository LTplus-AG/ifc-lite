/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `customGrouping` column (#8425): each row shows the element's group in a
 * user-authored grouping. The engine asks the provider with the grouping's
 * name (`propertyName`) and id hint (`psetName`); the viewer's provider
 * answers with `@ifc-lite/rules`' `customGroupOfElement`, the same first match
 * the `customGrouping` rule applies (covered there and end to end in the
 * viewer's `run-list.custom-grouping.test.ts`).
 */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import type { CustomGroupingRef } from '@ifc-lite/rules';
import { executeList } from './engine.js';
import { isSavedListShape } from './legacy-condition-migration.js';
import type { ListDataProvider, ListDefinition } from './types.js';

function provider(asked: CustomGroupingRef[], getCustomGroup?: ListDataProvider['getCustomGroup']): ListDataProvider {
  return {
    getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1, 2] : []),
    getEntityName: (id) => `Wall-${id}`,
    getEntityGlobalId: (id) => `guid-${id}`,
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getEntityTypeName: () => 'IfcWall',
    getPropertySets: () => [],
    getQuantitySets: () => [],
    ...(getCustomGroup ? { getCustomGroup: (id, ref) => { asked.push(ref); return getCustomGroup(id, ref); } } : {}),
  };
}

const definition: ListDefinition = {
  id: 't', name: 'T', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], groups: [],
  columns: [{ id: 'g', source: 'customGrouping', psetName: 'lens-disc', propertyName: 'Disciplines' }],
};

describe('customGrouping column (#8425)', () => {
  it('asks the provider by name with the id hint and shows the group, null when ungrouped', () => {
    const asked: CustomGroupingRef[] = [];
    const result = executeList(definition, provider(asked, (id) => (id === 1 ? 'Structure' : null)));
    expect(result.rows.map((r) => r.values[0])).toEqual(['Structure', null]);
    expect(asked[0]).toEqual({ id: 'lens-disc', name: 'Disciplines' });
  });

  it('a provider without groupings resolves the column to null', () => {
    expect(executeList(definition, provider([])).rows.map((r) => r.values[0])).toEqual([null, null]);
  });

  it('a saved list with the column is readable', () => {
    expect(isSavedListShape(definition)).toBe(true);
    expect(isSavedListShape({ ...definition, columns: [{ ...definition.columns[0], source: 'nope' }] })).toBe(false);
  });
});
