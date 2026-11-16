/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10481 review: one site context per scene holds on every path. A
 * site-context model of kind K that arrives (from the panel's fetch or from a
 * dropped GLB) replaces the loaded model of kind K, new model first; a failed
 * arrival keeps the old one. Driven through the real shared loader
 * (`loadSiteContextModel`) with real GLB bytes; `finalize` registers the
 * model in the store as the federation does.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { NOOP_LOAD_TRACE } from '@ifc-lite/load-trace';
import { encodeSiteContextGlb, type SiteContextDocument } from '@ifc-lite/site-context';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { __setSiteContextWorkerFactoryForTest, type SiteContextWorkerLike } from '@/lib/site-context/site-context-client';
import type { SiteContextWorkerRequest, SiteContextWorkerResponse } from '@/lib/site-context/site-context-job';
import { loadSiteContext } from '@/lib/site-context/site-context-fetch';
import type { ModelLoadOptions } from '../modelLoadOptions.js';
import { loadSiteContextModel } from './siteContextLoad';
import { expectSceneMatchesCategories } from '@/test/site-context-scene';

const initial = useViewerStore.getState();

function terrainGlb(kind: 'terrain' | 'parcel' = 'terrain'): Uint8Array {
  const doc: SiteContextDocument = {
    crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', origin: [2_600_000, 1_200_000, 500],
    layers: [{
      kind,
      features: [{
        id: `${kind}:r0c0`, ifcType: kind === 'parcel' ? 'IfcSite' : 'IfcGeographicElement', name: `${kind} r0c0`, origin: [2_600_000, 1_200_000, 500],
        mesh: { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) },
        attributes: { PredefinedType: 'TERRAIN' }, provenance: {},
      }],
      attribution: [], issues: [], complete: true,
    }],
  };
  return encodeSiteContextGlb(doc);
}

/** What `useIfc().addModel` → `loadFile` → the site-context branch does, with `finalize` registering the model. */
async function load(modelId: string, bytes: Uint8Array, options: Pick<ModelLoadOptions, 'siteContextArrival'> & { failFinalize?: boolean } = {}): Promise<string | null> {
  let registered = false;
  const errors: string[] = [];
  await loadSiteContextModel({
    buffer: bytes.slice().buffer, modelId, fileName: 'context.glb', fileSizeMB: 0, targetKind: 'federated', totalStartTime: 0, wasHidden: false,
    trace: NOOP_LOAD_TRACE, isStale: () => false, setProgress: () => {}, settleLoadUi: () => {}, onPrimary: () => {},
    finalize: async (dataStore, geometryResult) => {
      if (options.failFinalize) throw new Error('GPU upload failed');
      const model = { ...fixtureModel(modelId), name: 'context.glb', ifcDataStore: dataStore, geometryResult, loadedAt: Date.now() } as unknown as FederatedModel;
      useViewerStore.setState((s) => ({ models: new Map([...s.models, [modelId, model]]) }));
      registered = true;
    },
    loadSibling: () => {}, onError: (_code, message) => { errors.push(message); },
    ...(options.siteContextArrival ? { arrival: options.siteContextArrival } : {}),
  });
  expectSceneMatchesCategories();
  return registered && errors.length === 0 ? modelId : null;
}

const terrains = () => [...useViewerStore.getState().siteContextModels].filter(([, r]) => r.kind === 'terrain').map(([id]) => id);
const inScene = () => [...useViewerStore.getState().models.keys()];
const category = () => useViewerStore.getState().siteContextCategories.terrain;

