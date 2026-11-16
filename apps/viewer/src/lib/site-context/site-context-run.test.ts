/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10481 review: a site-context run's state must not outlive the run. A run
 * that was cancelled (or replaced) must not write into a newer run's state
 * or leave a model behind, and the request record is cleared whichever way
 * the run ends, so a later GLB drop is never judged against it.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { SiteContextDocument } from '@ifc-lite/site-context';
import { useViewerStore } from '@/store';
import { viewerTeardownRegistry } from '@/store/teardown-registry';
import { siteRadiusFor } from '@/hooks/ingest/siteContextLoad';
import { __setSiteContextWorkerFactoryForTest, type SiteContextWorkerLike } from './site-context-client';
import type { SiteContextWorkerRequest, SiteContextWorkerResponse } from './site-context-job';
import { loadSiteContext, type SiteContextAddModel } from './site-context-fetch';
import { fixtureModel } from '@/test/store-fixture';
import { siteContextViewerModel } from './site-context-model';
import { arriveInScene, expectSceneMatchesCategories } from '@/test/site-context-scene';

const initial = useViewerStore.getState();
const swisstopo = { datasetId: 'swissalti3d', text: '© swisstopo', licence: 'OGD', termsUrl: 'https://example.invalid', restrictions: [], termsVerifiedOn: '2026-11-15' };

