/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6232 — `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow` through
 * the real `createStoreAdapter`, on the committed Bonsai hello-wall sample
 * (host wall #1222). Same minimal fake `StoreApi` as the cost/structural
 * adapter tests: a real `MutablePropertyView`, spies for the undo and room
 * mirroring hooks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { StoreApi } from './types.js';
import { createStoreAdapter } from './store-adapter.js';
import { pathForGuid, registerEntityPath, registerStoreSlot } from '@/lib/collab/entity-paths.js';

const SAMPLE = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
const WALL = 1222;

async function makeStore(canCollabEdit = true) {
  const bytes = readFileSync(SAMPLE);
  const dataStore = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const mutationViews = new Map<string, MutablePropertyView>();
  const undoCalls: number[] = [];
  const relationshipMutationCalls: string[] = [];
  const created: Array<{ entityId: number; ifcType: string }> = [];
  const model = { id: 'm', name: 'hello-wall.ifc', ifcDataStore: dataStore, schemaVersion: 'IFC4', fileSize: bytes.byteLength, loadedAt: 0, idOffset: 0, maxExpressId: 5000 };
  registerStoreSlot(dataStore, { slotId: 'm0', pathPrefix: '/m0' });
  const state = {
    activeModelId: 'm',
    ifcDataStore: null,
    models: new Map([['m', model]]),
    collabRoomId: 'room',
    collabRoomModels: new Map([['m', { slotId: 'm0', pathPrefix: '/m0' }]]),
    getMutationView: (id: string) => mutationViews.get(id) ?? null,
    registerMutationView: (id: string, view: MutablePropertyView) => { mutationViews.set(id, view); },
    pushCreateEntityUndo: (_modelId: string, entityId: number) => { undoCalls.push(entityId); },
    markCostRelationshipMutation: (modelId: string) => { relationshipMutationCalls.push(modelId); },
    canCollabEdit: () => canCollabEdit,
    editEnabled: true,
    mirrorEntityCreate: (_modelId: string, entityId: number, ifcType: string, roomKey: string) => {
      created.push({ entityId, ifcType });
      registerEntityPath(dataStore, entityId, pathForGuid(dataStore, roomKey));
    },
    mirrorAttributeEdit: () => {},
    mirrorEntityRemove: () => {},
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  return { store, mutationViews, undoCalls, relationshipMutationCalls, created };
}

describe('#6232 store-adapter hosted openings', () => {
  it('refuses every hosted-opening call for a read-only participant, overlay untouched', async () => {
    const { store, mutationViews } = await makeStore(false);
    const adapter = createStoreAdapter(store);
    assert.throws(() => adapter.addOpening('m', WALL, { Offset: 1, Width: 1, Height: 1 }), /Editing is disabled for your role/);
    assert.throws(() => adapter.addHostedDoor('m', WALL, { Offset: 8, Width: 0.9, Height: 2.1 }), /Editing is disabled for your role/);
    assert.throws(() => adapter.addHostedWindow('m', WALL, { Offset: 8, Sill: 1, Width: 1, Height: 1 }), /Editing is disabled for your role/);
    assert.equal(mutationViews.get('m')?.getNewEntities().length ?? 0, 0);
  });

  it('authors the door graph, publishes all of it to the room, and fences undo', async () => {
    const { store, mutationViews, undoCalls, relationshipMutationCalls, created } = await makeStore();
    const adapter = createStoreAdapter(store);
    const door = adapter.addHostedDoor('m', WALL, { Offset: 8, Width: 0.9, Height: 2.1 });

    const view = mutationViews.get('m');
    assert.equal(view?.getNewEntity(door.expressId)?.type, 'IfcDoor');
    const types = new Set(created.map((c) => c.ifcType.toUpperCase()));
    for (const type of ['IFCDOOR', 'IFCOPENINGELEMENT', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT', 'IFCRELCONTAINEDINSPATIALSTRUCTURE']) {
      assert.ok(types.has(type), `${type} was not published to the room`);
    }
    // A single CREATE_ENTITY entry cannot invert the compound write; the
    // model is marked dirty and its undo history fenced instead.
    assert.deepEqual(undoCalls, []);
    assert.deepEqual(relationshipMutationCalls, ['m']);
  });
});
