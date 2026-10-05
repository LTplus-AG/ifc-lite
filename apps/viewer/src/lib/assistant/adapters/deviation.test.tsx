/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DeviationDistances } from '@ifc-lite/renderer';
import { cleanup, click, render, waitFor } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import {
  countDeviationWithinTolerance, summarizeDeviationRun, type PointCloudDeviationStatistics,
} from '@/lib/point-cloud/deviation-run-statistics';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, useAssistant } from '../conversation';
import { architectureSample, idsOfType, sampleModel } from './coordination.test-support';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

interface Row { kind: string; modelId: string | null; globalId: string | null; expressId: number | null; unit: string;
  name: string | null; ifcClass: string | null; sampleCount: number; validCount: number; clippedCount: number;
  mean: number; rms: number; min: number; max: number; p95Abs: number; maxAbs: number;
  withinTolerance: { tolerance: number; count: number; share: number } | null; histogram?: unknown }
const rowsOf = (payload: string): Row[] => JSON.parse(payload).evidence.rows.map((row: { data: Row }) => row.data);
const summaryOf = (payload: string) => JSON.parse(payload).evidence.summary;

/** The stored record exactly as the Deviation panel derives it from a readback. */
async function storedRun(distances: DeviationDistances, tolerance = 0.01): Promise<PointCloudDeviationStatistics> {
  const summary = await summarizeDeviationRun(distances, { clipRange: 1 });
  const withinTolerance = await countDeviationWithinTolerance(distances, tolerance);
  return stampAnalysisReport({ revision: useViewerStore.getState().pointCloudDeviationRevision, clipRange: 1, ...summary, withinTolerance },
    captureAnalysisStamp(true));
}

function adopt(record: PointCloudDeviationStatistics): void {
  useViewerStore.getState().setPointCloudDeviationComputed(true);
  useViewerStore.getState().setPointCloudDeviationStatistics(record);
}

/** Asset A: 900 points |d| ≤ 9 mm, alternating sign. Asset B: 100 points at +50..149 mm. */
function twoAssets(a: { expressId: number; modelIndex: number }, b: { expressId: number; modelIndex: number }): DeviationDistances {
  const values = new Float32Array(1000);
  for (let k = 0; k < 900; k++) values[k] = (k % 2 ? -1 : 1) * (k % 10) / 1000;
  for (let k = 0; k < 100; k++) values[900 + k] = (50 + k) / 1000;
  return { values, assets: [{ ...a, offset: 0, count: 900 }, { ...b, offset: 900, count: 100 }] };
}

test('#6833 deviation: nothing computed, or computed but not yet read back, is unavailable', () => {
  let snapshot = captureEvidence('deviation');
  assert.equal(JSON.parse(snapshot.payload).sourceAvailability, 'unavailable');
  useViewerStore.getState().setPointCloudDeviationComputed(true);
  snapshot = captureEvidence('deviation');
  assert.equal(JSON.parse(snapshot.payload).sourceAvailability, 'unavailable');
  assert.equal(snapshot.totalRows, 0);
});

test('#6833 deviation: per-asset rows resolve the scan entity in its model; the pool is every point, not a row average', async () => {
  // A real parsed BIM model federated beside a scan model: the second asset is an element of the real file.
  const store = await architectureSample();
  const wall = idsOfType(store, 'IfcWall')[0];
  const scan = { ...fixtureModel('scan', { entities: [{ expressId: 7, type: 'IfcGeographicElement', name: 'Survey', globalId: '0SCAN000000000000000007' }] }), maxExpressId: 10 };
  const bim = sampleModel('bim', store, 1000);
  const models = new Map([['scan', scan], ['bim', bim]]);
  useViewerStore.setState({ models, activeModelId: 'bim' });
  const index = modelIndices(models);
  const distances = twoAssets({ expressId: 7, modelIndex: index.get('scan') ?? -1 }, { expressId: 1000 + wall, modelIndex: index.get('bim') ?? -1 });
  adopt(await storedRun(distances));

  const snapshot = captureEvidence('deviation');
  const [a, b] = rowsOf(snapshot.payload);
  const summary = summaryOf(snapshot.payload);
  assert.equal(snapshot.totalRows, 2);
  assert.equal(a.kind, 'scan-asset');
  assert.equal(a.unit, 'm');
  assert.equal(a.modelId, 'scan');
  assert.equal(a.globalId, '0SCAN000000000000000007');
  assert.equal(a.sampleCount, 900);
  assert.equal(a.maxAbs, Math.fround(0.009));
  assert.equal(a.withinTolerance?.count, 900);
  assert.equal(b.modelId, 'bim');
  assert.equal(b.expressId, wall);
  assert.equal(b.ifcClass, store.entities.getTypeName(wall));
  assert.equal(b.globalId, store.entities.getGlobalId(wall));
  assert.equal(b.withinTolerance?.count, 0);
  assert.equal('histogram' in a, false, 'no histogram arrays');
  // Pooled nearest-rank P95 over all 1000 points (rank 950 = the 50th point of B), not the mean of the rows.
  const sorted = Float32Array.from(distances.values, Math.abs).sort();
  assert.equal(summary.overall.p95Abs, sorted[949]);
  assert.notEqual(summary.overall.p95Abs, (a.p95Abs + b.p95Abs) / 2);
  assert.equal(summary.overall.sampleCount, 1000);
  assert.deepEqual(summary.withinTolerance, { tolerance: 0.01, count: 900, share: 0.9 });
  assert.equal(summary.units, 'm');
  assert.equal(summary.clipRange, 1);
  assert.equal(JSON.parse(snapshot.payload).reportProvenance.mutationVersion, useViewerStore.getState().mutationVersion);
});

