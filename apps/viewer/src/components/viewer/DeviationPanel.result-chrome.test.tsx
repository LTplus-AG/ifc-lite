/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { LasStreamingSource } from '@ifc-lite/pointcloud';
import type { DeviationDistances, Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { removePointCloudScanCache } from '@/hooks/ingest/pointCloudScanCache';
import { unregisterPointCloudAlignment } from '@/hooks/ingest/pointCloudAlignment';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { loadScan, readbackIdentities, scanTestRenderer } from '@/test/scan-federation';
import { cleanup, click, render, type, waitFor } from '@/test/render';
import { DeviationPanel } from './DeviationPanel';

const handles: number[] = [];
afterEach(() => {
  cleanup(); setGlobalRendererRef({ current: null });
  for (const id of handles.splice(0)) { removePointCloudScanCache(id); unregisterPointCloudAlignment(id); }
  useViewerStore.getState().clearAllModels();
  useViewerStore.getState().setPointCloudDeviationComputed(false);
  useViewerStore.getState().setPointCloudColorMode('rgb');
  modelIndices(new Map());
});

/** Four actual streamed LAS points; the independent signed-distance population below also has four values. */
function las(): Blob {
  const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const view = new DataView(new ArrayBuffer(227 + points.length * 20));
  view.setUint32(0, 0x4653414c, true); view.setUint8(24, 1); view.setUint8(25, 2);
  view.setUint16(94, 227, true); view.setUint32(96, 227, true);
  view.setUint16(105, 20, true); view.setUint32(107, points.length, true);
  for (const at of [131, 139, 147]) view.setFloat64(at, 1, true);
  for (const at of [179, 195, 211]) view.setFloat64(at, 1, true);
  points.forEach((p, i) => p.forEach((v, axis) => view.setInt32(227 + i * 20 + axis * 4, v, true)));
  return new Blob([view.buffer]);
}

async function setup(values: readonly number[], scans = 1, withIfc = false, missingTable = false) {
  assert.equal(values.length, 4, 'stated signed-distance population matches each four-point LAS');
  if (withIfc) {
    const bytes = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
    const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
    const maxExpressId = getMaxExpressId(store, [], []);
    const idOffset = useViewerStore.getState().registerModelOffset('bim', maxExpressId);
    useViewerStore.getState().addModel({ ...fixtureModel('bim'), ifcDataStore: store,
      name: 'BIM reference.ifc', idOffset, maxExpressId });
  }
  const { renderer, points } = scanTestRenderer();
  for (let n = 0; n < scans; n++) {
    const { handle } = await loadScan(renderer, `survey-${n}`, { format: 'las', blob: las(),
      createSource: options => new LasStreamingSource(options.blob, { downsample: { stride: options.stride ?? 1 }, originOffset: options.originOffset }) });
    handles.push(handle.id);
  }
  assert.equal(points.getPointCount(), 4 * scans, 'real point-cloud renderer owns every streamed point');
  if (missingTable) {
    const model = useViewerStore.getState().models.get('survey-0'); assert.ok(model);
    useViewerStore.setState({ models: new Map([['survey-0', { ...model, ifcDataStore: null }]]) });
  }
  const distances: DeviationDistances = { values: Float32Array.from(Array.from({ length: scans }, () => values).flat()),
    assets: readbackIdentities(points).map((identity, n) => ({ ...identity, offset: n * 4, count: 4 })) };
  // GPU transport boundary only: analytic distance inputs feed the REAL sliced statistical algorithms.
  // These tests make no claim about GPU distance computation or a mock's numerical return value.
  setGlobalRendererRef({ current: {
    async computeDeviations() { return { bvhTriangles: 1, bvhNodes: 1, chunksProcessed: scans,
      pointsProcessed: points.getPointCount(), bounds: null, suggestedHalfRange: 0.05 }; },
    async readDeviationDistances() { return distances; },
  } as unknown as Renderer });
  const ui = render(<DeviationPanel triangleCount={1} />);
  const compute = ui.querySelector('button'); assert.ok(compute); click(compute);
  await waitFor(() => Boolean(useViewerStore.getState().pointCloudDeviationStatistics?.withinTolerance), 'native sliced summary/tolerance terminal adoption');
  const region = ui.querySelector('section[aria-label="BIM ↔ scan deviation results"]'); assert.ok(region, '#7197 native panel adopts shared result composition');
  return { ui, region, distances };
}

it('#7197 lone streamed scan source and analytic measured population render in shared result chrome', async () => {
  const run = await setup([0.001, -0.002, 0.003, -0.004]);
  assert.equal(useViewerStore.getState().models.size, 1);
  assert.match(run.region.textContent ?? '', /survey-0.las/);
  assert.match(run.region.textContent ?? '', /4 scan points read back/);
  assert.match(run.region.textContent ?? '', /4 \/ 4 readback points measured/);
  assert.ok(run.region.querySelector('[data-status="complete"]'));
  assert.match(run.region.querySelector('[data-stat="rms"] dd')?.textContent ?? '', /2.7 mm/, 'analytic RMS = sqrt(30/4)mm');
  const ref = useViewerStore.getState().resolveGlobalIdFromModels(run.distances.assets[0].expressId); assert.ok(ref);
  assert.match(run.region.textContent ?? '', new RegExp(`pointcloud-${ref.expressId}`));
  assert.match(run.region.textContent ?? '', /IfcGeographicElement/);
  assert.ok(run.region.querySelector('section[aria-label="Evidence details"]'));
});

it('#7197 federated scans name only actual readback models and preserve both native scan identities', async () => {
  const run = await setup([0.001, -0.002, 0.003, -0.004], 2, true);
  assert.equal(useViewerStore.getState().models.size, 3);
  assert.match(run.region.textContent ?? '', /survey-0.las/); assert.match(run.region.textContent ?? '', /survey-1.las/);
  assert.doesNotMatch(run.region.textContent ?? '', /BIM reference.ifc/, 'loaded IFC is not a scan readback source');
  assert.match(run.region.textContent ?? '', /8 scan points read back/);
  assert.match(run.region.textContent ?? '', /8 \/ 8 readback points measured/);
  for (const asset of run.distances.assets) {
    const ref = useViewerStore.getState().resolveGlobalIdFromModels(asset.expressId); assert.ok(ref);
    assert.match(run.region.textContent ?? '', new RegExp(`pointcloud-${ref.expressId}`));
  }
});

it('#7197 nonfinite distances remain explicit partial coverage of the actual native scan population', async () => {
  const run = await setup([NaN, Infinity, -Infinity, 0.004]);
  assert.match(run.region.textContent ?? '', /1 \/ 4 readback points measured/);
  assert.match(run.region.textContent ?? '', /3 readback points have no finite measured distance/);
  assert.ok(run.region.querySelector('[data-status="partial"]'));
  assert.equal(Boolean(run.region.querySelector('[data-result-state="no-findings"]')), false);
});

it('#7197 retained native scan buffers do not imply complete IFC identity when table data is unavailable', async () => {
  const run = await setup([0.001, -0.002, 0.003, -0.004], 1, false, true);
  assert.match(run.region.textContent ?? '', /4 \/ 4 readback points measured/);
  assert.match(run.region.textContent ?? '', /survey-0.las/);
  assert.match(run.region.textContent ?? '', /IFC identity of 1 scan asset could not be resolved/);
  assert.ok(run.region.querySelector('[data-status="partial"]'));
  assert.equal(Boolean(run.region.querySelector('[data-status="complete"]')), false);
  assert.doesNotMatch(run.region.textContent ?? '', /pointcloud-\d+/);
});

it('#7197 clipping preserves valid points while exposing native pegged-distance coverage', async () => {
  const run = await setup([0, 0.5, 1, -1]);
  assert.match(run.region.textContent ?? '', /4 \/ 4 readback points measured/);
  assert.match(run.region.textContent ?? '', /2 points reached the ±1 m compute limit/);
  assert.ok(run.region.querySelector('[data-status="partial"]'));
});

it('#7197 all unmeasured scan points are a partial readback rather than no findings or no population', async () => {
  const run = await setup([NaN, Infinity, -Infinity, NaN]);
  assert.match(run.region.textContent ?? '', /0 \/ 4 readback points measured/);
  assert.ok(run.region.querySelector('[data-result-state="partial"]'));
  assert.equal(Boolean(run.region.querySelector('[data-result-state="no-findings"]')), false);
  assert.equal(Boolean(run.region.querySelector('[data-result-state="no-population"]')), false);
});

it('#7197 retained statistics do not infer missing source provenance from today’s loaded models', async () => {
  const run = await setup([0.001, -0.002, 0.003, -0.004]);
  const actual = useViewerStore.getState().pointCloudDeviationStatistics; assert.ok(actual);
  // Stated provenance invariant: copied values alone do not record which source produced them.
  await act(async () => { useViewerStore.getState().setPointCloudDeviationStatistics({ ...actual }); });
  assert.match(run.region.textContent ?? '', /Outcome unknown/);
  assert.match(run.region.textContent ?? '', /scan source of this readback was not recorded/);
  assert.doesNotMatch(run.region.textContent ?? '', /survey-0.las/);
  assert.match(run.region.textContent ?? '', /4 \/ 4 readback points measured/);
});

it('#7197 captured scan source survives later model naming and native tolerance recounting', async () => {
  const run = await setup([0.001, -0.002, 0.003, -0.004]);
  const model = useViewerStore.getState().models.get('survey-0'); assert.ok(model);
  await act(async () => { useViewerStore.setState({ models: new Map([['survey-0', { ...model, name: 'Renamed after readback.las' }]]) }); });
  assert.match(run.region.textContent ?? '', /survey-0.las/);
  assert.doesNotMatch(run.region.textContent ?? '', /Renamed after readback.las/);
  const input = run.region.querySelector<HTMLInputElement>('input[type="number"]'); assert.ok(input);
  type(input, '2.5');
  await waitFor(() => useViewerStore.getState().pointCloudDeviationStatistics?.withinTolerance?.tolerance === 0.0025, 'native tolerance recount');
  assert.equal(useViewerStore.getState().pointCloudDeviationStatistics?.withinTolerance?.overall, 2, 'analytic band contains exactly the two smallest absolute distances');
  assert.match(run.region.textContent ?? '', /survey-0.las/);
  assert.doesNotMatch(run.region.textContent ?? '', /Renamed after readback.las/);
});

it('#7197 native panel remount retains the stored summary source without claiming held distance controls', async () => {
  await setup([0.001, -0.002, 0.003, -0.004]);
  cleanup();
  const ui = render(<DeviationPanel triangleCount={1} />);
  const region = ui.querySelector('section[aria-label="BIM ↔ scan deviation results"]'); assert.ok(region);
  assert.match(region.textContent ?? '', /survey-0.las/);
  assert.match(region.textContent ?? '', /4 \/ 4 readback points measured/);
  assert.match(region.querySelector('[data-stat="rms"] dd')?.textContent ?? '', /2.7 mm/);
  assert.ok(region.querySelector<HTMLInputElement>('input[type="number"]')?.disabled, 'no held readback means native tolerance recount stays unavailable');
  assert.equal(Boolean(region.querySelector('[data-testid="deviation-histogram"]')), false);
  assert.equal([...region.querySelectorAll('button')].some(button => button.textContent === 'Export CSV'), false);
});

it('#7197 native invalidation removes the prior run timing, population and source attribution', async () => {
  const run = await setup([0.001, -0.002, 0.003, -0.004]);
  assert.match(run.ui.textContent ?? '', /4 pts vs\. 1 tris in/);
  assert.match(run.ui.textContent ?? '', /survey-0.las/);
  await act(async () => {
    // Normal RGB mode does not request a fresh automatic deviation pass on invalidation.
    useViewerStore.getState().setPointCloudColorMode('rgb');
    useViewerStore.getState().setPointCloudDeviationComputed(false);
  });
  assert.equal(useViewerStore.getState().pointCloudDeviationStatistics, null);
  assert.doesNotMatch(run.ui.textContent ?? '', /4 pts vs\. 1 tris in/, 'native invalidation cannot retain the old timing/population claim');
  assert.equal(run.ui.querySelector('section[aria-label="BIM ↔ scan deviation results"]'), null);
  assert.doesNotMatch(run.ui.textContent ?? '', /survey-0.las/);
});
