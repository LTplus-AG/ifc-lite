/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A tabular store behind `resolveEntityRef`, at `models.size` of 1 and of N.
 * Ownership is decided by `idOffset` + `maxExpressId` (`store/globalId.ts`), so
 * the models are registered the way a load does it: the watermark from
 * `getMaxExpressId`, the offset from the federation registry.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore, type FederatedModel } from '@/store';
import { resolveEntityRef, resolveGlobalId } from '@/store/resolveEntityRef.js';

import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { PROXY_A, PROXY_B, WALL, tabularFixtureStore } from '@/test/tabular-store-fixture.js';
import { getMaxExpressId } from './viewerModelIngest.js';

function meshFor(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    normals: new Float32Array(9),
    color: [1, 1, 1, 1],
  };
}

/** Register one model per id and install them, returning each model's offset. */
function installModels(...ids: string[]): Map<string, { idOffset: number; store: IfcDataStore }> {
  const installed = new Map<string, { idOffset: number; store: IfcDataStore }>();
  const models: FederatedModel[] = [];
  for (const id of ids) {
    const store = tabularFixtureStore();
    const maxExpressId = getMaxExpressId(store, [PROXY_A, PROXY_B, WALL].map(meshFor));
    const idOffset = federationRegistry.registerModel(id, maxExpressId);
    installed.set(id, { idOffset, store });
    models.push({ ...fixtureModel(id, { idOffset }), maxExpressId, ifcDataStore: store });
  }
  useViewerStore.setState({ models: fixtureModels(...models).models });
  return installed;
}

describe('resolveEntityRef over tabular stores', () => {
  beforeEach(() => {
    federationRegistry.clear();
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, mutationViews: new Map() });
  });

  it('models.size 1: the global id is the express id', () => {
    const { idOffset, store } = installModels('only').get('only')!;
    assert.equal(idOffset, 0);

    const ref = resolveEntityRef(WALL);
    assert.deepEqual(ref, { modelId: 'only', expressId: WALL });
    assert.equal(store.getEntity(ref.expressId)?.type, 'IfcWall');
    assert.equal(resolveGlobalId(WALL), '0aBcDeFgHiJkLmNoPqRs03');
  });

  it('models.size N: each global id resolves to its own model and row', () => {
    const installed = installModels('first', 'second');
    const first = installed.get('first')!;
    const second = installed.get('second')!;
    assert.ok(second.idOffset > first.idOffset, 'the second model sits above the first one\'s range');

    assert.deepEqual(resolveEntityRef(first.idOffset + PROXY_A), { modelId: 'first', expressId: PROXY_A });
    // The highest id of the first range and the lowest of the second are neighbours.
    assert.deepEqual(resolveEntityRef(first.idOffset + WALL), { modelId: 'first', expressId: WALL });
    assert.deepEqual(resolveEntityRef(second.idOffset + PROXY_A), { modelId: 'second', expressId: PROXY_A });

    const ref = resolveEntityRef(second.idOffset + WALL);
    assert.deepEqual(ref, { modelId: 'second', expressId: WALL });
    const owner = useViewerStore.getState().models.get(ref.modelId)!.ifcDataStore!;
    assert.equal(owner, second.store);
    assert.equal(owner.getEntity(ref.expressId)?.type, 'IfcWall');
    assert.equal(owner.getQuantities(ref.expressId)[0]?.name, 'Qto_WallBaseQuantities');
    assert.equal(resolveGlobalId(second.idOffset + WALL), '0aBcDeFgHiJkLmNoPqRs03');
  });
});
