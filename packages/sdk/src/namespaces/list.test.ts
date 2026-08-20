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

import { beforeAll, describe, expect, it } from 'vitest';
import { ListNamespace, type ListDefinition } from './list.js';

/**
 * `ListNamespace.execute()` dynamically imports `@ifc-lite/lists` and
 * `@ifc-lite/data` on first use (`loadLists` in `list.ts`) so SDK consumers
 * who never touch `bim.list` don't pay for them. Right tradeoff for real
 * callers -- but it means whichever test here runs first pays the one-time
 * cold-import cost inside its own timer: measured at 2002ms cold and 481ms on
 * a warm repo, against 2-3ms once the modules are resolved.
 *
 * Under CI's parallel load that alone crosses the 5000ms default. This file
 * failed on FIVE unrelated PRs at once -- #2822, #2905, #2907, #2923, #2930 --
 * every one between 5005ms and 5056ms, while passing locally on the same
 * commit. Warming here moves the cost outside every `it()`'s budget, so each
 * test times only its own logic and keeps the tight default: a genuine hang
 * still fails in 5s rather than 30s.
 *
 * Same root cause and directory as `ids.test.ts` (3a00b5e64, which reported
 * 5021-5038ms), and the same shape as `packages/export/src/parquet-geometry.test.ts`
 * (#2248). `bcf.ts`, `drawing.ts` and `sandbox.ts` share the lazy-import idiom
 * and have not fired yet.
 *
 * Warmed rather than mocked: these tests exist to prove the real bridge to the
 * real library produces real values, and a mocked `executeList` would pass
 * with the very column-mapping bug they were written to catch (#2841).
 *
 * Known limitation, and the alternative was tried rather than assumed: this
 * names `execute()`'s imports instead of driving `execute()` itself, so a
 * third dependency added there would silently stop being covered. Driving the
 * real method would stay correct by construction, but every module-scope
 * `await` form breaks function hoisting in this file under vite's transform
 * (`makeProviderWithPsets` hits `ReferenceError: makeProvider is not
 * defined`), which is why the warm-up sits in `beforeAll`. If `execute()`
 * gains an import, add it here.
 */
beforeAll(async () => {
  await import('@ifc-lite/lists');
  await import('@ifc-lite/data');
}, 30_000);

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
