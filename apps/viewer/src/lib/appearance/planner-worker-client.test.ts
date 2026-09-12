/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAppearancePlanner, type AppearanceWorker } from './planner-worker-client.js';
import type { AppearancePlan, AppearanceRequest, AppearanceWorkerRequest, AppearanceWorkerResponse } from './planner-types.js';
import type { MeshTransferRequest } from './scan/transfer-types.js';
const request: AppearanceRequest = {
  schema: 'IFC4', sourceRevision: 'first', nextExpressId: 100, productIds: [10],
  imageUri: 'image.png', repeatS: true, repeatT: true,
  mapping: { kind: 'existingUv', scale: [1, 1], offset: [0, 0], rotationRadians: 0 },
};
const plan = (revision = 'first'): AppearancePlan => ({ sourceRevision: revision, nextExpressId: 100,
  nextAvailableExpressId: 100, created: [], edits: [], removed: [], items: [], exclusions: [] });
class FakeWorker implements AppearanceWorker {
  onmessage: AppearanceWorker['onmessage'] = null;
  onerror: AppearanceWorker['onerror'] = null;
  onmessageerror: AppearanceWorker['onmessageerror'] = null;
  terminated = 0;
  posted: AppearanceWorkerRequest | undefined;
  postMessage(message: AppearanceWorkerRequest) {
    assert.equal(arguments.length, 1, 'live source must never be passed in a transfer list');
    this.posted = structuredClone(message);
  }
  terminate() { this.terminated++; }
  emit(message: AppearanceWorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<AppearanceWorkerResponse>); }
  complete(result = plan()) { this.emit({ type: 'complete', id: this.posted!.id, plan: result }); }
}
function setup(timeoutMs = 120_000) {
  const workers: FakeWorker[] = [];
  const client = createAppearancePlanner({ timeoutMs, workerFactory: () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  } });
  return { workers, client };
}
describe('appearance worker ownership (#4243)', () => {
  it('finite page jobs share supersession and reject stale allocator output without detaching pixels (#4260)', async () => {
    const { client, workers } = setup();
    const rgba = new Uint8Array([255, 0, 0, 255]);
    const page = { appearance: request, page: { width: 1, height: 1, byteOffset: 0, byteLength: 4 }, sourceImages: [], texelsPerMetre: 64 };
    const first = client.pagePlan(new Uint8Array([1]), page, rgba);
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const second = client.catalog(new Uint8Array([1]), { schema: 'IFC4', sourceRevision: 'new', productIds: [10] });
    await rejected;
    assert.equal(workers[0].terminated, 1); assert.equal(rgba.byteLength, 4);
    const wrongCatalog = assert.rejects(second, /stale/);
    workers[1].emit({ type: 'page-complete', id: workers[1].posted!.id,
      result: { plan: plan(), itemImages: [], assets: [], texelsPerMetre: 64 } });
    await wrongCatalog;
    const stale = client.pagePlan(new Uint8Array([1]), page, rgba);
    workers[2].emit({ type: 'page-complete', id: workers[2].posted!.id,
      result: { plan: { ...plan(), nextExpressId: 101 }, itemImages: [], assets: [], texelsPerMetre: 64 } });
    await assert.rejects(stale, /stale/); assert.equal(workers[2].terminated, 1);
    client.dispose();
  });
  it('catalog and plan share cancellation, revision fencing and deterministic worker release (#4243)', async () => {
    const { client, workers } = setup();
    const first = client.catalog(new Uint8Array([1]), { schema: 'IFC4', sourceRevision: 'catalog-old', productIds: [10] });
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    const stale = workers[0].onmessage!;
    const next = client.plan(new Uint8Array([1]), request);
    await cancelled;
    stale(new MessageEvent<AppearanceWorkerResponse>('message', { data: { type: 'catalog-complete', id: 1, catalog: { sourceRevision: 'catalog-old', products: [], types: [], missingProductIds: [10] } } }));
    assert.equal(workers[1].terminated, 0);
    workers[1].complete(); await next;
    const wrong = client.catalog(new Uint8Array([1]), { schema: 'IFC4', sourceRevision: 'catalog-new', productIds: [10] });
    workers[2].emit({ type: 'catalog-complete', id: workers[2].posted!.id,
      catalog: { sourceRevision: 'catalog-old', products: [], types: [], missingProductIds: [10] } });
    await assert.rejects(wrong, /stale or invalid catalog/);
    assert.equal(workers[2].terminated, 1);
    const timeoutClient = setup(5);
    await assert.rejects(timeoutClient.client.catalog(new Uint8Array(), { schema: 'IFC4', sourceRevision: 'timeout', productIds: [] }), /stopped responding/);
    assert.equal(timeoutClient.workers[0].terminated, 1);
    client.dispose();
    await assert.rejects(client.catalog(new Uint8Array(), { schema: 'IFC4', sourceRevision: '', productIds: [] }), /disposed/);
  });
  it('refuses oversized catalog owner arrays before spawning or copying to a worker (#4243)', async () => {
    const { client, workers } = setup();
    await assert.rejects(client.catalog(new Uint8Array(), { schema: 'IFC4', sourceRevision: 'bounded', productIds: new Array(10_001).fill(10) }), /10000 owners/);
    assert.equal(workers.length, 0);
  });
  it('rejects an oversized source before spawning a worker or cloning its bytes', async () => {
    let attempted = 0;
    const client = createAppearancePlanner({ workerFactory: () => {
      attempted++;
      throw new Error('Oversized source reached the worker boundary');
    } });
    const source = new Uint8Array(128 * 1024 * 1024 + 1);
    await assert.rejects(client.plan(source, request), /exceeds 128 MiB/);
    assert.equal(attempted, 0);
    assert.equal(source.byteLength, 128 * 1024 * 1024 + 1);
    client.dispose();
  });
  it('preserves source storage and clears handlers/worker on success', async () => {
    const { client, workers } = setup();
    const source = new Uint8Array([1, 2, 3]);
    const pending = client.plan(source, request);
    assert.deepEqual(workers[0].posted?.source, source);
    assert.notStrictEqual(workers[0].posted?.source.buffer, source.buffer);
    workers[0].complete(); await pending;
    assert.deepEqual([...source], [1, 2, 3]);
    assert.equal(workers[0].terminated, 1); assert.equal(workers[0].onmessage, null);
    client.dispose(); assert.equal(workers[0].terminated, 1);
  });
  it('a newer job rejects the previous one and ignores already-queued stale callbacks', async () => {
    const { client, workers } = setup();
    const first = client.plan(new Uint8Array(1), request);
    const rejected = assert.rejects(first, { name: 'AbortError' });
    const staleCallback = workers[0].onmessage!;
    const next = client.plan(new Uint8Array(1), { ...request, sourceRevision: 'second' });
    await rejected;
    staleCallback({ data: { type: 'complete', id: 1, plan: plan() } } as MessageEvent<AppearanceWorkerResponse>);
    assert.equal(workers[0].terminated, 1); assert.equal(workers[1].terminated, 0);
    workers[1].emit({ type: 'complete', id: 1, plan: plan() });
    assert.equal(workers[1].terminated, 0, 'wrong job id cannot settle the active worker');
    workers[1].complete(plan('second')); await next;
    assert.equal(workers[1].terminated, 1);
  });
  it('aborted/disposed clients spawn no worker and cancellation releases an active worker', async () => {
    const { client, workers } = setup();
    const signal = AbortSignal.abort();
    await assert.rejects(client.plan(new Uint8Array(), request, { signal }), { name: 'AbortError' });
    assert.equal(workers.length, 0);
    const controller = new AbortController();
    const pending = client.plan(new Uint8Array(), request, { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    controller.abort(); await rejected; assert.equal(workers[0].terminated, 1);
    client.dispose(); await assert.rejects(client.plan(new Uint8Array(), request), /disposed/);
    assert.equal(workers.length, 1);
  });
  it('rejects factory/postMessage failures without retaining worker ownership', async () => {
    const broken = createAppearancePlanner({ workerFactory: () => { throw new Error('CSP blocked'); } });
    await assert.rejects(broken.plan(new Uint8Array(), request), /CSP blocked/);
    const worker = new FakeWorker(); worker.postMessage = () => { throw new Error('clone failed'); };
    const client = createAppearancePlanner({ workerFactory: () => worker });
    await assert.rejects(client.plan(new Uint8Array(), request), /clone failed/);
    assert.equal(worker.terminated, 1); assert.equal(worker.onerror, null); client.dispose();
    assert.equal(worker.terminated, 1);
  });
  it('terminates on timeout, crashes, unreadable messages, and mismatched model revisions', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, workers } = setup(100);
    const timeout = client.plan(new Uint8Array(), request);
    const timedOut = assert.rejects(timeout, /stopped responding/);
    t.mock.timers.tick(100); await timedOut;
    const crash = client.plan(new Uint8Array(), request);
    workers[1].onerror?.({ message: 'worker crashed' } as ErrorEvent);
    await assert.rejects(crash, /worker crashed/);
    const unreadable = client.plan(new Uint8Array(), request);
    workers[2].onmessageerror?.({} as MessageEvent);
    await assert.rejects(unreadable, /unreadable/);
    const mismatch = client.plan(new Uint8Array(), request); workers[3].complete(plan('wrong'));
    await assert.rejects(mismatch, /stale model/);
    assert.ok(workers.every(worker => worker.terminated === 1));
    t.mock.timers.tick(500); assert.ok(workers.every(worker => worker.terminated === 1));
  });
  it('propagates canonical eligibility errors and releases the worker', async () => {
    const { client, workers } = setup();
    const pending = client.plan(new Uint8Array(), request);
    workers[0].emit({ type: 'error', id: workers[0].posted!.id, message: 'Invalid appearance mapping parameters' });
    await assert.rejects(pending, /Invalid appearance mapping/);
    assert.equal(workers[0].terminated, 1);
  });
});

