/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { IfcTypeEnum, QuantityType } from '@ifc-lite/data';
import { executeList } from './engine.js';
import type { ListDataProvider, ListDefinition } from './types.js';

describe('a non-finite quantity renders as an empty cell (#11469)', () => {
  it('NaN becomes null and the group sum ignores it', () => {
    const provider: ListDataProvider = {
      getEntitiesByType: (t) => (t === IfcTypeEnum.IfcWall ? [1, 2] : []),
      getEntityName: (id) => `W${id}`,
      getEntityGlobalId: (id) => `g${id}`,
      getEntityDescription: () => '',
      getEntityObjectType: () => '',
      getEntityTag: () => '',
      getEntityTypeName: () => 'IfcWall',
      getPropertySets: () => [],
      getQuantitySets: (id) => [{ name: 'Qto', quantities: [{ name: 'A', value: id === 1 ? Number.NaN : 4, type: QuantityType.Area }] }],
    };
    const definition: ListDefinition = {
      id: 'l', name: 'n', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], groups: [],
      columns: [{ id: 'a', source: 'quantity', psetName: 'Qto', propertyName: 'A' }],
      grouping: { groupByColumnId: 'a', sumColumnIds: ['a'] },
    } as unknown as ListDefinition;
    const result = executeList(definition, provider, 'm');
    expect(result.rows.map((r) => r.values[0])).toEqual([null, 4]);
    expect(result.summary?.sums.a).toBe(4);
  });
});
