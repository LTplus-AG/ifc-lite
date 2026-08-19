/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.list.execute()` bridges the SDK's flat `{ header, source }`
 * `ListColumn` shape to `@ifc-lite/lists`' structured `ColumnDefinition`
 * (`{ id, source: <enum>, psetName?, propertyName, label? }`). Before this
 * fix the two never lined up: the library switches on `source` against its
 * own enum ('attribute' | 'property' | 'quantity' | ...), and SDK columns
 * carried 'name' / 'type' / 'globalId' / 'Pset.Prop' strings that matched
 * none of those cases, so every column's value silently came back `null`
 * for every row, for every caller, always — `executeList`'s default case.
 *
 * Separately, the library's `ListDefinition.conditions` is a required
 * (non-optional) array that `resolveSourceSet` reads unconditionally via
 * `conditions.length`; the SDK documents its own `conditions` as optional,
 * so omitting it (a documented-valid call) threw `Cannot read properties
 * of undefined (reading 'length')` instead of running unfiltered.
 */

import { describe, expect, it } from 'vitest';
import { ListNamespace, type ListDefinition } from './list.js';

interface Provider {
  getEntitiesByType: (type: number) => number[];
  getAllEntityIds?: () => number[];
  getEntityName: (id: number) => string;
  getEntityGlobalId: (id: number) => string;
  getEntityTypeName: (id: number) => string;
  getEntityDescription?: (id: number) => string;
  getEntityObjectType?: (id: number) => string;
  getEntityTag?: (id: number) => string;
  getPropertySets?: (id: number) => unknown[];
  getQuantitySets?: (id: number) => unknown[];
}

function makeProvider(): Provider {
  return {
    getEntitiesByType: () => [1, 2],
    getAllEntityIds: () => [1, 2],
    getEntityName: (id) => `Wall-${id}`,
    getEntityGlobalId: (id) => `GUID-${id}`,
    getEntityTypeName: () => 'IfcWall',
    getEntityDescription: () => '',
    getEntityObjectType: () => '',
    getEntityTag: () => '',
    getPropertySets: () => [],
    getQuantitySets: () => [],
  };
}

interface ExecuteRow {
  entityId: number;
  values: unknown[];
}
interface ExecuteResult {
  rows: ExecuteRow[];
}

describe('ListNamespace.execute (#column-mapping, #conditions-default)', () => {
  it('resolves attribute columns (name/type/globalId) to real values instead of null', async () => {
    const definition: ListDefinition = {
      types: ['IfcWall'],
      columns: [
        { header: 'Name', source: 'name' },
        { header: 'GlobalId', source: 'globalId' },
      ],
    };

    const result = (await new ListNamespace().execute(makeProvider(), definition)) as ExecuteResult;

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].values).toEqual(['Wall-1', 'GUID-1']);
    expect(result.rows[1].values).toEqual(['Wall-2', 'GUID-2']);
  });

  it('does not throw when conditions is omitted (documented as optional)', async () => {
    const definition: ListDefinition = {
      types: ['IfcWall'],
      columns: [{ header: 'Name', source: 'name' }],
      // conditions intentionally omitted
    };

    const result = (await new ListNamespace().execute(makeProvider(), definition)) as ExecuteResult;
    expect(result.rows).toHaveLength(2);
  });
});
