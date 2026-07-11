/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { changeSetToOps, deriveEntityIdentity } from './change-set-to-ops.js';
import type { EntityIdentityResolver } from './change-set-to-ops.js';
import type { ChangeSet, Mutation, MutationType, PropertyValue } from './types.js';

let mutationCounter = 0;
function mutation(
  type: MutationType,
  entityId: number,
  fields: Partial<Mutation> = {}
): Mutation {
  mutationCounter += 1;
  return {
    id: `m-${mutationCounter}`,
    type,
    timestamp: mutationCounter,
    modelId: 'model-1',
    entityId,
    ...fields,
  };
}

function changeSet(mutations: Mutation[]): ChangeSet {
  return { id: 'cs-1', name: 'test', createdAt: 0, mutations, applied: false };
}

const resolver: EntityIdentityResolver = {
  globalIdOf: (expressId) => (expressId === 42 ? '3fAx$GlobalId42' : undefined),
  ifcTypeOf: (expressId) => (expressId === 7 ? 'IfcWall' : undefined),
  nameOf: (expressId) => (expressId === 7 ? 'W-07' : undefined),
  spatialParentPathOf: (expressId) => (expressId === 7 ? '/project/storey-EG' : undefined),
};

describe('changeSetToOps', () => {
  it('maps expressIds to GlobalIds and folds property mutations per pset', () => {
    const result = changeSetToOps(
      changeSet([
        mutation('CREATE_PROPERTY', 42, { psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI60' }),
        mutation('UPDATE_PROPERTY', 42, { psetName: 'Pset_FireSafety', propName: 'FireRating', newValue: 'REI90' }),
        mutation('UPDATE_PROPERTY', 42, { psetName: 'Pset_WallCommon', propName: 'IsExternal', newValue: true }),
      ]),
      resolver
    );

    expect(result.unresolved).toEqual([]);
    expect(result.identityMap).toEqual([]);
    expect(result.ops).toContainEqual({
      op: 'set-component',
      entity: '3fAx$GlobalId42',
      componentKey: 'pset:Pset_FireSafety',
      values: { FireRating: 'REI90' },
    });
    expect(result.ops).toContainEqual({
      op: 'set-component',
      entity: '3fAx$GlobalId42',
      componentKey: 'pset:Pset_WallCommon',
      values: { IsExternal: true },
    });
  });

  it('expresses deletions: property → null member, pset → tombstone-component, entity → tombstone-entity', () => {
    const result = changeSetToOps(
      changeSet([
        mutation('DELETE_PROPERTY', 42, { psetName: 'Pset_WallCommon', propName: 'IsExternal' }),
        mutation('DELETE_PROPERTY_SET', 42, { psetName: 'Pset_Obsolete' }),
        mutation('DELETE_ENTITY', 42),
      ]),
      resolver
    );
    expect(result.ops).toContainEqual({
      op: 'set-component',
      entity: '3fAx$GlobalId42',
      componentKey: 'pset:Pset_WallCommon',
      values: { IsExternal: null },
    });
    expect(result.ops).toContainEqual({
      op: 'tombstone-component',
      entity: '3fAx$GlobalId42',
      componentKey: 'pset:Pset_Obsolete',
    });
    expect(result.ops).toContainEqual({ op: 'tombstone-entity', entity: '3fAx$GlobalId42' });
  });

  it('derives identity for entities without GlobalId and records it for the identity_map', () => {
    const result = changeSetToOps(
      changeSet([
        mutation('UPDATE_ATTRIBUTE', 7, { attributeName: 'Name', newValue: 'W-07-renamed' }),
      ]),
      resolver
    );
    const expected = deriveEntityIdentity({
      ifcType: 'IfcWall',
      name: 'W-07',
      spatialParentPath: '/project/storey-EG',
    });
    expect(result.identityMap).toEqual([{ base: expected, here: expected, reason: 'derived' }]);
    expect(result.ops).toEqual([
      {
        op: 'set-component',
        entity: expected,
        componentKey: 'attr:core',
        values: { Name: 'W-07-renamed' },
      },
    ]);
  });

  it('honestly reports entities with no identity instead of guessing', () => {
    const result = changeSetToOps(
      changeSet([mutation('UPDATE_ATTRIBUTE', 999, { attributeName: 'Name', newValue: 'X' })]),
      resolver
    );
    expect(result.unresolved).toEqual([999]);
    expect(result.ops).toEqual([]);
  });

  it('maps quantities to qset components and entity creation to add-entity', () => {
    const result = changeSetToOps(
      changeSet([
        mutation('CREATE_QUANTITY', 42, { psetName: 'Qto_WallBaseQuantities', propName: 'NetVolume', newValue: 1.5 }),
        mutation('CREATE_ENTITY', 7),
      ]),
      resolver
    );
    expect(result.ops).toContainEqual({
      op: 'set-component',
      entity: '3fAx$GlobalId42',
      componentKey: 'qset:Qto_WallBaseQuantities',
      values: { NetVolume: 1.5 },
    });
    const add = result.ops.find((op) => op.op === 'add-entity');
    expect(add).toMatchObject({ ifcType: 'IfcWall' });
  });
});
