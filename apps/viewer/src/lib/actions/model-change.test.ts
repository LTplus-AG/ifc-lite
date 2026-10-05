/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { changeOperations } from '@/lib/changes/change-operations';
import { inverseMutationTargets } from '@/store/slices/mutation-inverse-registry';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseModelChangeBatch, type ModelChangeBatch } from './model-change';
import { previewCounts, previewModelChanges } from './model-change-preview';
import { commitModelChanges, undoModelChanges } from './model-change-commit';
import { decodeModelChangeReceipt } from './receipts';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));

const W1 = '0Wall00000000000000101';
const W2 = '0Wall00000000000000102';
const source = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('changes.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);\n#101=IFCWALL('${W1}',$,'W1',$,$,$,$,'T1',$);\n#102=IFCWALL('${W2}',$,'W2',$,$,$,$,'T2',$);\nENDSEC;\nEND-ISO-10303-21;`;

async function parse(bytes: Uint8Array) {
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

async function install(ids: readonly string[] = ['A'], editEnabled = true) {
  const data = await parse(new TextEncoder().encode(source));
  const views = new Map(ids.map(id => [id, new MutablePropertyView(data.properties, id)] as const));
  const models = new Map(ids.map((id, index) => [id, { ...fixtureModel(id, { idOffset: index * 1_000 }), ifcDataStore: data }] as const));
  useViewerStore.setState({ models, activeModelId: ids[0], ifcDataStore: data, mutationViews: views,
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(),
    editEnabled, collabRole: null, collabRoomId: null, mutationVersion: 0 });
  return { data, views };
}

const batch = (changes: unknown[]): ModelChangeBatch =>
  parseModelChangeBatch(JSON.stringify({ version: 1, kind: 'model.changes', title: 'Fire ratings', changes }));

test('the contract refuses changes that cannot be checked or would be ambiguous', () => {
  const refuse = (changes: unknown[], pattern: RegExp) => assert.throws(() => batch(changes), pattern);
  refuse([{ op: 'property.set', target: { globalId: W1 }, pset: 'P', name: 'X', value: 'v' }], /expected current value/);
  refuse([{ op: 'property.set', target: { globalId: 'short' }, pset: 'P', name: 'X', expected: null, value: 'v' }], /22-character IFC GlobalId/);
  refuse([{ op: 'attribute.set', target: { globalId: W1 }, name: 'GlobalId', expected: W1, value: 'x' }], /can only set Name/);
  const twice = { op: 'property.set', target: { globalId: W1 }, pset: 'P', name: 'X', expected: null, value: 'v' };
  refuse([twice, { ...twice, value: 'w' }], /each value only once/);
  assert.equal(batch([twice]).changes.length, 1);
});

test('preview resolves GlobalIds and compares expected values with the effective model', async () => {
  const { views } = await install();
  useViewerStore.getState().setProperty('A', 102, 'Pset_WallCommon', 'FireRating', 'EI30', PropertyValueType.Label);
  const preview = previewModelChanges(useViewerStore.getState(), batch([
    { op: 'property.set', target: { globalId: W1 }, pset: 'Pset_WallCommon', name: 'FireRating', expected: null, value: 'EI60' },
    { op: 'property.set', target: { globalId: W2 }, pset: 'Pset_WallCommon', name: 'FireRating', expected: null, value: 'EI60' },
    { op: 'attribute.set', target: { globalId: W1 }, name: 'Tag', expected: 'T1', value: 'T1' },
    { op: 'attribute.set', target: { globalId: '2Missing0000000000000x' }, name: 'Name', expected: '', value: 'X' },
  ]));
  assert.deepEqual(preview.rows.map(row => row.status), ['ready', 'conflict', 'unchanged', 'missing-target']);
  assert.equal(preview.rows[1].current, 'EI30', 'a conflict shows the value the model has now');
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_WallCommon', 'FireRating'), null, 'preview writes nothing');
  assert.deepEqual(previewCounts(preview.rows).ready, 1);
});

test('a GlobalId in two loaded models is ambiguous until the batch names the model', async () => {
  await install(['A', 'B']);
  const change = { op: 'attribute.set', target: { globalId: W1 }, name: 'Name', expected: 'W1', value: 'Wall 1' };
  assert.equal(previewModelChanges(useViewerStore.getState(), batch([change])).rows[0].status, 'ambiguous-target');
  const pinned = previewModelChanges(useViewerStore.getState(), batch([{ ...change, target: { globalId: W1, modelId: 'B' } }])).rows[0];
  assert.deepEqual([pinned.status, pinned.modelId], ['ready', 'B']);
});

test('without Edit mode every row is refused by the native edit gate', async () => {
  await install(['A'], false);
  const row = previewModelChanges(useViewerStore.getState(), batch([
    { op: 'attribute.set', target: { globalId: W1 }, name: 'Name', expected: 'W1', value: 'Wall 1' }])).rows[0];
  assert.equal(row.status, 'denied');
  assert.match(row.denial ?? '', /Edit mode/);
});

test('approved rows commit as one native undo step with a receipt, and export the edited values', async () => {
  const { data, views } = await install();
  const preview = previewModelChanges(useViewerStore.getState(), batch([
    { op: 'property.set', target: { globalId: W1 }, pset: 'Pset_WallCommon', name: 'FireRating', expected: null, value: 'EI60' },
    { op: 'attribute.set', target: { globalId: W1 }, name: 'Name', expected: 'W1', value: 'Wall 1' },
    { op: 'attribute.set', target: { globalId: W2 }, name: 'Name', expected: 'W2', value: 'Not approved' },
  ]));
  const outcome = commitModelChanges(useViewerStore, preview, new Set([0, 1]), 'test');
  assert.ok(outcome.ok);
  const { receipt } = outcome;
  assert.deepEqual(receipt.applied.map(change => [change.field, change.before, change.after]),
    [['Pset_WallCommon.FireRating', null, 'EI60'], ['Name', 'W1', 'Wall 1']]);
  assert.deepEqual(receipt.skipped, [{ index: 2, status: 'not-approved' }]);
  const state = useViewerStore.getState();
  const operations = changeOperations(state.undoStacks, state.mutationBatchTags, inverseMutationTargets(useViewerStore));
  assert.equal(operations.length, 1, 'the whole batch is one row in Changes');
  assert.equal(operations[0].id, `batch:${receipt.batches[0].batchId}`);
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_WallCommon', 'FireRating'), 'EI60');
  const exported = await parse(editedModelBytes(data, views.get('A')!));
  const wall = exported.entities.getExpressIdByGlobalId(W1)!;
  assert.equal(exported.entities.getName(wall), 'Wall 1', 'export/reparse carries the reviewed attribute');
  assert.equal(decodeModelChangeReceipt(JSON.parse(JSON.stringify(receipt)))?.digest, receipt.digest, 'receipts survive serialization');

  state.undo('A');
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_WallCommon', 'FireRating'), null, 'one Ctrl+Z reverts every applied change');
});

test('a preview is stale once the model changes, and undo refuses to overwrite newer edits', async () => {
  const { views } = await install();
  const preview = previewModelChanges(useViewerStore.getState(), batch([
    { op: 'property.set', target: { globalId: W1 }, pset: 'Pset_WallCommon', name: 'FireRating', expected: null, value: 'EI60' }]));
  useViewerStore.getState().setProperty('A', 102, 'Pset_Other', 'Note', 'x', PropertyValueType.Label);
  assert.deepEqual(commitModelChanges(useViewerStore, preview, new Set([0]), 'test'), { ok: false, reason: 'stale' });

  const fresh = previewModelChanges(useViewerStore.getState(), preview.batch);
  const outcome = commitModelChanges(useViewerStore, fresh, new Set([0]), 'test');
  assert.ok(outcome.ok);
  useViewerStore.getState().setProperty('A', 101, 'Pset_WallCommon', 'FireRating', 'EI90', PropertyValueType.Label);
  const refused = undoModelChanges(useViewerStore, outcome.receipt);
  assert.equal(refused.ok, false);
  assert.equal(views.get('A')!.getPropertyValue(101, 'Pset_WallCommon', 'FireRating'), 'EI90', 'the newer value is kept');
});
