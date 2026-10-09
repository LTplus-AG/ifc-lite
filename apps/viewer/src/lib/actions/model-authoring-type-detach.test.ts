/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';
import { existsSync, readFileSync } from 'node:fs';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
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

function requiredTypeId(relation: { relatingId?: number }): number {
  const id = relation.relatingId;
  assert.ok(typeof id === 'number' && id > 0, 'native type relationship has an explicit positive relating EXPRESS ID');
  return id;
}

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
    const before = await parseIfc(editedModelBytes(dataStore, view));
    const entityGraph = (store: typeof before) => [...store.entityIndex.byId.keys()].sort((a, b) => a - b).map(id => [id, store.getEntity(id)]);
    const beforeGraph = entityGraph(before);
    const undo = state.undoStacks;
    const redo = state.redoStacks;
    const dirty = state.dirtyModels;
    const preview = previewModelAuthoring(state, reviewedDetach(units));
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native type review status');
    const afterPreview = await parseIfc(editedModelBytes(dataStore, view));
    assert.deepEqual(entityGraph(afterPreview), beforeGraph, 'preview preserves the entire independently parsed native entity graph; export HEADER timestamps are outside this contract');
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
    assert.equal(outcome.receipt.batches.length, 1, 'one native grouped edit');
    useViewerStore.getState().undo(SAMPLE_MODEL);
    const restored = await exportedRelations(dataStore, view);
    assert.ok(restored.relations.some(rel => rel.relatingId === typeId && rel.relatedIds.includes(target) && rel.relatedIds.includes(peer)));
    useViewerStore.getState().redo(SAMPLE_MODEL);
    const redone = await exportedRelations(dataStore, view);
    assert.equal(redone.relations.some(rel => rel.relatedIds.includes(target)), false);
    assert.ok(redone.relations.some(rel => rel.relatingId === typeId && rel.relatedIds.includes(peer)));
  });
}

test('#7267 detaching the last native occurrence removes only its relationship, and Undo restores it', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const target = dataStore.entities.getExpressIdByGlobalId(BACK_WALL)!;
  const relation = readRelatedLists(dataStore, 'IfcRelDefinesByType', view).find(rel => rel.relatedIds.includes(target))!;
  assert.deepEqual(relation.relatedIds, [target], 'committed native fixture has a single-occurrence type relationship');
  const current = dataStore.entities.getGlobalId(requiredTypeId(relation));
  const expectedName = dataStore.entities.getName(requiredTypeId(relation)) ?? '';
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Last typed occurrence',
    units: 'm', frame: 'storey-local', operations: [{ op: 'type.detach', target: { globalId: BACK_WALL,
      ifcClass: 'IfcWall', name: BACK_WALL_NAME }, expected: { GlobalId: current, Name: expectedName } }] }));
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native type review status');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  const after = await exportedRelations(dataStore, view);
  assert.equal(after.parsed.entities.getGlobalId(requiredTypeId(relation)), current, 'detaching does not delete the type object');
  assert.equal(after.relations.some(rel => rel.relId === relation.relId), false);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  const restored = await exportedRelations(dataStore, view);
  assert.ok(restored.relations.some(rel => rel.relId === relation.relId && rel.relatedIds.includes(target)));
});

test('#7267 exact type expectation, source revisions and edit permissions refuse stale detachment without publishing', async () => {
  const { dataStore, view, target } = await sharedType();
  const batch = reviewedDetach('m');
  const expected = parseModelAuthoringBatch(JSON.stringify({ ...batch, operations: batch.operations.map(op => ({ ...op,
    expected: { GlobalId: FRONT_WALL_TYPE, Name: 'Different same-id type name' } })) }));
  assert.equal(previewModelAuthoring(useViewerStore.getState(), expected).rows[0].status, 'conflict');
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready');
  const editor = useViewerStore.getState().storeEditors.get(SAMPLE_MODEL)!;
  editor.setPositionalAttribute(target, 4, 'Changed without history');
  const before = editedModelBytes(dataStore, view);
  const refused = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.equal(refused.ok, false, 'even a history-free native source edit revokes approval');
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, view), before);
  useViewerStore.setState({ editEnabled: false });
  assert.equal(previewModelAuthoring(useViewerStore.getState(), batch).rows[0].status, 'denied');
});

