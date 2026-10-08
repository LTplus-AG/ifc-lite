/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { readRelatedLists } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { setElementType } from '@/components/viewer/model-inspector/inspector-edits';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { BACK_WALL, BACK_WALL_NAME, FRONT_WALL_TYPE, FRONT_WALL_TYPE_NAME, SAMPLE_MODEL,
  parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { parseModelAuthoringBatch, type ModelAuthoringBatch } from './model-authoring';
import { previewModelAuthoring } from './model-authoring-preview';
import { commitModelAuthoring } from './model-authoring-commit';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));

async function sharedType() {
  const seeded = await seedAuthoringSample();
  const target = seeded.dataStore.entities.getExpressIdByGlobalId(BACK_WALL)!;
  const typeId = seeded.dataStore.entities.getExpressIdByGlobalId(FRONT_WALL_TYPE)!;
  const originalRelation = readRelatedLists(seeded.dataStore, 'IfcRelDefinesByType', seeded.view)
    .find(rel => rel.relatingId === typeId)!;
  assert.ok(originalRelation.relatedIds.length > 0, 'committed SketchUp type has a real occurrence');
  const peer = originalRelation.relatedIds[0];
  recordModellingEdit(useViewerStore, SAMPLE_MODEL, methods => methods.assignType(SAMPLE_MODEL, typeId, [target]));
  const parsed = await parseIfc(editedModelBytes(seeded.dataStore, seeded.view));
  assert.ok(readRelatedLists(parsed, 'IfcRelDefinesByType', new MutablePropertyView(parsed.properties ?? null, 'parsed'))
    .some(rel => rel.relatingId === typeId && rel.relatedIds.includes(target) && rel.relatedIds.includes(peer)),
  'native assignment and actual independent export create a shared type relationship');
  return { ...seeded, target, typeId, peer };
}

async function exportedRelations(dataStore: Awaited<ReturnType<typeof seedAuthoringSample>>['dataStore'], view: MutablePropertyView) {
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  return { parsed, relations: readRelatedLists(parsed, 'IfcRelDefinesByType', new MutablePropertyView(parsed.properties ?? null, 'parsed')) };
}

function reviewedDetach(units: 'm' | 'mm'): ModelAuthoringBatch {
  let parsed: ModelAuthoringBatch | undefined;
  assert.doesNotThrow(() => { parsed = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring',
    title: 'Detach reviewed occurrence', units, frame: 'storey-local', operations: [{ op: 'type.detach',
      target: { globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME },
      expected: { GlobalId: FRONT_WALL_TYPE, Name: FRONT_WALL_TYPE_NAME } }] })); },
  '#7267 native inspector detachment must also be admitted through reviewed authoring');
  assert.ok(parsed);
  return parsed;
}

test('#7267 existing native inspector detaches a selected occurrence and preserves the shared type and peer', async () => {
  const { dataStore, view, target, typeId, peer } = await sharedType();
  assert.equal(setElementType(SAMPLE_MODEL, target, null), true);
  const { parsed, relations } = await exportedRelations(dataStore, view);
  assert.equal(parsed.entities.getGlobalId(target), BACK_WALL);
  assert.equal(parsed.entities.getGlobalId(typeId), FRONT_WALL_TYPE);
  assert.ok(relations.some(rel => rel.relatingId === typeId && rel.relatedIds.includes(peer)));
  assert.equal(relations.some(rel => rel.relatedIds.includes(target)), false);
});

for (const units of ['m', 'mm'] as const) {
  test(`#7267 reviewed type detachment in ${units} preserves independent exported occurrence/type/peer identities`, async () => {
    const { dataStore, view, target, typeId, peer } = await sharedType();
    const state = useViewerStore.getState();
    const before = editedModelBytes(dataStore, view);
    const undo = state.undoStacks;
    const redo = state.redoStacks;
    const dirty = state.dirtyModels;
    const preview = previewModelAuthoring(state, reviewedDetach(units));
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue);
    assert.deepEqual(editedModelBytes(dataStore, view), before, 'preview has no published STEP effect');
    assert.equal(useViewerStore.getState().undoStacks, undo);
    assert.equal(useViewerStore.getState().redoStacks, redo);
    assert.equal(useViewerStore.getState().dirtyModels, dirty);
    const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
    assert.equal(outcome.receipt.applied[0].field, 'Type');
    assert.equal(outcome.receipt.applied[0].after, null);
    const { parsed, relations } = await exportedRelations(dataStore, view);
    assert.equal(parsed.entities.getGlobalId(target), BACK_WALL);
    assert.equal(parsed.entities.getName(target), BACK_WALL_NAME);
    assert.equal(parsed.entities.getGlobalId(typeId), FRONT_WALL_TYPE);
    assert.ok(relations.some(rel => rel.relatingId === typeId && rel.relatedIds.includes(peer)));
    assert.equal(relations.some(rel => rel.relatedIds.includes(target)), false);
  });
}
