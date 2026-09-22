/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `createDataAccessor`'s optional `entityVisibility` parameter (#5184):
 * `getAllEntityIds` excludes tombstoned entities and includes overlay-
 * created ones when a view is supplied, and is byte-identical to the
 * pre-#5184 behaviour when it is not.
 */

import { describe, it, expect } from 'vitest';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';

import { createDataAccessor, type EntityVisibilityView } from './data-accessor.js';

/**
 * Three-entity store — ids 1, 2, 3 — mirroring the issue's own repro
 * (`store before delete: entityIndex.byId keys [ 1, 2, 3 ]`). No
 * relationships, no on-demand attribute reads: `getAllEntityIds` never
 * touches either.
 */
function makeStore(): IfcDataStore {
  const byId = new Map<number, EntityRef>([
    [1, { expressId: 1, type: 'IfcWall', byteOffset: 0, byteLength: 0, lineNumber: 1 }],
    [2, { expressId: 2, type: 'IfcWall', byteOffset: 0, byteLength: 0, lineNumber: 2 }],
    [3, { expressId: 3, type: 'IfcWall', byteOffset: 0, byteLength: 0, lineNumber: 3 }],
  ]);
  return {
    schemaVersion: 'IFC4',
    source: new Uint8Array(),
    entities: {
      getTypeName: (id: number) => byId.get(id)?.type,
      getObjectType: () => undefined,
      getName: () => undefined,
      getGlobalId: () => undefined,
      getDescription: () => undefined,
    },
    entityIndex: { byId, byType: new Map([['IFCWALL', [1, 2, 3]]]) },
    relationships: { getRelated: () => [] },
  } as unknown as IfcDataStore;
}

function view(tombstones: number[], newIds: number[] = []): EntityVisibilityView {
  const t = new Set(tombstones);
  return {
    getTombstones: () => t,
    getNewEntities: () => newIds.map((expressId) => ({ expressId })),
  };
}

describe('createDataAccessor — getAllEntityIds with entityVisibility (#5184)', () => {
  it('excludes a tombstoned entity', () => {
    const accessor = createDataAccessor(makeStore(), undefined, view([2]));
    expect(accessor.getAllEntityIds().slice().sort()).toEqual([1, 3]);
  });

  it('includes a surviving overlay-created entity', () => {
    const accessor = createDataAccessor(makeStore(), undefined, view([], [40]));
    expect(accessor.getAllEntityIds().slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 40]);
  });

  it('excludes a tombstone AND includes a created entity in the same call', () => {
    const accessor = createDataAccessor(makeStore(), undefined, view([2], [40]));
    expect(accessor.getAllEntityIds().slice().sort((a, b) => a - b)).toEqual([1, 3, 40]);
  });

  it('an accessor built with no third argument reproduces the exact pre-#5184 behaviour (no-regression pin)', () => {
    const accessor = createDataAccessor(makeStore());
    expect(accessor.getAllEntityIds().slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

/**
 * `getEntitiesByType` (#5184 follow-up): the dominant real-world path —
 * `entity-facet.ts`'s `simpleValue`/`enumeration` broadphase filter calls
 * this, not `getAllEntityIds`, for any IDS spec that names an entity type
 * directly. Isolated unit coverage at the accessor level, independent of
 * the validator end-to-end tests in `validator.test.ts`.
 */
describe('createDataAccessor — getEntitiesByType with entityVisibility (#5184 follow-up)', () => {
  it('excludes a tombstoned entity of the requested type', () => {
    const accessor = createDataAccessor(makeStore(), undefined, view([2]));
    expect(accessor.getEntitiesByType('IfcWall').slice().sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('an entityVisibility view with NO tombstones still returns every live entity of the type (no-regression pin against over-exclusion)', () => {
    const accessor = createDataAccessor(makeStore(), undefined, view([]));
    expect(accessor.getEntitiesByType('IfcWall').slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('an accessor built with no third argument reproduces the exact pre-#5184 behaviour (no-regression pin)', () => {
    const accessor = createDataAccessor(makeStore());
    expect(accessor.getEntitiesByType('IfcWall').slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('a type name with no entities returns an empty array, entityVisibility supplied or not', () => {
    const withView = createDataAccessor(makeStore(), undefined, view([2]));
    const withoutView = createDataAccessor(makeStore());
    expect(withView.getEntitiesByType('IfcDoor')).toEqual([]);
    expect(withoutView.getEntitiesByType('IfcDoor')).toEqual([]);
  });
});
