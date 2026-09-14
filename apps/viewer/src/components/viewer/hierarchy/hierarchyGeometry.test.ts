/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `buildGeometricIdSet` used to add only `mesh.expressId`, while
 * `lib/object-count.ts`'s `collectMeshedIds` (the StatusBar's rule) also adds
 * the keys of `instancedGeometryHashes`/`Aabbs`/`Volumes` — the ids of
 * entities rendered only through GPU instancing. A fully-instanced element
 * therefore counted as having geometry in the StatusBar and as lacking it in
 * the hierarchy trees (By Class / By Type), disappearing from one and not
 * the other. This asserts the two now agree by construction: they share one
 * implementation.
 */

// The hierarchy module imports the persisted viewer store, which reads
// localStorage at module initialization.
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FederatedModel } from '@/store/types';
import { buildGeometricIdSet } from './hierarchyGeometry.js';

function model(overrides: Partial<FederatedModel>): FederatedModel {
  return { id: 'm1', idOffset: 0, ...overrides } as unknown as FederatedModel;
}

describe('buildGeometricIdSet', () => {
  it('includes an instanced-only entity — present in instancedGeometryHashes, absent from meshes', () => {
    const models = new Map([
      [
        'm1',
        model({
          geometryResult: {
            meshes: [{ expressId: 1 }],
            instancedGeometryHashes: new Map([[7, 0n]]),
          } as never,
        }),
      ],
    ]);
    const ids = buildGeometricIdSet(models, null);
    assert.equal(ids.has(1), true);
    assert.equal(ids.has(7), true, 'instanced-only id #7 must be counted, same as the StatusBar');
  });

  it('unions instanced-only ids across every federated model', () => {
    const models = new Map([
      ['m1', model({ id: 'm1', geometryResult: { meshes: [{ expressId: 1 }] } as never })],
      [
        'm2',
        model({
          id: 'm2',
          geometryResult: {
            meshes: [],
            instancedGeometryAabbs: new Map([[1002, {}]]),
          } as never,
        }),
      ],
    ]);
    const ids = buildGeometricIdSet(models, null);
    assert.deepEqual([...ids].sort((a, b) => a - b), [1, 1002]);
  });

  it('falls back to legacy single-model geometry, instanced ids included, when no federated models exist', () => {
    const ids = buildGeometricIdSet(new Map(), {
      meshes: [{ expressId: 3 }],
      instancedGeometryVolumes: new Map([[9, 1]]),
    } as never);
    assert.deepEqual([...ids].sort((a, b) => a - b), [3, 9]);
  });

  it('returns an empty set with no geometry anywhere', () => {
    assert.equal(buildGeometricIdSet(new Map(), null).size, 0);
  });
});
