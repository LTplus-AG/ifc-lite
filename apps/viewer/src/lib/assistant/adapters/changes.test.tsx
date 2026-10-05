/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { cleanup, click, render } from '@/test/render';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore } from '@/store';
import { changeOperations } from '@/lib/changes/change-operations';
import { revertChangeOperation } from '@/lib/changes/revert-change-operation';
import { inverseMutationTargets } from '@/store/slices/mutation-inverse-registry';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, useAssistant } from '../conversation';
import { adapterFor } from './registry';
import { architectureSample, idsOfType, sampleModel } from './coordination.test-support';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

interface Row { kind: string; modelId: string; globalId: string | null; expressId: number | null; type: string;
  psetName: string | null; propName: string | null; oldValue: unknown; newValue: unknown; timestamp: string;
  operationId: string; atUndoTop: boolean }
const rowsOf = (payload: string): Row[] => JSON.parse(payload).evidence.rows.map((row: { data: Row }) => row.data);
const summaryOf = (payload: string) => JSON.parse(payload).evidence.summary;

async function seed(modelIds: string[]) {
  const store = await architectureSample();
  const models = new Map(modelIds.map((id, index) => [id, sampleModel(id, store, index * 1_000_000)] as const));
  const views = new Map(modelIds.map(id => [id, new MutablePropertyView(store.properties, id)] as const));
  useViewerStore.setState({ models, activeModelId: modelIds[0] ?? null, mutationViews: views, undoStacks: new Map(),
    redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    editEnabled: true, collabRoomId: null });
  return { store, views };
}

test('#6833 changes: no loaded model is unavailable; a loaded model without edits is an empty journal', async () => {
  useViewerStore.setState({ models: new Map(), activeModelId: null });
  const none = captureEvidence('changes');
  assert.equal(JSON.parse(none.payload).sourceAvailability, 'unavailable');
  assert.equal(none.totalRows, 0);

  await seed(['A']);
  const empty = captureEvidence('changes');
  assert.equal(JSON.parse(empty.payload).sourceAvailability, 'available');
  assert.equal(empty.totalRows, 0);
  assert.equal(summaryOf(empty.payload).operationCount, 0);
});

test('#6833 changes: real wall edits over two models keep native totals, real GlobalIds and newest-first order', async () => {
  const { store, views } = await seed(['A', 'B']);
  const walls = idsOfType(store, 'IfcWall');
  assert.ok(walls.length > 0, 'the authored sample contains walls');
  const state = useViewerStore.getState();
  for (let i = 0; i < 120; i++) {
    state.setProperty('A', walls[i % walls.length], 'Pset_Review', `Check${i}`, `value-${i}`, PropertyValueType.Label);
  }
  // A federated Bulk batch: one operation spanning both models.
  const wall = walls[0];
  const tag = state.recordMutationBatch('A', [views.get('A')!.setProperty(wall, 'Pset_Bulk', 'Code', 'bulk-a', PropertyValueType.Label)]);
  state.recordMutationBatch('B', [views.get('B')!.setProperty(wall, 'Pset_Bulk', 'Code', 'bulk-b', PropertyValueType.Label)], tag ?? undefined);

  const snapshot = captureEvidence('changes');
  const payload = JSON.parse(snapshot.payload);
  const summary = summaryOf(snapshot.payload);
  assert.equal(snapshot.totalRows, 122);
  assert.equal(summary.editCount, 122);
  assert.equal(summary.operationCount, 121, 'the federated batch is one operation');
  assert.deepEqual(summary.byModel, { A: { operations: 121, edits: 121 }, B: { operations: 1, edits: 1 } });
  assert.deepEqual(summary.undoDepthByModel, { A: 121, B: 1 });
  assert.equal(summary.byType.CREATE_PROPERTY + (summary.byType.UPDATE_PROPERTY ?? 0), 122);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);

  const rows = rowsOf(snapshot.payload);
  const [batchA, batchB, newest] = rows;
  assert.equal(batchA.operationId, batchB.operationId);
  assert.deepEqual([batchA.modelId, batchB.modelId].sort(), ['A', 'B']);
  assert.equal(batchA.atUndoTop, true);
  assert.equal(batchA.globalId, store.entities.getGlobalId(wall), 'GlobalId is the source file value');
  assert.match(batchA.globalId ?? '', /^[0-9A-Za-z_$]{22}$/);
  assert.equal(newest.kind, 'change');
  assert.equal(newest.propName, 'Check119');
  assert.equal(newest.newValue, 'value-119');
  assert.equal(newest.expressId, walls[119 % walls.length]);
  assert.equal(newest.atUndoTop, false, 'the batch sits above it on the undo stack');
  assert.ok(!Number.isNaN(Date.parse(newest.timestamp)));
  assert.equal(evidenceIsCurrent(snapshot), true);

  // Undo replaces the journal: the snapshot is no longer the current history.
  useViewerStore.getState().undo('B');
  assert.equal(evidenceIsCurrent(snapshot), false);
});

test('#6833 changes: reverted pairs are hidden as in the drawer and an edit stales earlier evidence', async () => {
  const { store } = await seed(['A']);
  const [wall] = idsOfType(store, 'IfcWall');
  const state = useViewerStore.getState();
  state.setProperty('A', wall, 'Pset_Review', 'Status', 'draft', PropertyValueType.Label);
  state.setProperty('A', wall, 'Pset_Review', 'Owner', 'QA', PropertyValueType.Label);
  const operations = changeOperations(useViewerStore.getState().undoStacks, useViewerStore.getState().mutationBatchTags,
    inverseMutationTargets(useViewerStore));
  const older = operations[1];
  assert.equal(revertChangeOperation(useViewerStore, older).ok, true);

  const snapshot = captureEvidence('changes');
  const summary = summaryOf(snapshot.payload);
  assert.equal(snapshot.totalRows, 1, 'the reverted edit and its inverse are not reported as live edits');
  assert.equal(summary.hiddenRevertedEdits, 2);
  assert.equal(rowsOf(snapshot.payload)[0].propName, 'Owner');
  assert.deepEqual(adapterFor('changes').readiness(useViewerStore.getState()).status,
    { labelKey: 'assistantSources.changes.ready', params: { count: 1 } }, 'the picker counts the edits capture attaches');

  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(snapshot), false);
});

test('#6833 changes: the Changes drawer header attaches the journal', async () => {
  const { store } = await seed(['A']);
  useViewerStore.getState().setProperty('A', idsOfType(store, 'IfcWall')[0], 'Pset_Review', 'Status', 'draft', PropertyValueType.Label);
  const ui = render(renderPanelBody('changes', () => undefined));
  const discuss = ui.querySelector<HTMLButtonElement>('button[aria-label="Discuss with AI"]');
  assert.ok(discuss, 'Changes header offers Discuss with AI');
  click(discuss);
  const snapshot = useAssistant.getState().snapshot;
  assert.equal(snapshot?.source, 'changes');
  assert.equal(snapshot?.totalRows, 1);
});
