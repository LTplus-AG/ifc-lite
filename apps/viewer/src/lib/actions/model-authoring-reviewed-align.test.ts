/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { MODEL, seedNativeSdkModel, settle, nativeSdkUndoDepth } from '@/test/native-sdk-model';
import { ensureRoomWasm } from '@/test/room-walls-fixture';
import { setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { captureSelectionGrounding } from './selection-grounding';
import { parseModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { prepareReviewedAlignments } from './model-authoring-align';
import { commitModelAuthoring } from './model-authoring-commit';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { storeyBoxes } from '@/lib/commands/modeling/align-boxes';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseIfc } from '@/test/authoring-sample-fixture';
const original = useViewerStore.getState();
afterEach(() => { setRemeshClientFactory(null); useViewerStore.setState(original, true); });
async function setup() {
  const { adapter, view } = await seedNativeSdkModel();
  const reference = adapter.addColumn(MODEL, 42, { Position: [20,20,0], Width: .8, Depth: .4, Height: 3, Name: 'Reference' });
  const first = adapter.addColumn(MODEL, 42, { Position: [24,21,0], Width: .4, Depth: .4, Height: 3, Name: 'First target' });
  const second = adapter.addColumn(MODEL, 42, { Position: [28,22,0], Width: .6, Depth: .4, Height: 3, Name: 'Second target' });
  await settle();
  useViewerStore.setState({ selectedEntityIds: new Set([reference.expressId, first.expressId, second.expressId]), selectedEntityId: reference.expressId });
  const captured = captureSelectionGrounding(useViewerStore.getState());
  assert.equal(captured.elements.length, 3);
  const rows = [reference, first, second].map(ref => {
    const guid = view.getNewEntity(ref.expressId)?.attributes[0];
    const row = captured.elements.find(row => row.globalId === guid); assert.ok(row?.nativePlacement);
    return row;
  });
  const target = (row: typeof rows[number]) => ({ modelId: row.modelId, globalId: row.globalId, ifcClass: row.type, name: row.name });
  const batch = parseModelAuthoringBatch(JSON.stringify({ kind:'model.authoring', version:1, title:'Native align', units:'m', frame:'storey-local',
    operations: [{ op:'element.align', reference: target(rows[0]), targets: rows.slice(1).map(target), mode:'left',
      expected:{ reference: rows[0].nativePlacement, targets: rows.slice(1).map(row => row.nativePlacement) } }] }));
  const plane = buildStoreyWorkplane(useViewerStore.getState(), MODEL, 42, 0); assert.ok(isWorkplane(plane));
  return { view, batch, reference, first, second, boxes: () => storeyBoxes(useViewerStore.getState(), MODEL, 42, plane) };
}

test('#7313 reviewed Align prepares actual Bonsai geometry, applies two different native shifts and one Undo restores the IFC graph', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup(), before = s.boxes(), graph = structuredClone(s.view.getNewEntities()), undo = nativeSdkUndoDepth();
  assert.equal(previewModelAuthoring(useViewerStore.getState(), s.batch).rows[0].status, 'blocked');
  await prepareReviewedAlignments(useViewerStore.getState, s.batch);
  const preview = previewModelAuthoring(useViewerStore.getState(), s.batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
  const result = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'Native evidence');
  assert.ok(result.ok, result.ok ? '' : result.detail ?? result.reason);
  await settle();
  const after = s.boxes(), fixed = before.get(s.reference.expressId); assert.ok(fixed);
  assert.deepEqual(after.get(s.reference.expressId), fixed);
  for (const ref of [s.first, s.second]) {
    const box = after.get(ref.expressId), old = before.get(ref.expressId); assert.ok(box && old);
    assert.ok(Math.abs(box.min[0] - fixed.min[0]) < 1e-4);
    assert.ok(Math.abs(box.min[1] - old.min[1]) < 1e-4);
  }
  const model = useViewerStore.getState().models.get(MODEL); assert.ok(model?.ifcDataStore);
  const parsed = await parseIfc(editedModelBytes(model.ifcDataStore, s.view));
  assert.equal(parsed.entities.getTypeName(s.first.expressId), 'IfcColumn');
  assert.equal(parsed.entities.getTypeName(s.second.expressId), 'IfcColumn');
  useViewerStore.getState().undo(MODEL); await settle();
  assert.equal(nativeSdkUndoDepth(), undo);
  assert.deepEqual(s.view.getNewEntities(), graph);
  assert.deepEqual(s.boxes(), before);
});

test('#7313 held Align preparation cannot approve a direct native revision', async t => {
  if (!ensureRoomWasm(t)) return;
  const s = await setup();
  await prepareReviewedAlignments(useViewerStore.getState, s.batch);
  const held = previewModelAuthoring(useViewerStore.getState(), s.batch);
  assert.equal(held.rows[0].status, 'ready');
  s.view.setAttribute(s.first.expressId, 'Name', 'Changed after preparation');
  assert.notEqual(previewModelAuthoring(useViewerStore.getState(), s.batch).rows[0].status, 'ready');
  const result = commitModelAuthoring(useViewerStore, held, new Set([0]), 'Stale');
  assert.equal(result.ok, false);
});
