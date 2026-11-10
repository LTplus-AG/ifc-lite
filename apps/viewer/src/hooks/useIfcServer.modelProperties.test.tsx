/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
(globalThis as unknown as { __VITE_ENV__?: Record<string, unknown> }).__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: false, VITE_IFC_SERVER_URL: 'http://localhost:9999', VITE_USE_SERVER: 'true' };
import { afterEach, beforeEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { installModelLoadCanceller } from './modelLoadCanceller.js';
import { fixtureModel, fixtureDataStore } from '@/test/store-fixture.js';
import { IfcServerClient, type HealthResponse, type ParseResponse, decodeDataModel } from '@ifc-lite/server-client';
import { propertyModelBuffer } from '../../../../packages/server-client/test/fixtures/property-model.js';
const { useIfcServer } = await import('./useIfcServer.js');
const wire = propertyModelBuffer();

let api: ReturnType<typeof useIfcServer>;
let root: Root, container: HTMLDivElement;
let release!: (bytes: ArrayBuffer) => void;
let pending: Promise<boolean>;
let releaseLoad: (() => void) | undefined;
const file = new File(['IFC'], 'server.ifc');
let signal: AbortSignal, stale: boolean;
const result = () => fixtureDataStore([{ expressId: 1, type: 'IfcWall', name: 'Server properties' }]);
function Probe() { api = useIfcServer(); return null; }
async function start() {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async (_key: string, options?: Parameters<IfcServerClient['fetchDataModel']>[1]) => {
    signal = (typeof options === 'object' ? options.signal : undefined)!;
    entered();
    return new Promise<ArrayBuffer>(resolve => { release = resolve; });
  });
  await act(async () => { pending = api.loadFromServer(file, new ArrayBuffer(1), () => stale); await ready; });
  assert.ok(signal, 'optional polling must receive its own model-owned signal');
}
beforeEach(async () => {
  stale = false; releaseLoad = undefined; pending = Promise.resolve(true); release = () => {};
  mock.method(IfcServerClient.prototype, 'health', async () => ({ status: 'ok' }) as HealthResponse);
  mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => false);
  mock.method(IfcServerClient.prototype, 'parse', async (): Promise<ParseResponse> => ({
    meshes: [], cache_key: 'properties',
    metadata: { schema_version: 'IFC4', entity_count: 2, geometry_entity_count: 0, coordinate_info: { origin_shift: [0, 0, 0], is_geo_referenced: false } },
    stats: { total_meshes: 0, total_vertices: 0, total_triangles: 0, parse_time_ms: 1, geometry_time_ms: 1, total_time_ms: 2, from_cache: false },
  }));
  useViewerStore.getState().clearAllModels();
  const model = { ...fixtureModel('server'), ifcDataStore: null, sourceFile: file, loadState: 'complete' as const };
  useViewerStore.getState().addModel(model);
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); await act(async () => { root.render(<Probe />); });
});
afterEach(async () => {
  releaseLoad?.(); release?.(wire); await pending;
  await act(async () => { root.unmount(); }); container.remove(); mock.restoreAll();
  useViewerStore.getState().clearAllModels();
});
it('#9538 late properties publish into their still-current model', async () => {
  await decodeDataModel(wire);
  await start();
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().ifcDataStore?.entities.getName(1), 'Server properties');
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore?.entities.getName(1), 'Server properties');
});
for (const cause of ['remove', 'clear', 'replace', 'supersede', 'unmount', 'failed-model', 'other-hook-primary', 'source-replace'] as const) {
  it(`#9538 ${cause} aborts model properties and a transport ignoring abort cannot publish`, async () => {
    await start();
    const oldSignal = signal;
    await act(async () => {
      if (cause === 'remove') useViewerStore.getState().removeModel('server');
      if (cause === 'clear') useViewerStore.getState().clearAllModels();
      if (cause === 'replace') useViewerStore.getState().updateModel('server', { ifcDataStore: result() });
      if (cause === 'supersede') { stale = true; useViewerStore.setState({ loading: true }); }
      if (cause === 'unmount') root.render(null);
      if (cause === 'failed-model') useViewerStore.getState().updateModel('server', { loadState: 'error' });
      if (cause === 'other-hook-primary') releaseLoad = installModelLoadCanceller('primary', () => {});
      if (cause === 'source-replace') useViewerStore.getState().updateModel('server', { sourceFile: new File(['new'], 'replacement.ifc') });
    });
    assert.equal(oldSignal.aborted, true);
    const before = useViewerStore.getState().ifcDataStore;
    await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
    assert.equal(useViewerStore.getState().ifcDataStore === before, true, 'late writes must not replace the current store');
  });
}
it('#9538 silent supersession is checked again at the publication boundary', async () => {
  await start(); stale = true; // loader identity can change before a store notification
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().ifcDataStore === null, true);
});
it('#9538 fast properties wait for finalization so its null placeholder cannot overwrite them', async () => {
  useViewerStore.getState().updateModel('server', { loadState: 'streaming-geometry' });
  await start();
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().ifcDataStore === null, true);
  await act(async () => { useViewerStore.getState().updateModel('server', { loadState: 'complete', ifcDataStore: null }); });
  assert.equal(useViewerStore.getState().ifcDataStore?.entities.getName(1), 'Server properties');
});

