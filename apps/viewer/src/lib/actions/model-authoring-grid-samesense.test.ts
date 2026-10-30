/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { StoreEditor } from '@ifc-lite/mutations';
import { addGridToStore, extractGridAxesForStorey, rectangularGridAxes, resolveSpatialAnchor } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, GROUND_STOREY } from '@/test/authoring-sample-fixture';
import { nativeGridExpected } from './model-authoring-grid-native';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));

// #8159: the extractor returns an axis's ends in authored order, and
// nativeGridExpected certifies them against a raw re-read. Both must use the
// same order, or a grid with a SameSense = .F. axis would be refused.
test('#8159 a native grid with a SameSense .F. axis still certifies, with the ends in authored order', async () => {
  const { dataStore, view } = await seedAuthoringSample();
  const storey = dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY);
  const editor = new StoreEditor(dataStore, view);
  const grid = addGridToStore(editor, resolveSpatialAnchor(dataStore, storey, view), {
    Position: [0, 0, 0],
    ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4], Overhang: 1 }),
  });
  const target = { modelId: SAMPLE_MODEL, dataStore, view, editor };
  const before = nativeGridExpected(target, grid.gridId, storey);
  assert.ok(before, 'a SameSense .T. grid certifies');
  const u1 = before.axes.find(axis => axis.AxisTag === '1')!;

  editor.setPositionalAttribute(grid.uAxisIds[0], 2, false);
  const extracted = extractGridAxesForStorey(dataStore, storey, view).axes.find(axis => axis.axisId === grid.uAxisIds[0])!;
  assert.deepEqual(extracted.a, u1.b, 'the extractor swapped the .F. axis');
  assert.deepEqual(extracted.b, u1.a);

  const after = nativeGridExpected(target, grid.gridId, storey);
  assert.ok(after, 'the .F. axis must not make the native grid uncertifiable');
  const swapped = after.axes.find(axis => axis.AxisTag === '1')!;
  assert.deepEqual(swapped.a, u1.b);
  assert.deepEqual(swapped.b, u1.a);
});
