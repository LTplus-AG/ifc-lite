/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The run refuses before any request when it cannot read what it would check:
 * a model without IFC data, or a georeference edited in the viewer (the check
 * reads the one the file states). The terrain adapter states swissALTI3D's
 * vertical reference and accuracy, without which the check sizes no margin.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { runViewerFloodCheck, swissAlti3dTerrain, SWISSALTI3D_VERTICAL_ACCURACY } from './flood-check-run';

const initial = useViewerStore.getState();
const realFetch = globalThis.fetch;
const requested: string[] = [];
afterEach(() => { useViewerStore.setState(initial, true); globalThis.fetch = realFetch; requested.length = 0; });
function recordFetch(): void {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    requested.push(String(input));
    throw new Error('no network in this test');
  };
}

test('a model without IFC data is refused, with no request sent', async () => {
  recordFetch();
  const model = { ...fixtureModel('scan'), ifcDataStore: null };
  useViewerStore.setState({ ...fixtureModels(model) });
  await runViewerFloodCheck({ modelId: 'scan' });
  const run = useViewerStore.getState().floodCheck;
  assert.equal(run?.status, 'error');
  assert.match(run?.error?.message ?? '', /IFC models only/);
  assert.deepEqual(requested, []);
});

test('a georeference edited in the viewer is refused, since the check would read the one in the file', async () => {
  recordFetch();
  useViewerStore.setState({ ...fixtureModels(fixtureModel('building')) });
  const edits = new Map(useViewerStore.getState().georefMutations);
  edits.set('building', {} as never);
  useViewerStore.setState({ georefMutations: edits });
  await runViewerFloodCheck({ modelId: 'building' });
  const run = useViewerStore.getState().floodCheck;
  assert.equal(run?.status, 'error');
  assert.match(run?.error?.message ?? '', /edited in the viewer/);
  assert.equal(run?.data, null, 'no result is kept from a refused run');
  assert.deepEqual(requested, []);
});

test('the terrain source states LN02 node grids and swissALTI3D accuracy', async () => {
  const grid = { verticalCrs: 'EPSG:5728', verticalReference: 'LN02', origin: { x: 0, y: 0 }, resolution: 0.5, width: 1, height: 1, values: new Float32Array([500]), noDataCount: 0, hasData: true, sources: [] };
  const terrain = swissAlti3dTerrain({ elevationGrid: async () => grid as never });
  assert.equal(terrain.verticalCrs, 'EPSG:5728');
  assert.equal(terrain.verticalAccuracy, SWISSALTI3D_VERTICAL_ACCURACY);
  const read = await terrain.grid!({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { resolution: 0.5 });
  assert.equal(read.sampling, 'node');
  assert.equal(read.values[0], 500);
});
