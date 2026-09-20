/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4857 PR A review — `bim.store.addCost*` (via `createStoreAdapter`) pushes
 * the same CREATE_ENTITY undo entry `addColumn`/etc. push, so a script-
 * authored cost entity is undoable. Exercises the real `createStoreAdapter`
 * against a minimal fake `StoreApi` (a real `MutablePropertyView`, a
 * `pushCreateEntityUndo` spy) rather than a full Zustand store.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { StoreApi } from './types.js';
import { createStoreAdapter } from './store-adapter.js';
import { pathForGuid, registerEntityPath, registerStoreSlot, unregisterEntityPath } from '@/lib/collab/entity-paths.js';

const STEP = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;', 'DATA;',
  "#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);",
  'ENDSEC;', 'END-ISO-10303-21;',
].join('\n');

async function makeStore(canCollabEdit: () => boolean = () => true, legacy = false): Promise<{
  store: StoreApi;
  undoCalls: Array<{ modelId: string; entityId: number; ifcType: string }>;
  relationshipMutationCalls: string[];
  mirrorCalls: Array<{ kind: string; entityId: number; detail?: string; roomKey?: string }>;
}> {
  const bytes = new TextEncoder().encode(STEP);
  const dataStore = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const mutationViews = new Map<string, MutablePropertyView>();
  const undoCalls: Array<{ modelId: string; entityId: number; ifcType: string }> = [];
  const relationshipMutationCalls: string[] = [];
  const mirrorCalls: Array<{ kind: string; entityId: number; detail?: string; roomKey?: string }> = [];
  const model = { id: 'm', name: 't.ifc', ifcDataStore: dataStore, schemaVersion: 'IFC4', fileSize: bytes.byteLength, loadedAt: 0, idOffset: 0, maxExpressId: 100 };
  // Mirroring runs only for a model shared in a live room (#5008): register
  // the model under a slot and let the create spy bind the room path, as the
  // real collab slice does.
  const roomModelId = legacy ? '__legacy__' : 'm';
  registerStoreSlot(dataStore, { slotId: 'm0', pathPrefix: '/m0' });
  const state = {
    activeModelId: legacy ? null : 'm',
    ifcDataStore: legacy ? dataStore : null,
    models: legacy ? new Map() : new Map([['m', model]]),
    collabRoomId: 'room',
    collabRoomModels: new Map([[roomModelId, { slotId: 'm0', pathPrefix: '/m0' }]]),
    getMutationView: (id: string) => mutationViews.get(id) ?? null,
    registerMutationView: (id: string, view: MutablePropertyView) => { mutationViews.set(id, view); },
    pushCreateEntityUndo: (modelId: string, entityId: number, ifcType: string) => {
      undoCalls.push({ modelId, entityId, ifcType });
    },
    markCostRelationshipMutation: (modelId: string) => { relationshipMutationCalls.push(modelId); },
    canCollabEdit,
    mirrorEntityCreate: (_modelId: string, entityId: number, ifcType: string, roomKey: string) => {
      mirrorCalls.push({ kind: 'create', entityId, detail: ifcType, roomKey });
      registerEntityPath(dataStore, entityId, pathForGuid(dataStore, roomKey));
    },
    mirrorAttributeEdit: (_modelId: string, entityId: number, name: string) => {
      mirrorCalls.push({ kind: 'attribute', entityId, detail: name.replace('bsi::ifc::prop::', '') });
    },
    mirrorEntityRemove: (_modelId: string, entityId: number) => {
      mirrorCalls.push({ kind: 'remove', entityId });
      unregisterEntityPath(dataStore, entityId);
    },
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  return { store, undoCalls, relationshipMutationCalls, mirrorCalls };
}

describe('#4857 store-adapter cost authoring pushes CREATE_ENTITY undo', () => {
  it('addCostItem pushes one undo entry naming the created expressId and IFCCOSTITEM', async () => {
    const { store, undoCalls } = await makeStore();
    const adapter = createStoreAdapter(store);
    const ref = adapter.addCostItem('m', { Name: 'Authored' });
    assert.equal(undoCalls.length, 1);
    assert.deepEqual(undoCalls[0], { modelId: ref.modelId, entityId: ref.expressId, ifcType: 'IFCCOSTITEM' });
  });

  it('addCostSchedule / addCostValue / addCostQuantity each push their own undo entry', async () => {
    const { store, undoCalls } = await makeStore();
    const adapter = createStoreAdapter(store);
    adapter.addCostSchedule('m', { Name: 'S' });
    adapter.addCostValue('m', { Name: 'V' });
    adapter.addCostQuantity('m', { Kind: 'IfcQuantityLength', Name: 'Q', Value: 1 });
    assert.deepEqual(undoCalls.map(c => c.ifcType), ['IFCCOSTSCHEDULE', 'IFCCOSTVALUE', 'IFCPHYSICALSIMPLEQUANTITY']);
  });

  it('mirrors created cost entities and relationship rewrites/removals to collaboration peers', async () => {
    const { store, mirrorCalls } = await makeStore();
    const adapter = createStoreAdapter(store);
    const item = adapter.addCostItem('m', { Name: 'I' });
    const value = adapter.addCostValue('m', { Name: 'V' });
    adapter.setCostItemValues('m', item.expressId, [value.expressId]);
    adapter.removeCostEntity('m', value.expressId, { detach: true });
    assert.ok(mirrorCalls.some(call => call.kind === 'create' && call.entityId === item.expressId));
    assert.ok(mirrorCalls.some(call => call.kind === 'create' && call.entityId === value.expressId));
    assert.ok(mirrorCalls.some(call => call.kind === 'attribute' && call.entityId === item.expressId && call.detail === 'CostValues'));
    assert.ok(mirrorCalls.some(call => call.kind === 'remove' && call.entityId === value.expressId));
  });

  it('mirrors cost creation from the legacy public model id (#5018 review)', async () => {
    const { store, mirrorCalls } = await makeStore(() => true, true);
    const item = createStoreAdapter(store).addCostItem('legacy', { Name: 'Legacy item' });
    assert.equal(item.modelId, 'legacy');
    assert.ok(mirrorCalls.some(call => call.kind === 'create' && call.entityId === item.expressId));
    assert.ok(mirrorCalls.some(call => call.kind === 'attribute'
      && call.entityId === item.expressId && call.detail === 'Name'));
  });

  it('gives concurrent non-root cost entities unique room identities (#4857)', async () => {
    const first = await makeStore();
    const second = await makeStore();
    const firstRef = createStoreAdapter(first.store).addCostValue('m', { Name: 'A' });
    const secondRef = createStoreAdapter(second.store).addCostValue('m', { Name: 'B' });
    assert.equal(firstRef.expressId, secondRef.expressId, 'independent peers allocate the same local id');
    const firstKey = first.mirrorCalls.find(call => call.kind === 'create')?.roomKey;
    const secondKey = second.mirrorCalls.find(call => call.kind === 'create')?.roomKey;
    assert.match(firstKey ?? '', /^ifc-lite-store-/);
    assert.match(secondKey ?? '', /^ifc-lite-store-/);
    assert.notEqual(firstKey, secondKey, 'room identity must not derive from the colliding local id');
  });

  it('nestCostItems / assign* / setCostItemValues / removeCostEntity mark the model dirty via markCostRelationshipMutation', async () => {
    const { store, relationshipMutationCalls } = await makeStore();
    const adapter = createStoreAdapter(store);
    const parent = adapter.addCostItem('m', { Name: 'Parent' });
    const child = adapter.addCostItem('m', { Name: 'Child' });
    const schedule = adapter.addCostSchedule('m', { Name: 'S' });
    const value = adapter.addCostValue('m', { Name: 'V' });
    relationshipMutationCalls.length = 0; // only count the 5 calls under test below

    adapter.nestCostItems('m', parent.expressId, [child.expressId]);
    adapter.assignCostItemsToSchedule('m', schedule.expressId, [parent.expressId]);
    adapter.assignToCostItem('m', parent.expressId, [child.expressId]);
    adapter.setCostItemValues('m', parent.expressId, [value.expressId]);
    adapter.removeCostEntity('m', value.expressId, { detach: true });

    assert.deepEqual(relationshipMutationCalls, ['m', 'm', 'm', 'm', 'm']);
  });

  it('does not clear undo history for an already-applied assignment', async () => {
    const { store, relationshipMutationCalls } = await makeStore();
    const adapter = createStoreAdapter(store);
    const schedule = adapter.addCostSchedule('m', { Name: 'S' });
    const item = adapter.addCostItem('m', { Name: 'I' });
    relationshipMutationCalls.length = 0;
    adapter.assignCostItemsToSchedule('m', schedule.expressId, [item.expressId]);
    adapter.assignCostItemsToSchedule('m', schedule.expressId, [item.expressId]);
    assert.deepEqual(relationshipMutationCalls, ['m']);
  });

  it('refuses every cost-authoring call when canCollabEdit() is false (viewer/commenter role in a shared session)', async () => {
    const { store } = await makeStore(() => false);
    const adapter = createStoreAdapter(store);
    assert.throws(() => adapter.addCostItem('m', { Name: 'I' }), /Editing is disabled for your role/);
    assert.throws(() => adapter.nestCostItems('m', 1, [2]), /Editing is disabled for your role/);
    assert.throws(() => adapter.removeCostEntity('m', 1), /Editing is disabled for your role/);
  });
});
