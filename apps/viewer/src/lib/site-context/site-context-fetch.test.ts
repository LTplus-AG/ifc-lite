/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Load site context" end to end against a fake worker: the real
 * orchestrator, the real slice. Each category's status follows what arrived
 * (complete, incomplete, nothing) and what the user did (cancel), and a
 * cancel never discards categories that already loaded.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { useViewerStore } from '@/store';
import { __setSiteContextWorkerFactoryForTest, type SiteContextWorkerLike } from './site-context-client';
import type { SiteContextWorkerRequest, SiteContextWorkerResponse } from './site-context-job';
import { loadSiteContext, type SiteContextAddModel } from './site-context-fetch';

const initial = useViewerStore.getState();
const swisstopo = { datasetId: 'swissalti3d', text: '© swisstopo', licence: 'OGD', termsUrl: 'https://example.invalid', restrictions: [], termsVerifiedOn: '2026-11-15' };

/** A worker the test drives message by message. */
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
  category(kind: 'terrain' | 'parcel' | 'buildings', complete: boolean, hasGeometry = true): void {
    this.send({ type: 'category', kind, bytes: new Uint8Array([1, 2, 3]), hasGeometry, complete, attribution: [swisstopo],
      issues: complete ? [] : [{ code: `${kind}-incomplete`, severity: 'warning', message: `${kind} incomplete` }] } as Omit<SiteContextWorkerResponse, 'id'>);
  }
}

let worker: FakeWorker;
const added: string[] = [];
const addModel: SiteContextAddModel = async (_file, { name }) => { added.push(name); return `model:${name}`; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  worker = new FakeWorker();
  added.length = 0;
  removed.length = 0;
  __setSiteContextWorkerFactoryForTest(() => worker);
});
afterEach(() => {
  __setSiteContextWorkerFactoryForTest(null);
  useViewerStore.setState(initial, true);
});

const removed: string[] = [];
const removeModel = (modelId: string) => { removed.push(modelId); };
const base = { anchorModelId: 'anchor', centre: { x: 2_600_000, y: 1_200_000 }, radius: 200 as const, imagery: false, addModel, removeModel };

test('categories go fetching → done / partial as they arrive, and the run records its statistics', async () => {
  const run = loadSiteContext({ ...base, categories: ['terrain', 'parcel'] });
  const state = () => useViewerStore.getState();
  assert.equal(state().siteContextCategories.terrain?.status, 'fetching');
  assert.equal(state().siteContextCategories.parcel?.status, 'fetching');
  assert.ok(state().siteContextAbort, 'a running request holds its abort handle');
  worker.category('terrain', true);
  await tick();
  assert.equal(state().siteContextCategories.terrain?.status, 'done');
  assert.equal(state().siteContextCategories.terrain?.modelId, 'model:Site context · Terrain');
  assert.equal(state().siteContextCategories.parcel?.status, 'fetching');
  worker.category('parcel', false);
  worker.send({ type: 'complete', stats: { requests: 7, bytes: 1234, cacheHits: 2 } } as Omit<SiteContextWorkerResponse, 'id'>);
  await run;
  assert.equal(state().siteContextCategories.parcel?.status, 'partial');
  assert.deepEqual(state().siteContextCategories.parcel?.issues.map((issue) => issue.code), ['parcel-incomplete']);
  assert.equal(state().siteContextStats?.requests, 7);
  assert.equal(state().siteContextAbort, null);
  assert.ok(worker.terminated);
  assert.deepEqual(added, ['Site context · Terrain', 'Site context · Parcel']);
});

test('cancel keeps what loaded, returns what is in flight to idle, and stops the worker', async () => {
  const run = loadSiteContext({ ...base, categories: ['terrain', 'parcel'] });
  worker.category('terrain', true);
  await tick();
  useViewerStore.getState().abortSiteContextRequest();
  await run;
  const { siteContextCategories: categories, siteContextAbort } = useViewerStore.getState();
  assert.equal(categories.terrain?.status, 'done');
  assert.equal(categories.parcel?.status, 'idle');
  assert.equal(siteContextAbort, null);
  assert.ok(worker.terminated, 'terminating the worker cancels its requests');
  // A category the worker finishes after the cancel is not loaded.
  worker.category('parcel', true);
  await tick();
  assert.deepEqual(added, ['Site context · Terrain']);
});

test('a category with no geometry and a failed run end as errors carrying their reasons', async () => {
  const run = loadSiteContext({ ...base, categories: ['terrain', 'buildings'] });
  worker.category('buildings', false, false);
  await tick();
  worker.send({ type: 'error', message: 'swissALTI3D has no data', coverage: true, stats: { requests: 3, bytes: 10, cacheHits: 0 } } as Omit<SiteContextWorkerResponse, 'id'>);
  await run;
  const state = useViewerStore.getState();
  assert.equal(state.siteContextCategories.buildings?.status, 'error');
  assert.equal(state.siteContextCategories.terrain?.status, 'error');
  assert.deepEqual(state.siteContextCategories.terrain?.issues.map((issue) => issue.message), ['swissALTI3D has no data']);
  assert.equal(state.siteContextError, 'swissALTI3D has no data');
  assert.equal(state.siteContextStats?.requests, 3);
  assert.deepEqual(added, []);
});

test('an imagery failure leaves the terrain loaded but partial, with the reason', async () => {
  const run = loadSiteContext({
    ...base, categories: ['terrain'], imagery: true,
    drapeImagery: async () => { throw new Error('SWISSIMAGE answered 503'); },
  });
  worker.category('terrain', true);
  worker.send({ type: 'complete', stats: { requests: 1, bytes: 1, cacheHits: 0 } } as Omit<SiteContextWorkerResponse, 'id'>);
  await run;
  const terrain = useViewerStore.getState().siteContextCategories.terrain;
  assert.equal(terrain?.status, 'partial');
  assert.match(terrain?.issues.at(-1)?.message ?? '', /SWISSIMAGE answered 503/);
});

// Replacing an earlier model of the same kind is the shared load step's job, on every path:
// see apps/viewer/src/hooks/ingest/siteContextLoad.replace.test.ts (real loader, real GLBs).
