/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompactEntityIndex, createSyntheticDataStore, type EntityRef } from '@ifc-lite/parser';
import { FederationRegistry } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { getMaxExpressId } from './viewerModelIngest.js';

function storeFor(ids: number[], compact: boolean) {
  const refs: EntityRef[] = ids.map((expressId) => ({
    expressId, type: 'IFCWALL', byteOffset: 0, byteLength: 0, lineNumber: 0,
  }));
  const store = createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize: 0, entityCount: ids.length });
  store.entityIndex.byId = compact ? buildCompactEntityIndex(refs) : new Map(refs.map(ref => [ref.expressId, ref]));
  return store;
}

function mesh(expressId: number): MeshData {
  return { expressId, positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(), color: [1, 1, 1, 1] };
}

describe('maximum model ID after metadata hydration (#3985)', () => {
  it('matches a full-key oracle for unsorted maps, duplicate compact IDs and unsigned boundaries', () => {
    for (const ids of [[], [0], [8, 2, 8, 3], [0xffffffff, 0, 0xffffffff, 42]]) {
      for (const compact of [false, true]) {
        const store = storeFor(ids, compact);
        for (const meshes of [[], [mesh(12)], [mesh(0xffffffff)]]) {
          let expected = 0;
          for (const id of store.entityIndex.byId.keys()) expected = Math.max(expected, id);
          for (const m of meshes) expected = Math.max(expected, m.expressId);
          assert.equal(getMaxExpressId(store, meshes), expected);
        }
      }
    }
    assert.equal(getMaxExpressId(null, []), 0);
    assert.equal(getMaxExpressId(null, [mesh(19)]), 19);
  });

  it('preserves map-only IDs outside the compact unsigned domain', () => {
    assert.equal(getMaxExpressId(storeFor([2 ** 40, -1, 4], false), []), 2 ** 40);
  });

  it('reserves non-mesh entity IDs when registering one and multiple federated models', () => {
    const registry = new FederationRegistry();
    const first = storeFor([900, 2, 900], true);
    registry.registerModel('first', getMaxExpressId(first, [mesh(2)]));
    assert.equal(registry.toGlobalId('first', 900), 900);
    assert.deepEqual(registry.fromGlobalId(900), { modelId: 'first', expressId: 900 });
    const second = storeFor([40, 1], false);
    registry.registerModel('second', getMaxExpressId(second, [mesh(80)]));
    const secondId = registry.toGlobalId('second', 80);
    assert.ok(secondId > 900);
    assert.deepEqual(registry.fromGlobalId(secondId), { modelId: 'second', expressId: 80 });
    assert.deepEqual(registry.fromGlobalId(900), { modelId: 'first', expressId: 900 });
  });
});
