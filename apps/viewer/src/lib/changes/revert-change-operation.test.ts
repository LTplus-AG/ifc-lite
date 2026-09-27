/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { changeOperations } from './change-operations.js';
import { revertChangeOperation } from './revert-change-operation.js';
import { inverseMutationTargets } from '@/store/slices/mutation-inverse-registry';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));

const source = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('changes.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);\n#101=IFCWALL('0Wall00000000000000101',$,'W1',$,$,$,$,'T1',$);\n#102=IFCWALL('0Wall00000000000000102',$,'W2',$,$,$,$,'T2',$);\nENDSEC;\nEND-ISO-10303-21;`;

async function install(ids: readonly string[]) {
  const bytes = new TextEncoder().encode(source);
  const data = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const views = new Map(ids.map(id => [id, new MutablePropertyView(data.properties, id)] as const));
  const models = new Map(ids.map((id, index) => [id, { ...fixtureModel(id, { idOffset: index * 1_000 }), ifcDataStore: data }] as const));
  useViewerStore.setState({ models, activeModelId: ids[0], ifcDataStore: data, mutationViews: views,
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(),
    editEnabled: true, collabRoomId: null, mutationVersion: 0 });
  return views;
}

function rows() {
  const state = useViewerStore.getState();
  return changeOperations(state.undoStacks, state.mutationBatchTags, inverseMutationTargets(useViewerStore));
}

for (const ids of [['A'], ['A', 'B']]) test(`#5902 reverts an older independent property edit as one undoable inverse at ${ids.length} model(s)`, async () => {
  const views = await install(ids);
  const state = useViewerStore.getState();
  const first = state.setProperty('A', 101, 'Pset_Test', 'Status', 'before', PropertyValueType.Label);
  assert.ok(first);
  const bulkA = views.get('A')!.setProperty(102, 'Pset_Bulk', 'Code', 'bulk', PropertyValueType.Label);
  const tag = state.recordMutationBatch('A', [bulkA]);
  if (ids.length > 1) {
    const bulkB = views.get('B')!.setProperty(102, 'Pset_Bulk', 'Code', 'bulk', PropertyValueType.Label);
    state.recordMutationBatch('B', [bulkB], tag ?? undefined);
  }
  assert.deepEqual(rows().map(row => row.mutations.length), [ids.length, 1]);
  assert.deepEqual(revertChangeOperation(useViewerStore, rows()[1]), { ok: true, mode: 'inverse' });
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_Test', 'Status'), null);
  assert.equal(views.get('A')!.getPropertyValue(102, 'Pset_Bulk', 'Code'), 'bulk');
  assert.equal(rows().length, 1, 'the restored property no longer counts as a pending row');
  useViewerStore.getState().undo('A');
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_Test', 'Status'), 'before');
  assert.equal(rows().length, 2);
  useViewerStore.getState().redo('A');
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_Test', 'Status'), null);
  assert.equal(rows().length, 1);
});

test('#5902 a newer edit to the same IFC slot refuses an older reversal without changing either value', async () => {
  const views = await install(['A']);
  const first = useViewerStore.getState().setProperty('A', 101, 'Pset_Test', 'Status', 'first', PropertyValueType.Label);
  assert.ok(first);
  useViewerStore.getState().setProperty('A', 101, 'Pset_Test', 'Status', 'second', PropertyValueType.Label);
  assert.deepEqual(revertChangeOperation(useViewerStore, rows()[1]), { ok: false, reason: 'newer-conflict' });
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_Test', 'Status'), 'second');
  assert.equal(useViewerStore.getState().undoStacks.get('A')?.length, 2);
});

test('#5902 Revert refuses a shared room before changing its local overlay', async () => {
  const views = await install(['A']);
  const mutation = useViewerStore.getState().setProperty('A', 101, 'Pset_Test', 'Status', 'draft', PropertyValueType.Label);
  assert.ok(mutation);
  useViewerStore.setState({ collabRoomId: 'shared-room' });
  assert.deepEqual(revertChangeOperation(useViewerStore, rows()[0]), { ok: false, reason: 'shared-room' });
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_Test', 'Status'), 'draft');
  assert.equal(useViewerStore.getState().undoStacks.get('A')?.length, 1);
});

test('#5902 a later same-entity attribute blocks older class reversal', async () => {
  await install(['A']);
  const earlier = { id: 'retype', modelId: 'A', entityId: 101, timestamp: 1,
    type: 'UPDATE_ENTITY_TYPE' as const, oldType: 'IFCWALL', newType: 'IFCSLAB' };
  const later = { id: 'attribute', modelId: 'A', entityId: 101, timestamp: 2,
    type: 'UPDATE_ATTRIBUTE' as const, attributeName: 'Name', oldValue: 'W1', newValue: 'Edited' };
  useViewerStore.setState({ undoStacks: new Map([['A', [earlier, later]]]) });
  assert.deepEqual(revertChangeOperation(useViewerStore, rows()[1]), { ok: false, reason: 'newer-conflict' });
  assert.equal(useViewerStore.getState().undoStacks.get('A')?.length, 2);
});

test('#5902 Revert of a federated top batch undoes every target model as one row', async () => {
  const views = await install(['A', 'B']);
  const first = views.get('A')!.setProperty(101, 'Pset_Bulk', 'Code', 'batch', PropertyValueType.Label);
  const tag = useViewerStore.getState().recordMutationBatch('A', [first]);
  const second = views.get('B')!.setProperty(102, 'Pset_Bulk', 'Code', 'batch', PropertyValueType.Label);
  useViewerStore.getState().recordMutationBatch('B', [second], tag ?? undefined);
  assert.equal(rows().length, 1);
  assert.deepEqual(revertChangeOperation(useViewerStore, rows()[0]), { ok: true, mode: 'undo' });
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_Bulk', 'Code'), null);
  assert.equal(views.get('B')!.getPropertyValue(102, 'Pset_Bulk', 'Code'), null);
  assert.equal(rows().length, 0);
});

test('#5902 a missing federated view refuses the whole top batch before any model is undone', async () => {
  const views = await install(['A', 'B']);
  const first = views.get('A')!.setProperty(101, 'Pset_Bulk', 'Code', 'batch', PropertyValueType.Label);
  const tag = useViewerStore.getState().recordMutationBatch('A', [first]);
  const second = views.get('B')!.setProperty(102, 'Pset_Bulk', 'Code', 'batch', PropertyValueType.Label);
  useViewerStore.getState().recordMutationBatch('B', [second], tag ?? undefined);
  useViewerStore.setState({ mutationViews: new Map([['A', views.get('A')!]]) });
  assert.deepEqual(revertChangeOperation(useViewerStore, rows()[0]), { ok: false, reason: 'missing-view' });
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_Bulk', 'Code'), 'batch');
  assert.equal(views.get('B')!.getPropertyValue(102, 'Pset_Bulk', 'Code'), 'batch');
  assert.equal(useViewerStore.getState().undoStacks.get('A')?.length, 1);
  assert.equal(useViewerStore.getState().undoStacks.get('B')?.length, 1);
});

test('#5902 reverting another model selects its history for the next Ctrl+Y', async () => {
  const views = await install(['A', 'B']);
  const edit = useViewerStore.getState().setProperty('B', 101, 'Pset_Test', 'Status', 'draft', PropertyValueType.Label);
  assert.ok(edit);
  assert.equal(useViewerStore.getState().activeModelId, 'A');
  assert.deepEqual(revertChangeOperation(useViewerStore, rows()[0]), { ok: true, mode: 'undo' });
  assert.equal(useViewerStore.getState().activeModelId, 'B');
  useViewerStore.getState().redo('B');
  assert.equal(views.get('B')!.getPropertyValue(101, 'Pset_Test', 'Status'), 'draft');
});
