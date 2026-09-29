/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6232 — `bim.store`'s type and material methods through the real
 * `createStoreAdapter`, on the committed Bonsai hello-wall sample (wall
 * #1222). Same minimal fake `StoreApi` as the cost/structural adapter tests:
 * a real `MutablePropertyView`, spies for the undo and room mirroring hooks.
 * The hosted openings, doors and windows write through the store's
 * `addHostedFill` and are covered over the real store in
 * `store-adapter-hosted.test.ts`.
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
  const undoCalls: Array<[number, string]> = [];
  const relationshipMutationCalls: string[] = [];
  const created: Array<{ entityId: number; ifcType: string }> = [];
  const geometryResult = { meshes: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } } };
  const model = { id: 'm', name: 'hello-wall.ifc', ifcDataStore: dataStore, schemaVersion: 'IFC4', fileSize: bytes.byteLength, loadedAt: 0, idOffset: 0, maxExpressId: 5000, geometryResult };
  registerStoreSlot(dataStore, { slotId: 'm0', pathPrefix: '/m0' });
  const state = {
    activeModelId: 'm',
    ifcDataStore: null,
    models: new Map([['m', model]]),
    collabRoomId: 'room',
    collabRoomModels: new Map([['m', { slotId: 'm0', pathPrefix: '/m0' }]]),
    getMutationView: (id: string) => mutationViews.get(id) ?? null,
    registerMutationView: (id: string, view: MutablePropertyView) => { mutationViews.set(id, view); },
    pushCreateEntityUndo: (_modelId: string, entityId: number, ifcType: string) => { undoCalls.push([entityId, ifcType]); },
    markCostRelationshipMutation: (modelId: string) => { relationshipMutationCalls.push(modelId); },
    canCollabEdit: () => canCollabEdit,
    editEnabled: true,
    mirrorEntityCreate: (_modelId: string, entityId: number, ifcType: string, roomKey: string) => {
      created.push({ entityId, ifcType });
      registerEntityPath(dataStore, entityId, pathForGuid(dataStore, roomKey));
    },
    mirrorAttributeEdit: () => {},
    mirrorEntityRemove: () => {},
    mutationViews,
    mutationVersion: 0,
    mergeLayers: false,
    georefMutations: new Map(),
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  return { store, mutationViews, undoCalls, relationshipMutationCalls, created };
}

describe('#6232 store-adapter modelling surface', () => {
  it('undoes a new type as one record, and fences undo for a type assignment', async () => {
    const { store, undoCalls, relationshipMutationCalls, created } = await makeStore();
    const adapter = createStoreAdapter(store);
    const type = adapter.addElementType('m', { Type: 'IfcWallType', Name: 'EW-300' });
    assert.deepEqual(undoCalls, [[type.expressId, 'IFCWALLTYPE']]);
    assert.deepEqual(relationshipMutationCalls, []);

    const rel = adapter.assignType('m', type.expressId, [WALL]);
    assert.ok(created.some((c) => c.entityId === rel.expressId && c.ifcType.toUpperCase() === 'IFCRELDEFINESBYTYPE'));
    assert.deepEqual(relationshipMutationCalls, ['m']);
  });
});
