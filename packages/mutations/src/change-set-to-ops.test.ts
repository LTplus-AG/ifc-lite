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
  globalIdOf: (expressId) => {
    if (expressId === 42) return '3fAx$GlobalId42';
    if (expressId === 5) return '3fAx$GlobalId05';
    if (expressId === 6) return '3fAx$GlobalId06';
    if (expressId === 9) return '3fAx$GlobalId09';
    if (expressId === 10) return '3fAx$GlobalId10';
    return undefined;
  },
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

  it('expresses component-level deletions when the entity itself survives: property → null member, pset → tombstone-component', () => {
    const result = changeSetToOps(
      changeSet([
        mutation('DELETE_PROPERTY', 42, { psetName: 'Pset_WallCommon', propName: 'IsExternal' }),
        mutation('DELETE_PROPERTY_SET', 42, { psetName: 'Pset_Obsolete' }),
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
  });

  it('an entity-level delete alone emits only tombstone-entity', () => {
    const result = changeSetToOps(changeSet([mutation('DELETE_ENTITY', 10)]), resolver);
    expect(result.ops).toEqual([{ op: 'tombstone-entity', entity: '3fAx$GlobalId10' }]);
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

  it('serializes a retype as a class opinion and rides PredefinedType on the core channel', () => {
    const result = changeSetToOps(
      changeSet([
        mutation('UPDATE_ENTITY_TYPE', 42, { entityType: 'IfcColumn', predefinedType: 'COLUMN' }),
      ]),
      resolver
    );
    expect(result.skipped).toEqual([]);
    expect(result.ops).toContainEqual({
      op: 'set-component',
      entity: '3fAx$GlobalId42',
      componentKey: 'attr:class',
      values: { code: 'IfcColumn' },
    });
    expect(result.ops).toContainEqual({
      op: 'set-component',
      entity: '3fAx$GlobalId42',
      componentKey: 'attr:core',
      values: { PredefinedType: 'COLUMN' },
    });
  });

  it('reports unrepresentable mutation types instead of silently dropping them', () => {
    const foreign = mutation('SOME_FUTURE_TYPE' as MutationType, 42, {});
    const result = changeSetToOps(changeSet([foreign]), resolver);
    expect(result.ops).toEqual([]);
    expect(result.skipped).toEqual([foreign]);
  });

  it('drops component ops for an entity whose final state is tombstone-entity (#2048 finding 2)', () => {
    const result = changeSetToOps(
      changeSet([
        mutation('CREATE_PROPERTY', 5, { psetName: 'Pset_Foo', propName: 'Bar', newValue: 42 }),
        mutation('DELETE_ENTITY', 5),
      ]),
      resolver
    );
    expect(result.ops).toEqual([{ op: 'tombstone-entity', entity: '3fAx$GlobalId05' }]);
    expect(result.ops.some((op) => op.op === 'set-component')).toBe(false);
  });

  it('keeps components for an entity that is tombstoned and then recreated in the same change set', () => {
    const result = changeSetToOps(
      changeSet([
        mutation('CREATE_PROPERTY', 6, { psetName: 'Pset_Foo', propName: 'Bar', newValue: 1 }),
        mutation('DELETE_ENTITY', 6),
        mutation('CREATE_ENTITY', 6),
        mutation('CREATE_PROPERTY', 6, { psetName: 'Pset_Foo', propName: 'Baz', newValue: 2 }),
      ]),
      resolver
    );
    expect(result.ops).toContainEqual({ op: 'add-entity', entity: '3fAx$GlobalId06', ifcType: undefined });
    expect(result.ops).toContainEqual({
      op: 'set-component',
      entity: '3fAx$GlobalId06',
      componentKey: 'pset:Pset_Foo',
      values: { Bar: 1, Baz: 2 },
    });
    expect(result.ops.some((op) => op.op === 'tombstone-entity')).toBe(false);
  });

  it('keeps components for an entity with a CREATE_ENTITY op but no delete', () => {
    const result = changeSetToOps(
      changeSet([
        mutation('CREATE_ENTITY', 9),
        mutation('CREATE_PROPERTY', 9, { psetName: 'Pset_Foo', propName: 'Bar', newValue: 1 }),
      ]),
      resolver
    );
    expect(result.ops).toContainEqual({ op: 'add-entity', entity: '3fAx$GlobalId09', ifcType: undefined });
    expect(result.ops).toContainEqual({
      op: 'set-component',
      entity: '3fAx$GlobalId09',
      componentKey: 'pset:Pset_Foo',
      values: { Bar: 1 },
    });
  });

  it('keeps components for an entity with no entity-op at all', () => {
    const result = changeSetToOps(
      changeSet([mutation('CREATE_PROPERTY', 42, { psetName: 'Pset_Foo', propName: 'Bar', newValue: 1 })]),
      resolver
    );
    expect(result.ops).toContainEqual({
      op: 'set-component',
      entity: '3fAx$GlobalId42',
      componentKey: 'pset:Pset_Foo',
      values: { Bar: 1 },
    });
    expect(result.ops.some((op) => op.op === 'tombstone-entity')).toBe(false);
  });
});