class FakeWorker implements SiteContextWorkerLike {
  onmessage: ((event: MessageEvent<SiteContextWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  id = 0;
  terminated = false;
  postMessage(message: SiteContextWorkerRequest): void { this.id = message.id; }
  terminate(): void { this.terminated = true; }
  send(message: Omit<SiteContextWorkerResponse, 'id'>): void {
    this.onmessage?.({ data: { ...message, id: this.id } as SiteContextWorkerResponse } as MessageEvent<SiteContextWorkerResponse>);
  }
  category(kind: 'terrain' | 'parcel'): void {
    this.send({ type: 'category', kind, bytes: new Uint8Array([1]), hasGeometry: true, complete: true, attribution: [swisstopo], issues: [] } as Omit<SiteContextWorkerResponse, 'id'>);
  }
  complete(): void { this.send({ type: 'complete', stats: { requests: 1, bytes: 1, cacheHits: 0 } } as Omit<SiteContextWorkerResponse, 'id'>); }
  fail(): void { this.send({ type: 'error', message: 'network down', stats: { requests: 1, bytes: 0, cacheHits: 0 } } as Omit<SiteContextWorkerResponse, 'id'>); }
}

let workers: FakeWorker[];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = () => useViewerStore.getState();
const removed: string[] = [];
const added: string[] = [];
const kindOf = (name: string) => (name.endsWith('Terrain') ? 'terrain' : name.endsWith('Parcel') ? 'parcel' : 'buildings') as 'terrain' | 'parcel' | 'buildings';
/** Stands in for useIfc().addModel → the shared loader: the model enters the scene through the one arrival step. */
const addModel: SiteContextAddModel = async (_file, { name, siteContextArrival }) => {
  added.push(name);
  const id = `model:${name}:${added.length}`;
  arriveInScene(id, kindOf(name), siteContextArrival);
  return id;
};
const base = { anchorModelId: 'anchor', centre: { x: 2_600_000, y: 1_200_000 }, radius: 100 as const, imagery: false, addModel, removeModel: (id: string) => { removed.push(id); } };

beforeEach(() => {
  workers = [];
  removed.length = 0;
  added.length = 0;
  __setSiteContextWorkerFactoryForTest(() => { const w = new FakeWorker(); workers.push(w); return w; });
});
afterEach(() => {
  __setSiteContextWorkerFactoryForTest(null);
  useViewerStore.setState(initial, true);
});

test('a run cancelled while its model is being added does not touch the run started after it, and leaves no model behind', async () => {
  let release!: (id: string) => void;
  const slowAdd: SiteContextAddModel = () => new Promise((resolve) => { release = resolve; });
  const first = loadSiteContext({ ...base, categories: ['terrain'], addModel: slowAdd });
  workers[0].category('terrain');
  await tick();
  state().abortSiteContextRequest(); // the user cancels while addModel is in flight
  const second = loadSiteContext({ ...base, radius: 200, categories: ['terrain'] });
  const secondAbort = state().siteContextAbort;
  release('model:stale-terrain'); // the first run's addModel finishes now
  await first;
  expectSceneMatchesCategories();
  assert.equal(state().siteContextAbort, secondAbort, 'the second run is still the current one');
  assert.equal(secondAbort?.signal.aborted, false, 'the second run was not aborted');
  assert.equal(workers[1].terminated, false, 'the second run\'s worker keeps running');
  assert.equal(state().siteContextCategories.terrain?.status, 'fetching', 'the second run\'s category is untouched');
  assert.equal(state().siteContextRequest?.radius, 200);
  assert.deepEqual(removed, ['model:stale-terrain'], 'the cancelled run\'s late model is removed again');
  workers[1].category('terrain');
  workers[1].complete();
  await second;
  expectSceneMatchesCategories();
  assert.equal(state().siteContextCategories.terrain?.status, 'done');
});

test('success clears the request record, and a GLB dropped afterwards is not judged against it', async () => {
  const run = loadSiteContext({ ...base, categories: ['terrain'] });
  assert.equal(state().siteContextRequest?.radius, 100, 'the running request is recorded');
  workers[0].category('terrain');
  workers[0].complete();
  await run;
  expectSceneMatchesCategories();
  assert.equal(state().siteContextRequest, null);
  // A parcel-only document (as a CLI GLB's parcel sibling is): without a request it falls back to the default.
  const parcelOnly: SiteContextDocument = { crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', origin: [0, 0, 0], layers: [{ kind: 'parcel', features: [], attribution: [], issues: [], complete: true }] };
  assert.equal(siteRadiusFor(parcelOnly), 300);
  assert.deepEqual(state().siteContextLastChoice, { radius: 100, categories: ['terrain'], imagery: false }, 'the panel still remembers the last choice');
});

test('an error clears the request record', async () => {
  const run = loadSiteContext({ ...base, categories: ['terrain'] });
  workers[0].fail();
  await run;
  expectSceneMatchesCategories();
  assert.equal(state().siteContextRequest, null);
  assert.equal(state().siteContextAbort, null);
});

test('a cancel clears the request record', async () => {
  const run = loadSiteContext({ ...base, categories: ['terrain'] });
  state().abortSiteContextRequest();
  await run;
  expectSceneMatchesCategories();
  assert.equal(state().siteContextRequest, null);
});

test('removing the anchor model ends the run: request cleared, and the detached run adds nothing', async () => {
  const run = loadSiteContext({ ...base, categories: ['terrain'] });
  const entry = viewerTeardownRegistry.find((e) => e.slice === 'siteContextSlice')!;
  const runAbort = state().siteContextAbort!;
  useViewerStore.setState(entry.teardown({ kind: 'model-removed', modelId: 'anchor', isStale: () => false, nextActiveModelId: null }, state()));
  assert.equal(runAbort.signal.aborted, true, 'the detached run aborts itself');
  assert.equal(workers[0].terminated, true, 'and its worker stops');
  assert.equal(state().siteContextRequest, null);
  assert.equal(state().siteContextAbort, null);
  assert.equal(state().siteContextCategories.terrain?.status, 'idle');
  workers[0].category('terrain');
  workers[0].complete();
  await run;
  expectSceneMatchesCategories();
  assert.deepEqual(added, [], 'a run that is no longer current loads no model');
  assert.equal(state().siteContextCategories.terrain?.status, 'idle');
});

test('clearing all models ends the run: request cleared, and the detached run adds nothing', async () => {
  const run = loadSiteContext({ ...base, categories: ['terrain'] });
  const entry = viewerTeardownRegistry.find((e) => e.slice === 'siteContextSlice')!;
  const runAbort = state().siteContextAbort!;
  useViewerStore.setState(entry.teardown({ kind: 'all-models-cleared' }, state()));
  assert.equal(runAbort.signal.aborted, true, 'the detached run aborts itself');
  assert.equal(workers[0].terminated, true, 'and its worker stops');
  assert.equal(state().siteContextRequest, null);
  workers[0].category('terrain');
  workers[0].complete();
  await run;
  expectSceneMatchesCategories();
  assert.deepEqual(added, []);
});

const previousTerrain = { kind: 'terrain' as const, attribution: [], issues: [], complete: true, origin: [0, 0, 0] as [number, number, number] };

function seedPreviousTerrain() {
  const payload = siteContextViewerModel({ crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', origin: [2600000, 1200000, 500] }, {
    ...previousTerrain, features: [{ id: 'tile', name: 'Previous terrain tile', ifcType: 'IfcGeographicElement', attributes: {}, provenance: { dataset: 'test-terrain' }, origin: [2600000, 1200000, 500],
      mesh: { positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) } }],
  }, new ArrayBuffer(8), 0);
  const model = { ...fixtureModel('old-terrain'), ifcDataStore: payload.dataStore, geometryResult: payload.geometryResult, spatialReference: payload.spatialReference };
  useViewerStore.setState({ models: new Map([['old-terrain', model]]) });
  state().registerSiteContextModel('old-terrain', previousTerrain);
  state().recordArrivedSiteContextCategory('terrain', { status: 'done', modelId: 'old-terrain' });
  return model;
}

test('when the replacement fails to load, the previous model stays and the category reports the error next to it', async () => {
  const previous = seedPreviousTerrain();
  const run = loadSiteContext({ ...base, categories: ['terrain'], addModel: async () => null });
  workers[0].category('terrain');
  workers[0].complete();
  await run;
  expectSceneMatchesCategories();
  assert.deepEqual(removed, [], 'the previous terrain is not removed');
  assert.equal(state().models.get('old-terrain'), previous, 'the same scene payload is retained');
  assert.equal(state().models.get('old-terrain')?.geometryResult, previous.geometryResult);
  assert.equal(previous.ifcDataStore.getEntitiesByType('IfcGeographicElement').length, 1);
  assert.equal(previous.geometryResult.meshes[0].positions.length, 9);
  const terrain = state().siteContextCategories.terrain;
  assert.equal(terrain?.status, 'error');
  assert.equal(terrain?.modelId, 'old-terrain');
  assert.match(terrain?.issues.at(-1)?.message ?? '', /previous one is still shown/);
});

test('an addModel that throws fails its category, the next categories still load, and the run settles (#10481 review)', async () => {
  let calls = 0;
  const run = loadSiteContext({
    ...base, categories: ['terrain', 'parcel'],
    addModel: async (file, options) => { calls++; if (calls === 1) throw new Error('GPU device lost'); return addModel(file, options); },
  });
  workers[0].category('terrain');
  workers[0].category('parcel');
  workers[0].complete();
  await run;
  expectSceneMatchesCategories();
  assert.equal(state().siteContextAbort, null, 'the run settled');
  assert.equal(state().siteContextRequest, null);
  const terrain = state().siteContextCategories.terrain;
  assert.equal(terrain?.status, 'error');
  assert.match(terrain?.issues.at(-1)?.message ?? '', /GPU device lost/);
  assert.equal(state().siteContextCategories.parcel?.status, 'done', 'the next category still loaded');
});


test('superseding pending terrain with parcel settles only the old fetching state and retains real terrain (#10481)', async () => {
  const previous = seedPreviousTerrain();
  const first = loadSiteContext({ ...base, categories: ['terrain'] });
  const oldRun = state().siteContextAbort!;
  assert.equal(state().siteContextCategories.terrain?.status, 'fetching');
  const second = loadSiteContext({ ...base, categories: ['parcel'] });
  assert.equal(oldRun.signal.aborted, true);
  assert.equal(state().siteContextCategories.terrain?.status, 'idle');
  assert.equal(state().siteContextCategories.terrain?.modelId, previous.id);
  assert.equal(state().models.get(previous.id), previous);
  workers[0].fail();
  state().setSiteContextCategory(oldRun, 'terrain', { status: 'error' });
  state().finishSiteContextRequest(oldRun, null, 'stale failure');
  workers[1].category('parcel');
  workers[1].complete();
  await Promise.all([first, second]);
  expectSceneMatchesCategories();
  assert.equal(state().siteContextCategories.terrain?.status, 'idle');
  assert.equal(state().models.get(previous.id), previous);
  assert.equal(state().siteContextCategories.parcel?.status, 'done');
});