/** A worker the test drives, sending one real terrain GLB. */
class FakeWorker implements SiteContextWorkerLike {
  onmessage: ((event: MessageEvent<SiteContextWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  id = 0;
  postMessage(message: SiteContextWorkerRequest): void { this.id = message.id; }
  terminate(): void {}
  send(message: Omit<SiteContextWorkerResponse, 'id'>): void {
    this.onmessage?.({ data: { ...message, id: this.id } as SiteContextWorkerResponse } as MessageEvent<SiteContextWorkerResponse>);
  }
}
let worker: FakeWorker;
beforeEach(() => { worker = new FakeWorker(); __setSiteContextWorkerFactoryForTest(() => worker); });
afterEach(() => { __setSiteContextWorkerFactoryForTest(null); useViewerStore.setState(initial, true); });

let next = 0;
/** The panel: the real fetch orchestrator, its addModel the real shared loader. */
async function loadFromPanel(kind: 'terrain' | 'parcel' = 'terrain', anchorModelId = 'anchor'): Promise<string> {
  const run = loadSiteContext({
    anchorModelId, centre: { x: 2_600_000, y: 1_200_000 }, radius: 100, categories: [kind], imagery: false,
    addModel: (_file, { name, siteContextArrival }) => load(`panel-${++next}`, terrainGlb(kind), { siteContextArrival }).then((id) => { if (id) useViewerStore.getState().updateModel(id, { name }); return id; }),
    removeModel: (id) => useViewerStore.getState().removeModel(id),
  });
  expectSceneMatchesCategories();
  worker.send({ type: 'category', kind, bytes: terrainGlb(kind), hasGeometry: true, complete: true, attribution: [], issues: [] } as Omit<SiteContextWorkerResponse, 'id'>);
  worker.send({ type: 'complete', stats: { requests: 1, bytes: 1, cacheHits: 0 } } as Omit<SiteContextWorkerResponse, 'id'>);
  await run;
  expectSceneMatchesCategories();
  return [...useViewerStore.getState().siteContextModels].filter(([, r]) => r.kind === kind).map(([id]) => id).at(-1)!;
}


test('panel terrain, then a dropped terrain GLB: one terrain in the scene, and the category points at it', async () => {
  const fromPanel = await loadFromPanel();
  // Add before remove: when the panel terrain leaves the scene, the dropped one is already in it.
  let droppedWasIn: boolean | null = null;
  const stop = useViewerStore.subscribe((s) => { if (droppedWasIn === null && !s.models.has(fromPanel)) droppedWasIn = s.models.has('dropped'); });
  await load('dropped', terrainGlb());
  stop();
  assert.equal(droppedWasIn, true);
  assert.deepEqual(terrains(), ['dropped']);
  assert.equal(inScene().includes(fromPanel), false, 'the panel terrain left the scene');
  assert.equal(category()?.modelId, 'dropped');
  assert.equal(category()?.anchorModelId, undefined, 'a dropped file was not loaded around a model');
});

test('a dropped terrain GLB, then panel terrain: one terrain, loaded around the anchor', async () => {
  await load('dropped', terrainGlb());
  const fromPanel = await loadFromPanel();
  assert.deepEqual(terrains(), [fromPanel]);
  assert.equal(inScene().includes('dropped'), false);
  assert.equal(category()?.modelId, fromPanel);
  assert.equal(category()?.anchorModelId, 'anchor');
});

test('the same terrain GLB dropped twice: one terrain', async () => {
  await load('first', terrainGlb());
  await load('second', terrainGlb());
  assert.deepEqual(terrains(), ['second']);
  assert.deepEqual(inScene(), ['second']);
});

test('a dropped GLB that fails to load keeps the terrain that was there', async () => {
  await load('first', terrainGlb());
  assert.equal(await load('broken', terrainGlb(), { failFinalize: true }), null);
  assert.deepEqual(terrains(), ['first']);
  assert.deepEqual(inScene(), ['first']);
  assert.equal(category()?.modelId, 'first');
});

test('panel terrain loaded twice: the second replaces the first, new one in before the old one leaves', async () => {
  const first = await loadFromPanel();
  let secondWasIn: boolean | null = null;
  const stop = useViewerStore.subscribe((s) => { if (secondWasIn === null && !s.models.has(first)) secondWasIn = s.models.size > 0 && terrains().some((id) => id !== first); });
  const second = await loadFromPanel();
  stop();
  assert.deepEqual(terrains(), [second]);
  assert.equal(secondWasIn, true);
  assert.equal(category()?.modelId, second);
});

test('only the arriving kind is replaced: a loaded parcel stays when terrain arrives', async () => {
  useViewerStore.setState((s) => ({ models: new Map([...s.models, ['parcel-model', fixtureModel('parcel-model')]]) }));
  useViewerStore.getState().registerSiteContextModel('parcel-model', { kind: 'parcel', attribution: [], issues: [], complete: true, origin: [0, 0, 0] });
  useViewerStore.getState().recordArrivedSiteContextCategory('parcel', { status: 'done', modelId: 'parcel-model' });
  await load('dropped', terrainGlb());
  assert.equal(useViewerStore.getState().siteContextModels.get('parcel-model')?.kind, 'parcel');
  assert.ok(inScene().includes('parcel-model'));
});

test('a terrain-only load around model B leaves the parcel loaded around model A, with its record and note', async () => {
  const parcel = await loadFromPanel('parcel', 'A');
  await loadFromPanel('terrain', 'B');
  const state = useViewerStore.getState();
  assert.ok(state.models.has(parcel), 'the parcel is still in the scene');
  assert.equal(state.siteContextCategories.parcel?.modelId, parcel, 'and its category record still points at it');
  assert.equal(state.siteContextCategories.parcel?.anchorModelId, 'A', 'loaded around A');
  assert.equal(state.siteContextCategories.terrain?.anchorModelId, 'B');
  expectSceneMatchesCategories();
});