test('#7267 first-read native detachment preview preserves the live allocator lease and editor registry', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const target = dataStore.entities.getExpressIdByGlobalId(BACK_WALL)!;
  const relation = readRelatedLists(dataStore, 'IfcRelDefinesByType', view).find(rel => rel.relatedIds.includes(target))!;
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Pure first read',
    units: 'm', frame: 'storey-local', operations: [{ op: 'type.detach', target: { globalId: BACK_WALL,
      ifcClass: 'IfcWall', name: BACK_WALL_NAME }, expected: { GlobalId: dataStore.entities.getGlobalId(requiredTypeId(relation)),
        Name: dataStore.entities.getName(requiredTypeId(relation)) ?? '' } }] }));
  const editors = useViewerStore.getState().storeEditors;
  const views = useViewerStore.getState().mutationViews;
  const lease = view.prepareAtomic(() => null);
  const preview = previewModelAuthoring(useViewerStore.getState(), batch);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native type review status');
  assert.equal(useViewerStore.getState().storeEditors, editors);
  assert.equal(editors.size, 0);
  assert.equal(useViewerStore.getState().mutationViews, views);
  assert.doesNotThrow(() => lease.validate(), 'a read-only preview must not alter the live allocator watermark');
});

test('#7267 federation requires an explicit model for repeated IFC GlobalIds and edits only the selected owner', async () => {
  const { dataStore, view, target, typeId, peer } = await sharedType();
  const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
  useViewerStore.getState().addModel({ ...model, id: 'other', name: 'Other source with repeated GlobalIds', idOffset: 2_000_000 });
  const other = new MutablePropertyView(dataStore.properties ?? null, 'other');
  useViewerStore.getState().registerMutationView('other', other);
  const unqualified = reviewedDetach('m');
  assert.equal(previewModelAuthoring(useViewerStore.getState(), unqualified).rows[0].status, 'ambiguous-target');
  const pinned = parseModelAuthoringBatch(JSON.stringify({ ...unqualified, operations: unqualified.operations.map(op => ({ ...op,
    target: { globalId: BACK_WALL, ifcClass: 'IfcWall', name: BACK_WALL_NAME, modelId: SAMPLE_MODEL } })) }));
  const otherBytes = editedModelBytes(dataStore, other);
  const preview = previewModelAuthoring(useViewerStore.getState(), pinned);
  assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native type review status');
  const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'test');
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
  assert.equal(outcome.receipt.applied[0].modelId, SAMPLE_MODEL);
  const after = await exportedRelations(dataStore, view);
  assert.equal(after.relations.some(rel => rel.relatedIds.includes(target)), false);
  assert.ok(after.relations.some(rel => rel.relatingId === typeId && rel.relatedIds.includes(peer)));
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, other), otherBytes, 'the independently owned overlay remains unchanged');
});


const wasm = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
test('#7267 actual WASM processes the independently exported detached occurrence and Undo restores its meshes',
  { skip: !existsSync(wasm) && 'run pnpm build:wasm:fetch' }, async () => {
    const { dataStore, view, target } = await sharedType();
    initSync({ module: readFileSync(wasm) });
    const geometry = (bytes: Uint8Array) => {
      const api = new IfcAPI();
      const meshes: Array<{ positions: number[]; indices: number[] }> = [];
      try {
        const pre = api.buildPrePassOnce(bytes);
        const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
        const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
          pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
        try {
          for (let i = 0; i < collection.length; i++) {
            const mesh = collection.get(i);
            if (!mesh) continue;
            try { if (mesh.expressId === target) meshes.push({ positions: Array.from(mesh.positions), indices: Array.from(mesh.indices) }); }
            finally { mesh.free(); }
          }
        } finally { collection.free(); }
      } finally { api.clearPrePassCache(); api.free(); }
      return meshes;
    };
    const before = geometry(editedModelBytes(dataStore, view));
    assert.ok(before.length > 0 && before.every(mesh => mesh.indices.length > 0), 'real imported source has native geometry');
    const preview = previewModelAuthoring(useViewerStore.getState(), reviewedDetach('m'));
    assert.equal(preview.rows[0].status, 'ready', preview.rows[0].issue ?? 'native type review status');
    assert.ok(preview.rows[0].previewUnavailable, 'review explicitly withholds a resulting type-detach geometry preview');
    const outcome = commitModelAuthoring(useViewerStore, preview, new Set([0]), 'native WASM detachment');
    assert.ok(outcome.ok, outcome.ok ? '' : outcome.detail ?? outcome.reason);
    const after = geometry(editedModelBytes(dataStore, view));
    assert.ok(after.length > 0 && after.every(mesh => mesh.positions.every(Number.isFinite) && mesh.indices.length > 0),
      'actual detached export still processes through the canonical native geometry pipeline');
    useViewerStore.getState().undo(SAMPLE_MODEL);
    assert.deepEqual(geometry(editedModelBytes(dataStore, view)), before, 'Undo restores actual target mesh output');
  });