it('#9538 no model lifetime means no optional poll', async () => {
  useViewerStore.getState().clearAllModels();
  let calls = 0;
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async () => { calls++; return null; });
  await act(async () => { await api.loadFromServer(file, new ArrayBuffer(1)); });
  assert.equal(calls, 0);
});
it('#9538 a missing optional response preserves properties already belonging to the model', async () => {
  const existing = result();
  useViewerStore.getState().updateModel('server', { ifcDataStore: existing });
  const warnings: unknown[][] = [];
  mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async () => null);
  await act(async () => { await api.loadFromServer(file, new ArrayBuffer(1)); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().ifcDataStore === existing, true);
  assert.equal(warnings.length, 0, 'a missing optional response is not a decode failure');
});
for (const cause of ['removed', 'published'] as const) {
  it(`#9538 ${cause} model properties release their store subscription`, async () => {
    const subscribe = useViewerStore.subscribe;
    const listeners = new Set<Parameters<typeof subscribe>[0]>();
    mock.method(useViewerStore, 'subscribe', (listener: Parameters<typeof subscribe>[0]) => {
      listeners.add(listener);
      const stop = subscribe(listener);
      return () => { listeners.delete(listener); stop(); };
    });
    await start();
    assert.equal(listeners.size, 1);
    await act(async () => {
      if (cause === 'removed') useViewerStore.getState().removeModel('server');
      else { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); }
    });
    assert.equal(listeners.size, 0, 'no model watcher may survive completion/teardown');
  });
}

it('#9538 properties for an inactive loaded model never overwrite the active model', async () => {
  await start();
  const other = fixtureModel('other');
  useViewerStore.getState().addModel(other);
  await act(async () => { useViewerStore.getState().setActiveModel('other'); });
  assert.equal(signal.aborted, false, 'a model switch does not end the loaded model lifetime');
  const current = useViewerStore.getState().ifcDataStore;
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().ifcDataStore === current, true);
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore?.entities.getName(1), 'Server properties');
});

for (const included of [true, false]) {
  it(`#9538 ${included ? 'included' : 'empty included'} properties use the correct hydration source`, async () => {
    const parsed = await IfcServerClient.prototype.parse(file);
    mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => true);
    mock.method(IfcServerClient.prototype, 'parseParquet', async () => ({
      ...parsed, data_model: included ? wire : new ArrayBuffer(0), parquet_stats: { payload_size: 0, decode_time_ms: 0 },
    }));
    let calls = 0;
    mock.method(IfcServerClient.prototype, 'fetchDataModel', async () => { calls++; return wire; });
    await act(async () => { await api.loadFromServer(file, new ArrayBuffer(1)); await new Promise(resolve => setTimeout(resolve, 200)); });
    assert.equal(calls, included ? 0 : 1);
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore?.entities.getName(1), 'Server properties');
  });
}
