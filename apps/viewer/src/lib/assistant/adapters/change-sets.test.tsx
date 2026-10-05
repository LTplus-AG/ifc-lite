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
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, useAssistant } from '../conversation';
import { architectureSample, idsOfType, sampleModel } from './coordination.test-support';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

interface Row { kind: string; status: string; id: string; name: string; active: boolean; editCount: number;
  elementCount: number; modelIds: string[]; editKinds: Record<string, number>; createdAt: string }
const rowsOf = (payload: string): Row[] => JSON.parse(payload).evidence.rows.map((row: { data: Row }) => row.data);

async function seed(modelIds: string[]) {
  const store = await architectureSample();
  useViewerStore.setState({
    models: new Map(modelIds.map((id, index) => [id, sampleModel(id, store, index * 1_000_000)] as const)),
    activeModelId: modelIds[0], mutationViews: new Map(modelIds.map(id => [id, new MutablePropertyView(store.properties, id)] as const)),
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(), mutationVersion: 0,
    editEnabled: true, collabRoomId: null, changeSets: new Map(), activeChangeSetId: null, cameraCallbacks: {},
  });
  return store;
}

test('#6833 changeSets: no set is unavailable; sets report bounded metadata from real edits across two models', async () => {
  const store = await seed(['A', 'B']);
  const none = captureEvidence('changeSets');
  assert.equal(JSON.parse(none.payload).sourceAvailability, 'unavailable');

  const [wallA, wallB] = idsOfType(store, 'IfcWall');
  const state = useViewerStore.getState();
  const facade = state.createChangeSet('Facade review');
  state.setProperty('A', wallA, 'Pset_Review', 'Status', 'secret-value-not-exported', PropertyValueType.Label);
  state.setProperty('B', wallB, 'Pset_Review', 'Status', 'checked', PropertyValueType.Label);
  state.setProperty('A', wallA, 'Pset_Review', 'Owner', 'QA', PropertyValueType.Label);
  const empty = state.createChangeSet('Empty follow-up');

  const snapshot = captureEvidence('changeSets');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, 2);
  assert.equal(payload.evidence.summary.activeSetId, empty);
  assert.equal(payload.evidence.summary.editsInSets, 3);
  assert.equal(payload.evidence.summary.emptySets, 1);
  const rows = rowsOf(snapshot.payload);
  const first = rows.find(row => row.id === facade);
  const second = rows.find(row => row.id === empty);
  assert.ok(first && second);
  assert.equal(first.name, 'Facade review');
  assert.equal(first.active, false);
  assert.equal(first.editCount, 3);
  assert.equal(first.elementCount, 2, 'one wall per model');
  assert.deepEqual(first.modelIds.sort(), ['A', 'B']);
  assert.equal(Object.values(first.editKinds).reduce((sum, count) => sum + count, 0), 3);
  assert.equal(second.status, 'active');
  assert.equal(second.editCount, 0);
  assert.doesNotMatch(snapshot.payload, /secret-value-not-exported/, 'edit values are not change set evidence');
  assert.equal(evidenceIsCurrent(snapshot), true);

  // Renaming replaces the set map; an edit into the active set does too.
  useViewerStore.getState().renameChangeSet(facade, 'Facade review v2');
  assert.equal(evidenceIsCurrent(snapshot), false);
  const renamed = captureEvidence('changeSets');
  useViewerStore.getState().setActiveChangeSet(null);
  assert.equal(evidenceIsCurrent(renamed), false, 'switching the active set is a different native state');
});

test('#6833 changeSets: more sets than the row budget keep the exact native count', async () => {
  await seed(['A']);
  for (let i = 0; i < 105; i++) useViewerStore.getState().createChangeSet(`Set ${i}`);
  const snapshot = captureEvidence('changeSets');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 105);
  assert.equal(payload.evidence.summary.setCount, 105);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
});

test('#6833 changeSets: the Change sets panel header attaches its sets', async () => {
  await seed(['A']);
  useViewerStore.getState().createChangeSet('Site');
  const ui = render(renderPanelBody('changeSets', () => undefined));
  const discuss = ui.querySelector<HTMLButtonElement>('button[aria-label="Discuss with AI"]');
  assert.ok(discuss, 'Change sets header offers Discuss with AI');
  click(discuss);
  assert.equal(useAssistant.getState().snapshot?.source, 'changeSets');
  assert.equal(useAssistant.getState().snapshot?.totalRows, 1);
});
