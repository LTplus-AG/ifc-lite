/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { rectangularGridAxes } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { addGridColumnIn } from '@/store/slices/mutation-grid-column';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { refId } from '../../../../../packages/create/src/in-store/host-geometry-frame.js';
import { AnchorEntityReader } from '../../../../../packages/create/src/in-store/resolve-anchor.js';
import { parseModelAuthoringBatch } from './model-authoring';
import { resolveGlobalId } from './resolve-global-id';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial));
const params = { Position: [0, 0, 0] as [number, number, number], Direction: 0,
  ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }), Name: 'Native source design grid' };
const batch = (operations: unknown[]) => JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Native grid review', units: 'm', frame: 'storey-local', operations });

async function nativeGrid() {
  const { dataStore, view } = await seedAuthoringSample();
  const storey = resolveGlobalId(useViewerStore.getState(), { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL });
  assert.ok(typeof storey === 'object');
  const made = addGridIn(useViewerStore, SAMPLE_MODEL, storey.expressId, params);
  assert.ok('expressId' in made, 'existing native grid builder is applicable to the actual SketchUp IFC storey');
  return { dataStore, view, storey, made };
}

test('P15A audit native grid and bound column preserve actual IFC relationships through export/reparse and Undo/Redo', async () => {
  const { dataStore, view, storey, made } = await nativeGrid();
  const first = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0; assert.ok(first > 0);
  const gridTags = new Set((useViewerStore.getState().undoStacks.get(SAMPLE_MODEL) ?? []).map(row => useViewerStore.getState().mutationBatchTags.get(row.id)));
  assert.equal(gridTags.size, 1, 'complete native grid mutation history shares one undo batch');
  const column = addGridColumnIn(useViewerStore, SAMPLE_MODEL, storey.expressId, {
    Position: [6, 4, 0], Width: .4, Depth: .2, Height: 3, Name: 'Actual grid-bound column',
  }, { GridId: made.expressId, IntersectingAxes: [made.build.uAxisIds[1], made.build.vAxisIds[1]] });
  assert.ok('expressId' in column, 'existing native binding validates the actual current crossing');
  assert.ok((useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0) > first);
  const columnTags = new Set((useViewerStore.getState().undoStacks.get(SAMPLE_MODEL) ?? []).slice(first).map(row => useViewerStore.getState().mutationBatchTags.get(row.id)));
  assert.equal(columnTags.size, 1);
  assert.notEqual([...columnTags][0], [...gridTags][0]);
  const bytes = editedModelBytes(dataStore, view);
  const text = new TextDecoder().decode(bytes); assert.deepEqual(danglingReferences(text), []);
  const parsed = await parseIfc(bytes);
  const reader = new AnchorEntityReader(parsed, null);
  const grid = reader.entity(made.expressId); assert.equal(grid?.type.toUpperCase(), 'IFCGRID');
  assert.deepEqual(grid?.attributes[7], made.build.uAxisIds);
  assert.deepEqual(grid?.attributes[8], made.build.vAxisIds);
  const savedColumn = reader.entity(column.expressId); assert.equal(savedColumn?.type.toUpperCase(), 'IFCCOLUMN');
  const localId = refId(savedColumn?.attributes[5]); assert.ok(localId !== null);
  const local = reader.entity(localId); assert.equal(local?.type.toUpperCase(), 'IFCLOCALPLACEMENT');
  const placementId = refId(local?.attributes[0]); assert.ok(placementId !== null);
  const gridPlacement = reader.entity(placementId); assert.equal(gridPlacement?.type.toUpperCase(), 'IFCGRIDPLACEMENT');
  const crossingId = refId(gridPlacement?.attributes[0]); assert.ok(crossingId !== null);
  const intersection = reader.entity(crossingId); assert.equal(intersection?.type.toUpperCase(), 'IFCVIRTUALGRIDINTERSECTION');
  assert.deepEqual(intersection?.attributes[0], [made.build.uAxisIds[1], made.build.vAxisIds[1]]);
  useViewerStore.getState().undo(SAMPLE_MODEL);
  assert.equal(view.getNewEntity(column.expressId), null, 'native one-step Undo removes the complete new column edit');
  assert.ok(view.getNewEntity(made.expressId), 'earlier native grid edit remains');
  useViewerStore.getState().redo(SAMPLE_MODEL);
  assert.ok(view.getNewEntity(column.expressId), 'native Redo retains the original bound entity identity');
});

test('P15A audit actual native grid requires missing reviewed admission', async () => {
  const { made } = await nativeGrid();
  assert.ok(made.build.uAxisIds.length === 2 && made.build.vAxisIds.length === 2);
  assert.doesNotThrow(() => parseModelAuthoringBatch(batch([{ op: 'grid.create', ref: 'grid-one', storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }, params }])),
    'the native applicable grid has no standard reviewed authoring admission');
});
