/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { rectangularGridAxes } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { captureSelectionGrounding } from './selection-grounding';
import { captureEvidence } from '@/lib/assistant/evidence';
import { parseModelAuthoringBatch } from './model-authoring';
import { resolveGlobalId } from './resolve-global-id';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));
const params = { Position: [0, 0, 0] as [number, number, number], Direction: 0,
  ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4] }), Name: 'Native oracle grid' };
async function selectedGrid() {
  const { dataStore, view } = await seedAuthoringSample();
  const storey = resolveGlobalId(useViewerStore.getState(), { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }); assert.ok(typeof storey === 'object');
  const grid = addGridIn(useViewerStore, SAMPLE_MODEL, storey.expressId, params); assert.ok('expressId' in grid);
  useViewerStore.setState({ selectedEntityId: grid.expressId, selectedEntityIds: new Set([grid.expressId]), selectedEntity: { modelId: SAMPLE_MODEL, expressId: grid.expressId } });
  return { dataStore, view, grid };
}
test('#7304 full-class oracle native inspector/export control remains authoritative without reviewed presentation', async () => {
  const { dataStore, view, grid } = await selectedGrid();
  const saved = await parseIfc(editedModelBytes(dataStore, view));
  assert.equal(saved.entities.getTypeName(grid.expressId), 'IfcGrid');
});
test('#7304 full-class oracle admits both explicit reviewed native creation routes', () => {
  assert.doesNotThrow(() => parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Grid oracle', units: 'm', frame: 'storey-local', operations: [
    { op: 'grid.create', ref: 'g', storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }, params },
    { op: 'column.createOnGrid', ref: 'c', storey: { globalId: GROUND_STOREY, modelId: SAMPLE_MODEL }, grid: { ref: 'g', IntersectingAxes: ['2', 'B'] }, params: { Position: [6, 4, 0], Width: .4, Depth: .2, Height: 3 } },
  ] })));
});
for (const source of ['attachment', 'rich'] as const) test(`#7304 full-class oracle ${source} publishes native complete axis evidence`, async () => {
  const { grid } = await selectedGrid();
  const row = source === 'attachment' ? captureSelectionGrounding(useViewerStore.getState()).elements[0] : JSON.parse(captureEvidence('selection').payload).evidence.rows[0].data;
  assert.ok(row.nativeGrid?.expected, 'the provider receives an authoritative complete native grid snapshot');
  assert.deepEqual(row.nativeGrid.expected.axes.map((axis: { expressId: number }) => axis.expressId), [...grid.build.uAxisIds, ...grid.build.vAxisIds]);
});