it('scan registration cancels its worker and ignores a late result from the abandoned request (#4381)', async () => {
  const { client, workers } = setup();
  const request = { sourceFrame: { assetSha256: 'a'.repeat(64), frameKey: 'source' }, targetFrame: { assetSha256: 'b'.repeat(64), frameKey: 'target' }, fit: [], heldOut: [] };
  const abort = new AbortController();
  const first = client.registerScan(request, { signal: abort.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const late = workers[0].onmessage!;
  abort.abort(); await rejected;
  assert.equal(workers[0].terminated, 1);
  const second = client.catalog(new Uint8Array(), { schema: 'IFC4', sourceRevision: 'current', productIds: [] });
  late({ data: { type: 'error', id: workers[0].posted!.id, message: 'abandoned error' } } as MessageEvent<AppearanceWorkerResponse>);
  assert.equal(workers[1].terminated, 0, 'late scan response cannot settle another appearance job');
  workers[1].emit({ type: 'catalog-complete', id: workers[1].posted!.id, catalog: { sourceRevision: 'current', products: [], types: [], missingProductIds: [] } });
  await second; client.dispose();
});

it('scan registration refuses oversized correspondence sets before creating a worker (#4381)', async () => {
  const { client, workers } = setup();
  const point = { id: 'p', sourceObservation: 's', targetFeature: 't', source: [0,0,0] as [number,number,number], target: [0,0,0] as [number,number,number] };
  await assert.rejects(client.registerScan({ sourceFrame: { assetSha256: 'a'.repeat(64), frameKey: 'source' }, targetFrame: { assetSha256: 'b'.repeat(64), frameKey: 'target' }, fit: new Array(257).fill(point), heldOut: [] }), /budget/);
  assert.equal(workers.length, 0); client.dispose();
});

it('point transfer reports malformed orientation channels before spawning a worker (#4561)', async () => {
  const { client, workers } = setup();
  const scanRequest: MeshTransferRequest = {
    schema: 'IFC4', sourceRevision: 'points', nextExpressId: 1, productIds: [1],
    registration: { sourceFrame: { assetSha256: 'a'.repeat(64), frameKey: 'source' }, targetFrame: { assetSha256: 'b'.repeat(64), frameKey: 'target' }, fit: [], heldOut: [] },
    registrationSha256: 'c'.repeat(64), targetFromIfcWorld: { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sourceAnchor: [0, 0, 0], targetAnchor: [0, 0, 0] },
    source: { kind: 'points', pointCount: 1, orientation: 'source-normals', neighborhoodRadiusMetres: 0.03, minNeighbors: 3, maxNeighbors: 8, surfaceBandMetres: 0.003, viewpoints: [] },
    sourceImages: [], texelsPerMetre: 64, maxDistanceMetres: 0.02, minNormalDot: 0.8, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.01,
  };
  await assert.rejects(client.pointTransfer(new Uint8Array(), scanRequest, new Uint8Array(), {
    positions: new Float64Array(3), colors: new Uint8Array(3), normals: new Float32Array(0), stations: new Uint32Array(0),
  }), /source-normals orientation has mismatched normal or station rows/);
  assert.equal(workers.length, 0);
  client.dispose();
});
