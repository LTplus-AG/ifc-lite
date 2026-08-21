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

/**
 * PR #2841 review (louistrue): `conditions` gets the `?? []` default this PR
 * added, but — unlike `columns` — is never translated. The SDK's
 * `ListCondition` (`{ psetName, propName, operator: '=' | '!=' | ... }`) has
 * no `source` discriminator at all, so it fails `getConditionValue`'s switch
 * (`engine.ts:382`) and every entity fails `matchesCondition` (`engine.ts:308`,
 * a null actual value always returns `false`) — a documented-valid,
 * SDK-shaped condition silently returns an EMPTY table, not an error and not
 * a table of nulls. Reviewer-verified this is pre-existing on `main` too, not
 * introduced by this PR, but explicitly asked for it to be folded in here
 * rather than shipping a changeset that claims "always returns the actual
 * values" while a filtered call still gets nothing.
 */
describe('ListNamespace.execute (#conditions-translation, PR #2841 review)', () => {
  function makeProviderWithPsets(): Provider {
    return {
      ...makeProvider(),
      getPropertySets: (id) =>
        id === 1
          ? [
              {
                name: 'Pset_WallCommon',
                globalId: 'pset-1',
                properties: [{ name: 'IsExternal', type: 0, value: true }],
              },
            ]
          : [
              {
                name: 'Pset_WallCommon',
                globalId: 'pset-2',
                properties: [{ name: 'IsExternal', type: 0, value: false }],
              },
            ],
    };
  }

  it('translates a "Pset.Prop" condition (psetName/propName/operator) so a filtered list keeps only the matching row', async () => {
    const definition: ListDefinition = {
      types: ['IfcWall'],
      columns: [{ header: 'Name', source: 'name' }],
      conditions: [{ psetName: 'Pset_WallCommon', propName: 'IsExternal', operator: '=', value: true }],
    };

    const result = (await new ListNamespace().execute(
      makeProviderWithPsets(),
      definition,
    )) as ExecuteResult;

    // Entity 1 has IsExternal=true, entity 2 has IsExternal=false. Without
    // translation, every SDK-shaped condition matches nothing and this comes
    // back empty for BOTH — a wrong row count alone would not distinguish
    // "translation missing" from "translation inverted", so this also pins
    // WHICH row survives.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].values).toEqual(['Wall-1']);
  });

  it('routes a "Qto_*.Prop" condition to the quantity source, not property', async () => {
    const provider: Provider = {
      ...makeProvider(),
      getQuantitySets: (id) =>
        id === 1
          ? [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', type: 0, value: 12.5 }] }]
          : [],
      // A property set of the SAME name under 'property' would also "match"
      // if the Qto_ prefix routing were dropped — this pset has no
      // NetVolume, so the test only stays green when the condition is
      // actually routed to `quantity`.
      getPropertySets: () => [],
    };
    const definition: ListDefinition = {
      types: ['IfcWall'],
      columns: [{ header: 'Name', source: 'name' }],
      conditions: [{ psetName: 'Qto_WallBaseQuantities', propName: 'NetVolume', operator: '=', value: 12.5 }],
    };

    const result = (await new ListNamespace().execute(provider, definition)) as ExecuteResult;

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].values).toEqual(['Wall-1']);
  });
});