test('#6833 deviation: native asset totals stay exact when rows are sampled', async () => {
  const values = new Float32Array(130 * 4).fill(0.002);
  const assets = Array.from({ length: 130 }, (_, i) => ({ expressId: i + 1, modelIndex: 99, offset: i * 4, count: 4 }));
  adopt(await storedRun({ values, assets }));
  const snapshot = captureEvidence('deviation');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 130);
  assert.equal(payload.evidence.summary.assetCount, 130);
  assert.equal(payload.evidence.summary.overall.sampleCount, 520);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
  // An index no live model owns stays unresolved rather than guessed.
  assert.equal(payload.evidence.rows[0].data.modelId, null);
  assert.equal(payload.evidence.rows[0].data.globalId, null);
});

test('#6833 deviation: a re-run, an invalidated run or a model removal drops the stored statistics', async () => {
  useViewerStore.setState({ models: new Map([['A', { ...fixtureModel('A'), maxExpressId: 10 }], ['B', { ...fixtureModel('B', { idOffset: 100 }), maxExpressId: 10 }]]), activeModelId: 'A' });
  const distances = twoAssets({ expressId: 1, modelIndex: 0 }, { expressId: 2, modelIndex: 0 });

  adopt(await storedRun(distances));
  let snapshot = captureEvidence('deviation');
  assert.equal(evidenceIsCurrent(snapshot), true);
  useViewerStore.getState().bumpPointCloudDeviationRevision();
  assert.equal(useViewerStore.getState().pointCloudDeviationStatistics, null, 'a COPC re-run replaces the distances');
  assert.equal(evidenceIsCurrent(snapshot), false);

  adopt(await storedRun(distances));
  useViewerStore.getState().setPointCloudDeviationComputed(false);
  assert.equal(useViewerStore.getState().pointCloudDeviationStatistics, null, 'placement or device loss invalidated the run');

  adopt(await storedRun(distances));
  snapshot = captureEvidence('deviation');
  useViewerStore.getState().removeModel('B');
  assert.equal(useViewerStore.getState().pointCloudDeviationStatistics, null, 'removal changed the meshes the run measured against');
  assert.equal(evidenceIsCurrent(snapshot), false);
  assert.equal(JSON.parse(captureEvidence('deviation').payload).sourceAvailability, 'unavailable');
});

test('#6833 deviation: statistics produced before an edit are stale even when captured after it', async () => {
  const record = await storedRun(twoAssets({ expressId: 1, modelIndex: 0 }, { expressId: 2, modelIndex: 0 }));
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  adopt(record);
  assert.equal(evidenceIsCurrent(captureEvidence('deviation')), false);

  adopt(await storedRun(twoAssets({ expressId: 1, modelIndex: 0 }, { expressId: 2, modelIndex: 0 })));
  const snapshot = captureEvidence('deviation');
  assert.equal(evidenceIsCurrent(snapshot), true);
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(snapshot), false);
});

test('#6833 deviation: the Point clouds panel header attaches this source', async () => {
  adopt(await storedRun(twoAssets({ expressId: 1, modelIndex: 0 }, { expressId: 2, modelIndex: 0 })));
  useViewerStore.setState({ pointCloudAssetCount: 2 });
  const ui = render(renderPanelBody('pointclouds', () => undefined));
  // The Point clouds panel is a lazy chunk (#6894): wait for it to mount.
  await waitFor(() => !!ui.querySelector('button[aria-label="Discuss with AI"]'), 'the Point clouds panel loaded');
  const button = ui.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button, 'Discuss with AI in the Point clouds header');
  click(button);
  assert.equal(useAssistant.getState().snapshot?.source, 'deviation');
  assert.equal(useAssistant.getState().snapshot?.totalRows, 2);
});
