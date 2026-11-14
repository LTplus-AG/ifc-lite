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
import { MutablePropertyView } from '@ifc-lite/mutations';
import { federationRegistry } from '@ifc-lite/renderer';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { discardUnchangedMutationViews } from '@/utils/model-mutation-view';
import { LandXmlProvisionalTransaction } from './ingest/landXmlProvisionalTransaction.js';
import { registerOverlayCapacity } from '@/store/overlay-capacity';
import { createStore } from 'zustand/vanilla';
import { dataMutationPermission } from '@/store/mutation-permission';
import { fromGlobalIdFromModels } from '@/store/globalId';
import { useServerModelProperties } from './ingest/useServerModelProperties.js';
import { useActivityJournal, cancelActivity } from '@/lib/activity/activity-journal';
import { installModelLoadCanceller } from './modelLoadCanceller.js';
import { fixtureModel, fixtureDataStore } from '@/test/store-fixture.js';
import { IfcServerClient, ServerEntityIndex, type HealthResponse, type ParseResponse, decodeDataModel } from '@ifc-lite/server-client';
import { convertServerDataModel } from '../utils/serverDataModel.js';
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
let stopObserver: (() => void) | undefined;
const result = () => fixtureDataStore([{ expressId: 1, type: 'IfcWall', name: 'Server properties' }]);
function serverStoreAt(expressId: number) {
  return convertServerDataModel({
    entities: ServerEntityIndex.fromRows([{ entity_id: expressId, type_name: 'IFCPROJECT', global_id: 'far', name: 'Past the headroom', has_geometry: false }]),
    propertySets: new Map(), quantitySets: new Map(), relationships: [], classifications: [], materials: [], documents: [],
    spatialHierarchy: {
      nodes: [{ entity_id: expressId, parent_id: 0, level: 0, path: 'P', type_name: 'IFCPROJECT', name: 'P', children_ids: [], element_ids: [] }],
      project_id: expressId, element_to_storey: new Map(), element_to_building: new Map(), element_to_site: new Map(), element_to_space: new Map(),
    },
  }, { cache_key: 'far', metadata: { schema_version: 'IFC4' }, stats: { total_time_ms: 1, parse_time_ms: 1, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 } }, { size: 1 }, []);
}
function Probe() { api = useIfcServer(); return null; }
async function start() {
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async (_key: string, options?: Parameters<IfcServerClient['fetchDataModel']>[1]) => {
    signal = (typeof options === 'object' ? options.signal : undefined)!;
    entered();
    return new Promise<ArrayBuffer>(resolve => { release = resolve; });
  });
  await act(async () => { pending = api.loadFromServer(file, new ArrayBuffer(1), () => stale, undefined, 'server'); await ready; });
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
  stopObserver?.(); stopObserver = undefined;
  useViewerStore.getState().clearMutationView([...useViewerStore.getState().mutationViews.keys()]);
  useViewerStore.getState().clearAllModels();
  federationRegistry.clear();
});
it('#9538 late properties publish into their still-current model', async () => {
  await decodeDataModel(wire);
  await start();
  const job = useActivityJournal.getState().jobs.find(row => row.outcome === 'running');
  assert.ok(job);
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().ifcDataStore?.entities.getName(1), 'Server properties');
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore?.entities.getName(1), 'Server properties');
  assert.equal(useActivityJournal.getState().jobs.find(row => row.id === job.id)?.outcome, 'completed');
});
for (const federated of [false, true]) {
  it(`late properties publish the unmeshed entities they bring${federated ? ' behind an earlier model' : ''}`, async () => {
    try {
      // The loader registers a server model from its meshes alone (the wire's wall, #1) and the
      // data model lands afterwards. Its project (#2) has no mesh, and looking it up used to throw
      // "[FederationRegistry] Local ID 2 is not published for model server".
      const { registerModelOffset, updateModel } = useViewerStore.getState();
      if (federated) registerModelOffset('earlier', 100);
      const idOffset = registerModelOffset('server', 1);
      updateModel('server', { idOffset, maxExpressId: 1 });
      await start();
      await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
      const model = useViewerStore.getState().models.get('server');
      assert.equal(model?.ifcDataStore?.entities.getName(2), 'Project');
      assert.equal(useViewerStore.getState().toGlobalId('server', 2), idOffset + 2);
      assert.deepEqual(useViewerStore.getState().fromGlobalId(idOffset + 2), { modelId: 'server', expressId: 2 });
      assert.equal(model?.maxExpressId, 2, 'overlay ids start after the hydrated entities, not inside them');
    } finally { federationRegistry.clear(); }
  });
}
it('properties whose ids run past a later model are published as far as the headroom allows', async () => {
  try {
    // The id range cannot move once a later model sits behind it; it grows to the end of its own
    // overlay headroom. The properties are kept; only the ids beyond that end stay unresolvable.
    const { registerModelOffset, updateModel } = useViewerStore.getState();
    updateModel('server', { idOffset: registerModelOffset('server', 1), maxExpressId: 1 });
    const laterOffset = registerModelOffset('later', 10);
    useViewerStore.getState().addModel({ ...fixtureModel('later', { idOffset: laterOffset }), maxExpressId: 10 });
    const warnings: unknown[][] = [];
    mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    // A converted server store, whose compact id index sets the store's highest id.
    const tooFar = serverStoreAt(2_000_000);
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => tooFar);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, tooFar, 'the properties are not dropped');
    // maxExpressId is the ownership bound the reverse resolvers read: the published end, not the store
    // max, or this model would claim the later model's global ids.
    assert.equal(useViewerStore.getState().models.get('server')?.maxExpressId, 1_000_001, 'the published end');
    for (const local of [0, 5, 10]) {
      const ref = { modelId: 'later', expressId: local };
      assert.deepEqual(useViewerStore.getState().resolveGlobalIdFromModels(laterOffset + local), ref, `the later model's local ${local} resolves to it`);
      assert.deepEqual(fromGlobalIdFromModels(useViewerStore.getState().models, laterOffset + local), ref);
    }
    // The later model owns the ids past the published end, so this model has none to author with.
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: false, reason: 'id-space-exhausted' });
    assert.equal(useViewerStore.getState().toGlobalId('server', 1_000_001), 1_000_001, 'published to the end of the headroom');
    assert.throws(() => useViewerStore.getState().toGlobalId('server', 2_000_000), /not published/);
    assert.equal(warnings.some(args => /later model owns/.test(String(args[0]))), true, 'the unresolvable ids are reported');
    assert.deepEqual(useViewerStore.getState().fromGlobalId(laterOffset + 10), { modelId: 'later', expressId: 10 });
  } finally { federationRegistry.clear(); }
});

for (const rehydrate of [false, true]) {
  it(rehydrate
    ? 'smaller re-hydration after a clamp keeps id space exhausted and editing refused'
    : 'hydration exactly at overlay headroom end exhausts id space and refuses editing', async () => {
    try {
      const { registerModelOffset, updateModel } = useViewerStore.getState();
      updateModel('server', { idOffset: registerModelOffset('server', 1), maxExpressId: 1 });
      registerModelOffset('later', 10);
      mock.method(console, 'warn', () => {});
      const hydrate = async (expressId: number) => {
        const store = serverStoreAt(expressId);
        await act(async () => {
          useServerModelProperties().start('server', undefined, async () => store);
          await new Promise(resolve => setTimeout(resolve, 50));
        });
        assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, store);
      };
      if (rehydrate) {
        await hydrate(2_000_000);
      }
      await hydrate(rehydrate ? 2 : 1_000_001);
      assert.equal(useViewerStore.getState().models.get('server')?.maxExpressId, 1_000_001);
      assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: false, reason: 'id-space-exhausted' });
      assert.throws(() => federationRegistry.publishOverlayRange('server', 1_000_002, 1_000_002), /not have enough safe entity IDs/);
    } finally { federationRegistry.clear(); }
  });
}

it('a hydration whose next allocator id is publishable permits edits', async () => {
  try {
    const { registerModelOffset, updateModel } = useViewerStore.getState();
    updateModel('server', { idOffset: registerModelOffset('server', 1), maxExpressId: 1 });
    await start();
    await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
  } finally { federationRegistry.clear(); }
});

it('newest reservation allocates above a larger prior hydration without a false warning', async () => {
  const { registerModelOffset, updateModel } = useViewerStore.getState();
  updateModel('server', { idOffset: registerModelOffset('server', 1), maxExpressId: 1 });
  const warnings: unknown[][] = [];
  mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  try {
    for (const id of [2_000_000, 5]) {
      const store = serverStoreAt(id);
      await act(async () => {
        useServerModelProperties().start('server', undefined, async () => store);
        await new Promise(resolve => setTimeout(resolve, 50));
      });
      assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, store);
    }
    assert.equal(useViewerStore.getState().models.get('server')?.maxExpressId, 2_000_000);
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
    const view = getOrCreateMutationView(useViewerStore, 'server')!;
    assert.equal(view.peekNextExpressId(), 2_000_001);
    assert.equal(warnings.length, 0);
  } finally { federationRegistry.clear(); }
});

it('supersession during range extension keeps registry and model ownership consistent', async () => {
  const { registerModelOffset, updateModel } = useViewerStore.getState();
  updateModel('server', { idOffset: registerModelOffset('server', 1), maxExpressId: 1 });
  const extend = federationRegistry.extendModel.bind(federationRegistry);
  mock.method(federationRegistry, 'extendModel', (id: string, max: number) => {
    const published = extend(id, max);
    useServerModelProperties().cancel(id);
    return published;
  });
  try {
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => serverStoreAt(2_000_000));
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    const model = useViewerStore.getState().models.get('server')!;
    assert.equal(model.ifcDataStore, null, 'superseded hydration is discarded');
    assert.equal(model.maxExpressId, federationRegistry.getGlobalIdRange('server')!.end - model.idOffset);
  } finally { federationRegistry.clear(); }
});

it('reports no id left for edits when the hydrated store exactly fits its envelope', async () => {
  const { registerModelOffset, updateModel } = useViewerStore.getState();
  updateModel('server', { idOffset: registerModelOffset('server', 1), maxExpressId: 1 });
  registerModelOffset('later', 10);
  const warnings: unknown[][] = [];
  mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  try {
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => serverStoreAt(1_000_001));
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    assert.ok(warnings.some(args => /no id is left for edits/.test(String(args[0]))), JSON.stringify(warnings, (_key, value) => value instanceof Error ? value.message : value));
  } finally { federationRegistry.clear(); }
});

it('no id is authored on a server model while its properties load or after they failed', async () => {
  // Authored ids would collide with the hydrated entities the id range grows to cover.
  await start();
  assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: false, reason: 'properties-loading' });
  mock.method(console, 'warn', () => {});
  await act(async () => { release(new ArrayBuffer(3)); await new Promise(resolve => setTimeout(resolve, 200)); }); // undecodable: the run fails
  assert.equal(useViewerStore.getState().serverPropertiesRuns.get('server')?.kind, 'failed');
  assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: false, reason: 'properties-failed' });
});

it('a range that already carries authored ids is a hard error, never an alias', async () => {
  try {
    const { registerModelOffset, updateModel } = useViewerStore.getState();
    updateModel('server', { idOffset: registerModelOffset('server', 1), maxExpressId: 1 });
    federationRegistry.publishOverlayRange('server', 2, 3);
    const warnings: unknown[][] = [];
    mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    await start();
    await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, null, 'hydrated entity 2 would share a global id with authored id 2');
    assert.equal(warnings.some(args => /Optional hydration failed/.test(String(args[0]))), true);
  } finally { federationRegistry.clear(); }
});

for (const remount of [false, true]) {
  it(`#9538 ${remount ? 'a remount' : 'unmount'} of the starting component keeps model properties alive and publishes`, async () => {
    await start();
    await pending;
    await act(async () => { root.render(null); });
    if (remount) await act(async () => { root.render(<Probe />); });
    assert.equal(signal.aborted, false, 'the loaded model still owns this poll');
    await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore?.entities.getName(1), 'Server properties');
  });
}
for (const cause of ['remove', 'clear', 'session-reset', 'reused-id', 'replace', 'supersede', 'failed-model', 'other-hook-primary', 'source-replace'] as const) {
  it(`#9538 ${cause} aborts model properties and a transport ignoring abort cannot publish`, async () => {
    await start();
    const oldSignal = signal;
    await act(async () => {
      if (cause === 'remove') useViewerStore.getState().removeModel('server');
      if (cause === 'clear') useViewerStore.getState().clearAllModels();
      if (cause === 'session-reset') useViewerStore.getState().resetViewerState();
      if (cause === 'reused-id') { useViewerStore.getState().removeModel('server'); useViewerStore.getState().addModel({ ...fixtureModel('server'), sourceFile: file, ifcDataStore: null }); }
      if (cause === 'replace') useViewerStore.getState().updateModel('server', { ifcDataStore: result() });
      if (cause === 'supersede') { stale = true; useViewerStore.setState({ loading: true }); }
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
  await start();
  const job = useActivityJournal.getState().jobs.find(row => row.outcome === 'running');
  assert.ok(job);
  stale = true; // loader identity can change before a store notification
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().ifcDataStore === null, true);
  assert.equal(useActivityJournal.getState().jobs.some(row => row.id === job.id), false, 'superseded work cannot claim a completed activity');
});
it('#9538 fast properties wait for finalization so its null placeholder cannot overwrite them', async () => {
  useViewerStore.getState().updateModel('server', { loadState: 'streaming-geometry' });
  await start();
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().ifcDataStore === null, true);
  await act(async () => { useViewerStore.getState().updateModel('server', { loadState: 'complete', ifcDataStore: null }); });
  assert.equal(useViewerStore.getState().ifcDataStore?.entities.getName(1), 'Server properties');
});

for (const modelId of [null, 'not-registered']) {
  it(`#9538 unregistered model ${modelId} reports why optional properties cannot start`, async () => {
    useViewerStore.getState().clearAllModels();
    const warnings: unknown[][] = [];
    mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
    let hydrations = 0;
    useServerModelProperties().start(modelId, undefined, async () => { hydrations++; return null; });
    assert.equal(hydrations, 0);
    assert.equal(warnings.some(args => String(args[0]).includes('registered model')), true);
  });
}
it('#9538 a missing optional response preserves properties already belonging to the model', async () => {
  const existing = result();
  useViewerStore.getState().updateModel('server', { ifcDataStore: existing });
  const warnings: unknown[][] = [];
  mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async () => null);
  await act(async () => { await api.loadFromServer(file, new ArrayBuffer(1), undefined, undefined, 'server'); await new Promise(resolve => setTimeout(resolve, 200)); });
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

it('#9538 teardown while properties wait for finalization aborts and releases both watchers', async () => {
  useViewerStore.getState().updateModel('server', { loadState: 'streaming-geometry' });
  const subscribe = useViewerStore.subscribe;
  const listeners = new Set<Parameters<typeof subscribe>[0]>();
  mock.method(useViewerStore, 'subscribe', (listener: Parameters<typeof subscribe>[0]) => {
    listeners.add(listener);
    const stop = subscribe(listener);
    return () => { listeners.delete(listener); stop(); };
  });
  await start();
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(listeners.size, 2, 'the slot and finalization barrier are waiting');
  await act(async () => { useViewerStore.getState().removeModel('server'); });
  assert.equal(signal.aborted, true);
  assert.equal(listeners.size, 0, 'abort also releases a pending finalization barrier');
});

it('#9538 the activity tray can cancel model properties after the starting component unmounts', async () => {
  await start();
  await act(async () => { root.render(null); });
  const job = useActivityJournal.getState().jobs.find(job => job.outcome === 'running' && job.phase?.startsWith('Server properties'));
  assert.ok(job, 'the store-owned poll remains visible in the activity tray');
  await act(async () => { cancelActivity(job.id); });
  assert.equal(signal.aborted, true);
  assert.equal(useActivityJournal.getState().jobs.find(row => row.id === job.id)?.outcome, 'cancelled');
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore === null, true);
});

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
    await act(async () => { await api.loadFromServer(file, new ArrayBuffer(1), undefined, undefined, 'server'); await new Promise(resolve => setTimeout(resolve, 200)); });
    assert.equal(calls, included ? 0 : 1);
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore?.entities.getName(1), 'Server properties');
  });
}

it('#9538 follow-up: only the second start on the same live model may publish', async () => {
  const properties = useServerModelProperties();
  let first!: (store: ReturnType<typeof result>) => void;
  let second!: (store: ReturnType<typeof result>) => void;
  let firstSignal!: AbortSignal;
  properties.start('server', undefined, signal => {
    firstSignal = signal;
    return new Promise(resolve => { first = resolve; });
  });
  properties.start('server', undefined, () => new Promise(resolve => { second = resolve; }));
  assert.equal(firstSignal.aborted, true, 'the first lease must lose ownership immediately');
  const discarded = fixtureDataStore([{ expressId: 1, type: 'IfcWall', name: 'Discarded first result' }]);
  await act(async () => { first(discarded); await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore === null, true);
  const current = result();
  await act(async () => { second(current); await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore === current, true);
});
it('#9538 follow-up: starting a server load for another model preserves the first poll', async () => {
  await start();
  const firstSignal = signal;
  const otherFile = new File(['IFC'], 'other.ifc');
  useViewerStore.getState().addModel({ ...fixtureModel('other'), sourceFile: otherFile, ifcDataStore: null, loadState: 'complete' });
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async () => null);
  await act(async () => { await api.loadFromServer(otherFile, new ArrayBuffer(1), undefined, undefined, 'other'); });
  assert.equal(firstSignal.aborted, false, 'only the requested model run may be cancelled');
  await act(async () => { release(wire); await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore?.entities.getName(1), 'Server properties');
  assert.equal(useViewerStore.getState().models.get('other')?.ifcDataStore === null, true);
});
it('#9601 same-model retry aborts the old poll before the new attempt can hydrate', async () => {
  await start(); await pending;
  const oldSignal = signal;
  const parsed = await IfcServerClient.prototype.parse(file);
  let entered!: () => void;
  let resume!: () => void;
  const parsing = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  mock.method(IfcServerClient.prototype, 'parse', async () => { entered(); await held; return parsed; });
  let hydrations = 0;
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async () => { hydrations++; return null; });
  pending = api.loadFromServer(file, new ArrayBuffer(1), undefined, undefined, 'server');
  try {
    await parsing;
    assert.equal(hydrations, 0, 'the retry is still held before optional hydration');
    assert.equal(oldSignal.aborted, true, 'retry cancellation must happen before a later start replaces the lease');
    assert.equal(useViewerStore.getState().models.get('server')?.sourceFile === file, true);
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore === null, true);
  } finally { resume(); await pending; }
});

it('hydration commits the ownership bound and store together once', async () => {
  const { registerModelOffset, updateModel } = useViewerStore.getState();
  updateModel('server', { idOffset: registerModelOffset('server', 1), maxExpressId: 1 });
  const writes: unknown[] = [];
  const original = useViewerStore.getState().updateModel;
  mock.method(useViewerStore.getState(), 'updateModel', (...args: Parameters<typeof original>) => {
    writes.push(args[1]);
    original(...args);
  });
  let commits = 0;
  const stop = useViewerStore.subscribe((state, prev) => { if (state.models !== prev.models) commits++; });
  try {
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => serverStoreAt(100));
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    assert.equal(writes.length, 1);
    assert.equal(commits, 1);
    assert.equal(useViewerStore.getState().models.get('server')?.maxExpressId, 100);
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
  } finally { stop(); federationRegistry.clear(); }
});

it('re-hydration refuses source growth across unpublished authored IDs (#10139)', async () => {
  try {
    federationRegistry.registerModel('server', 100);
    useViewerStore.getState().updateModel('server', { maxExpressId: 100, ifcDataStore: result() });
    const view = getOrCreateMutationView(useViewerStore, 'server')!;
    assert.equal(view.createEntity('IfcMaterial', ['Authored']).expressId, 101);
    const previous = useViewerStore.getState().models.get('server')!.ifcDataStore;
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => serverStoreAt(101));
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    assert.equal(useViewerStore.getState().models.get('server')!.ifcDataStore, previous);
    assert.equal(federationRegistry.getGlobalIdRange('server')!.end, 100);
    assert.ok(view.getNewEntity(101));
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true }, 'refused re-hydration preserves editing on the previous store');
  } finally { useViewerStore.getState().mutationViews.get('server')?.clear(); federationRegistry.clear(); }
});

it('hydration never briefly republishes capacity computed without the allocator (#10139)', async () => {
  try {
    federationRegistry.registerModel('server', 100);
    federationRegistry.registerModel('later', 10);
    useViewerStore.getState().updateModel('server', { maxExpressId: 100, ifcDataStore: result() });
    const view = getOrCreateMutationView(useViewerStore, 'server')!;
    view.setExpressIdWatermark(1_000_100);
    assert.equal(useViewerStore.getState().models.get('server')!.hasOverlayCapacity, false);
    const hydrated = serverStoreAt(100);
    const capacities: boolean[] = [];
    const stop = useViewerStore.subscribe(state => {
      const model = state.models.get('server');
      if (model?.ifcDataStore === hydrated) capacities.push(model.hasOverlayCapacity!);
    });
    try {
      await act(async () => {
        useServerModelProperties().start('server', undefined, async () => hydrated);
        await new Promise(resolve => setTimeout(resolve, 50));
      });
    } finally { stop(); }
    assert.ok(capacities.length > 0);
    assert.equal(capacities.includes(true), false);
  } finally { federationRegistry.clear(); }
});

// #10139: source-derived allocator floors are not authored IDs.
it('re-hydrates after clearAllModels and reuse of a model with an untouched read view', async () => {
  const hydrate = async (max: number) => {
    const store = serverStoreAt(max);
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => store);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, store);
  };
  useViewerStore.getState().updateModel('server', { maxExpressId: 300, idOffset: federationRegistry.registerModel('server', 300) });
  await hydrate(500);
  const view = getOrCreateMutationView(useViewerStore, 'server')!;
  assert.equal(view.peekNextExpressId(), 501);
  useViewerStore.getState().clearAllModels();
  useViewerStore.getState().addModel({ ...fixtureModel('server'), sourceFile: file, ifcDataStore: null,
    maxExpressId: 300, idOffset: federationRegistry.registerModel('server', 300), loadState: 'complete' });
  await hydrate(500);
  assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
});

it('re-hydrates a clamped model even when a read view retains the larger source floor (#10139)', async () => {
  useViewerStore.getState().updateModel('server', { maxExpressId: 1, idOffset: federationRegistry.registerModel('server', 1) });
  federationRegistry.registerModel('later', 10);
  for (const max of [2_000_000, 1_500_000]) {
    const store = serverStoreAt(max);
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => store);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, store);
    getOrCreateMutationView(useViewerStore, 'server');
  }
  assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: false, reason: 'id-space-exhausted' });
});

// #10139: forgotten/undoable creations still own their IDs before publication.
for (const removal of ['delete', 'undo'] as const) for (const higher of [false, true]) {
  it(`refuses hydration across a created-then-${removal} ID${higher ? ' below another creation' : ''} (#10139)`, async () => {
    try {
      federationRegistry.registerModel('server', 100);
      useViewerStore.getState().updateModel('server', { maxExpressId: 100, ifcDataStore: result() });
      const view = getOrCreateMutationView(useViewerStore, 'server')!;
      const entity = view.createEntity('IfcMaterial', ['Authored']);
      assert.equal(entity.expressId, 101);
      if (removal === 'undo') {
        useViewerStore.getState().recordMutationBatch('server', view.getMutationsForEntity(101));
        useViewerStore.getState().undo('server');
        assert.equal(useViewerStore.getState().removedNewEntities.get('server:101')?.expressId, 101);
      } else view.deleteEntity(101);
      if (higher) {
        view.setExpressIdWatermark(500);
        assert.equal(view.createEntity('IfcMaterial', ['Higher']).expressId, 501);
      }
      const previous = useViewerStore.getState().models.get('server')!.ifcDataStore;
      await act(async () => {
        useServerModelProperties().start('server', undefined, async () => serverStoreAt(150));
        await new Promise(resolve => setTimeout(resolve, 30));
      });
      assert.equal(federationRegistry.getGlobalIdRange('server')!.end, 100, 'source IDs cannot swallow a tombstone or undo record');
      assert.equal(useViewerStore.getState().models.get('server')!.ifcDataStore, previous);
      view.restoreNewEntity(entity);
      assert.equal(useViewerStore.getState().toGlobalId('server', 101), 101);
    } finally { useViewerStore.getState().mutationViews.get('server')?.clear(); federationRegistry.clear(); }
  });
}

it('hydrates below retained unpublished creations after clear/reload (#10139)', async () => {
  try {
    federationRegistry.registerModel('server', 300);
    useViewerStore.getState().updateModel('server', { maxExpressId: 300 });
    const hydrate = async () => {
      const store = serverStoreAt(500);
      await act(async () => {
        useServerModelProperties().start('server', undefined, async () => store);
        await new Promise(resolve => setTimeout(resolve, 30));
      });
      assert.equal(useViewerStore.getState().models.get('server')!.ifcDataStore, store);
    };
    await hydrate();
    const view = getOrCreateMutationView(useViewerStore, 'server')!;
    assert.equal(view.createEntity('IfcMaterial', ['Retained']).expressId, 501);
    useViewerStore.getState().clearAllModels();
    assert.equal(useViewerStore.getState().mutationViews.get('server'), view);
    useViewerStore.getState().addModel({ ...fixtureModel('server'), sourceFile: file, ifcDataStore: null,
      maxExpressId: 300, idOffset: federationRegistry.registerModel('server', 300), loadState: 'complete' });
    await hydrate();
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
    assert.equal(useViewerStore.getState().toGlobalId('server', 501), 501);
    assert.equal(view.createEntity('IfcMaterial', ['Next']).expressId, 502);
  } finally { useViewerStore.getState().mutationViews.get('server')?.clear(); federationRegistry.clear(); }
});

for (const previousKind of ['cancelled', 'running'] as const) it(`a refused refresh of a ${previousKind} run keeps loaded properties editable and reports refusal in the tray (#10139)`, async () => {
  try {
    federationRegistry.registerModel('server', 100);
    useViewerStore.getState().updateModel('server', { maxExpressId: 100, ifcDataStore: result() });
    const view = getOrCreateMutationView(useViewerStore, 'server')!;
    view.createEntity('IfcMaterial', ['Authored']);
    useViewerStore.getState().setServerPropertiesRun('server', previousKind === 'running'
      ? { kind: 'running', runId: 99, owner: { model: useViewerStore.getState().models.get('server')! } }
      : { kind: 'cancelled', runId: 99, reason: 'user' });
    const previous = useViewerStore.getState().models.get('server')!.ifcDataStore;
    let deliver!: () => void;
    await act(async () => {
      useServerModelProperties().start('server', undefined, () => new Promise(resolve => { deliver = () => resolve(serverStoreAt(150)); }));
    });
    const job = useActivityJournal.getState().jobs.find(row => row.outcome === 'running' && row.phase?.startsWith('Server properties'))!;
    assert.ok(job);
    await act(async () => { deliver(); await new Promise(resolve => setTimeout(resolve, 30)); });
    assert.equal(useViewerStore.getState().models.get('server')!.ifcDataStore, previous);
    assert.equal(useViewerStore.getState().serverPropertiesRuns.get('server')?.kind ?? 'idle', previousKind === 'running' ? 'idle' : previousKind);
    const row = useActivityJournal.getState().jobs.find(row => row.id === job.id)!;
    assert.equal(row.outcome, 'failed');
    assert.match(row.detail!, /refused/i);
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
  } finally { useViewerStore.getState().mutationViews.get('server')?.clear(); federationRegistry.clear(); }
});

it('discards unchanged views in one store commit, retaining pending edits (#10139)', () => {
  const state = useViewerStore.getState();
  for (const id of ['clean-a', 'clean-b', 'dirty']) {
    state.addModel({ ...fixtureModel(id), ifcDataStore: result() });
    getOrCreateMutationView(useViewerStore, id);
  }
  const dirty = useViewerStore.getState().mutationViews.get('dirty')!;
  dirty.createEntity('IfcMaterial', ['Pending']);
  let commits = 0;
  const stop = useViewerStore.subscribe((next, prev) => { if (next.mutationViews !== prev.mutationViews) commits++; });
  try { discardUnchangedMutationViews(useViewerStore.getState()); } finally { stop(); }
  assert.equal(commits, 1);
  assert.equal(useViewerStore.getState().mutationViews.has('clean-a'), false);
  assert.equal(useViewerStore.getState().mutationViews.has('clean-b'), false);
  assert.equal(useViewerStore.getState().mutationViews.get('dirty'), dirty);
  dirty.clear();
});


it('source deletion survives clear/reload without blocking hydration (#10139)', async () => {
  try {
    useViewerStore.getState().updateModel('server', { maxExpressId: 300, idOffset: federationRegistry.registerModel('server', 300) });
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => serverStoreAt(500));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    const view = getOrCreateMutationView(useViewerStore, 'server')!;
    view.deleteEntity(500); // Non-meshed SOURCE entity, never created by this overlay.
    useViewerStore.getState().clearAllModels();
    assert.equal(useViewerStore.getState().mutationViews.get('server'), view);
    useViewerStore.getState().addModel({ ...fixtureModel('server'), sourceFile: file, ifcDataStore: null,
      maxExpressId: 300, idOffset: federationRegistry.registerModel('server', 300), loadState: 'complete' });
    const hydrated = serverStoreAt(500);
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => hydrated);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, hydrated);
    assert.equal(view.isDeleted(500), true);
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
  } finally { useViewerStore.getState().mutationViews.get('server')?.clear(); federationRegistry.clear(); }
});

for (const previousKind of ['idle', 'succeeded', 'failed'] as const) {
  it(`a refused refresh restores ${previousKind} in one run commit without a transient lock (#10139)`, async () => {
    try {
      federationRegistry.registerModel('server', 100);
      useViewerStore.getState().updateModel('server', { maxExpressId: 100, ifcDataStore: result() });
      getOrCreateMutationView(useViewerStore, 'server')!.createEntity('IfcMaterial', ['Retained']);
      const previous = previousKind === 'idle' ? { kind: 'idle' as const }
        : previousKind === 'succeeded' ? { kind: 'succeeded' as const, runId: 23, result: undefined }
        : { kind: 'failed' as const, runId: 23, error: 'Previous failure' };
      useViewerStore.getState().setServerPropertiesRun('server', previous);
      let deliver!: () => void;
      useServerModelProperties().start('server', undefined, () => new Promise(resolve => { deliver = () => resolve(serverStoreAt(150)); }));
      const job = useActivityJournal.getState().jobs.find(row => row.outcome === 'running' && row.phase?.startsWith('Server properties'))!;
      const observed: unknown[] = [];
      const stop = useViewerStore.subscribe((next, prev) => {
        if (next.serverPropertiesRuns !== prev.serverPropertiesRuns) observed.push(next.serverPropertiesRuns.get('server') ?? { kind: 'idle' });
      });
      try { await act(async () => { deliver(); await new Promise(resolve => setTimeout(resolve, 30)); }); }
      finally { stop(); }
      assert.deepEqual(observed, [previous], 'subscribers must see exactly the restored run, with no intermediate failure');
      const row = useActivityJournal.getState().jobs.find(row => row.id === job.id)!;
      assert.equal(row.outcome, 'failed');
      assert.match(row.detail!, /refused/i);
    } finally { useViewerStore.getState().mutationViews.get('server')?.clear(); federationRegistry.clear(); }
  });
}

it('retained 1001..1005 stay publishable after reload with source max 990 (#10139)', async () => {
  try {
    federationRegistry.registerModel('server', 1000);
    useViewerStore.getState().updateModel('server', { maxExpressId: 1000, ifcDataStore: serverStoreAt(1000) });
    const view = getOrCreateMutationView(useViewerStore, 'server')!;
    for (let id = 1001; id <= 1005; id++) assert.equal(view.createEntity('IfcMaterial', ['Retained']).expressId, id);
    useViewerStore.getState().clearAllModels();
    useViewerStore.getState().addModel({ ...fixtureModel('server'), sourceFile: file, ifcDataStore: null,
      maxExpressId: 300, idOffset: federationRegistry.registerModel('server', 300), loadState: 'complete' });
    const hydrated = serverStoreAt(990);
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => hydrated);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, hydrated);
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
    for (let id = 1001; id <= 1005; id++) assert.equal(useViewerStore.getState().toGlobalId('server', id), id);
    assert.equal(view.createEntity('IfcMaterial', ['Next']).expressId, 1006, 'reserved unused IDs cannot be allocated again');
    assert.equal(useViewerStore.getState().toGlobalId('server', 1006), 1006);
  } finally { useViewerStore.getState().mutationViews.get('server')?.clear(); federationRegistry.clear(); }
});

it('batched view clear notifies once and preserves unrelated pending work (#10139)', () => {
  for (const id of ['server', 'other', 'keep']) {
    useViewerStore.getState().addModel({ ...fixtureModel(id), ifcDataStore: result() });
    getOrCreateMutationView(useViewerStore, id)!.createEntity('IfcMaterial', [id]);
  }
  const kept = useViewerStore.getState().mutationViews.get('keep')!;
  let notifications = 0;
  const stop = useViewerStore.subscribe(() => { notifications++; });
  try { useViewerStore.getState().clearMutationView(['server', 'other']); }
  finally { stop(); }
  assert.equal(notifications, 1);
  assert.equal(useViewerStore.getState().mutationViews.has('server'), false);
  assert.equal(useViewerStore.getState().mutationViews.has('other'), false);
  assert.equal(kept.getNewEntityCount(), 1);
  assert.equal(useViewerStore.getState().toGlobalId('keep', kept.readNewEntities()[0].expressId), kept.readNewEntities()[0].expressId);
  kept.clear();
});

for (const provisional of [false, true]) for (const sourceMax of [990, 1003, 2000]) it(`${provisional ? 'LandXML' : 'local'} reload with source max ${sourceMax} preserves loadability with retained creations (#10139)`, () => {
  const warnings: unknown[][] = [];
  mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  try {
    const state = useViewerStore.getState();
    state.updateModel('server', { idOffset: state.registerModelOffset('server', 1000), maxExpressId: 1000, ifcDataStore: serverStoreAt(1000) });
    const view = getOrCreateMutationView(useViewerStore, 'server')!;
    for (let id = 1001; id <= 1005; id++) assert.equal(view.createEntity('IfcMaterial', ['Retained']).expressId, id);
    state.clearAllModels();
    if (provisional) {
      const transaction = new LandXmlProvisionalTransaction('server', sourceMax, {
        originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      }, federationRegistry, { publish: () => {}, remove: () => {} });
      for (let expressId = 1; expressId <= sourceMax; expressId++) transaction.skip({ expressId });
      transaction.commit();
    }
    const idOffset = useViewerStore.getState().registerModelOffset('server', sourceMax);
    const source = serverStoreAt(sourceMax);
    useViewerStore.getState().addModel({ ...fixtureModel('server'), idOffset, maxExpressId: sourceMax, ifcDataStore: source });
    assert.equal(useViewerStore.getState().models.get('server')!.ifcDataStore, source);
    if (sourceMax >= 1001) {
      // Kept creations would shadow source entities with the same IDs on read and export.
      assert.equal(useViewerStore.getState().mutationViews.has('server'), false, 'overlapping kept edits are discarded');
      assert.ok(warnings.some(args => /Discarded kept edits of model server/.test(String(args[0]))));
      assert.equal(federationRegistry.getGlobalIdRange('server')!.end, idOffset + sourceMax, 'only source ownership is published');
      assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
    } else {
      for (let id = 1001; id <= 1005; id++) assert.equal(useViewerStore.getState().toGlobalId('server', id), idOffset + id);
      assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
    }
  } finally { useViewerStore.getState().mutationViews.get('server')?.clear(); federationRegistry.clear(); }
});

it('first hydration discards kept creations the source overlaps and loads properties (#10139)', async () => {
  mock.method(console, 'warn', () => {});
  const idOffset = federationRegistry.registerModel('server', 100);
  useViewerStore.getState().updateModel('server', { idOffset, maxExpressId: 100 });
  const retained = new MutablePropertyView(null, 'server');
  retained.setExpressIdWatermark(100);
  retained.createEntity('IfcMaterial', ['Retained']);
  useViewerStore.setState({ mutationViews: new Map([['server', retained]]) });
  const source = serverStoreAt(150);
  await act(async () => {
    useServerModelProperties().start('server', undefined, async () => source);
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.equal(useViewerStore.getState().serverPropertiesRuns.get('server')?.kind, 'succeeded');
  assert.equal(useViewerStore.getState().mutationViews.has('server'), false);
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, source);
  assert.equal(federationRegistry.getGlobalIdRange('server')!.end, idOffset + 150);
  assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
});

it('first hydration refusal is labelled hydration, not re-hydration (#10139)', async () => {
  federationRegistry.reserveModel('server', 100);
  await act(async () => {
    useServerModelProperties().start('server', undefined, async () => serverStoreAt(150));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  const run = useViewerStore.getState().serverPropertiesRuns.get('server');
  assert.equal(run?.kind, 'failed');
  assert.match(run?.kind === 'failed' ? run.error : '', /^Server properties hydration refused:/);
});

for (const failure of ['update', 'refresher', 'listener', 'listener-refusal'] as const) it(`a throwing ${failure} after ownership growth cannot restore the previous editable run (#10139)`, async () => {
  federationRegistry.registerModel('server', 100, failure.startsWith('listener') ? 501 : 0);
  useViewerStore.getState().updateModel('server', { maxExpressId: 100, ifcDataStore: result() });
  useViewerStore.getState().setServerPropertiesRun('server', { kind: 'succeeded', runId: 42, result: undefined });
  const originalUpdate = useViewerStore.getState().updateModel;
  if (failure === 'update') useViewerStore.setState({ updateModel: () => { throw new Error('Update failed'); } });
  else if (failure.startsWith('listener')) {
    const stop = federationRegistry.subscribe(() => {
      stop();
      // A reentrant validation refusal still happens AFTER the outer growth.
      if (failure === 'listener-refusal') federationRegistry.extendModel('unknown', 1);
      throw new Error('Range listener failed');
    });
  } else {
    // A separately registered capacity observer throws in the deferred finally.
    // Its model has no source swap, so hydration still owns the main model.
    const view = new MutablePropertyView(null, 'server');
    const observer = createStore(() => ({ ...useViewerStore.getState(), mutationViews: new Map([['server', view]]) }));
    stopObserver = registerOverlayCapacity(observer);
    const configure = view.configureExpressIdAllocator.bind(view);
    let thrown = false;
    mock.method(view, 'configureExpressIdAllocator', (...args: Parameters<typeof configure>) => {
      if (!thrown) { thrown = true; throw new Error('Refresher failed'); }
      configure(...args);
    });
  }
  try {
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => serverStoreAt(500));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
  } finally { useViewerStore.setState({ updateModel: originalUpdate }); }
  const model = useViewerStore.getState().models.get('server')!;
  const run = useViewerStore.getState().serverPropertiesRuns.get('server');
  assert.equal(run?.kind, 'failed', 'a post-extension error must not restore success');
  assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: false, reason: 'properties-failed' });
  assert.equal(federationRegistry.getGlobalIdRange('server')!.end - model.idOffset, 500, 'the failure follows actual ownership growth');
});

it('clamped hydration loads properties while retained creations stay unpublishable (#10139)', async () => {
  try {
    federationRegistry.registerModel('server', 300);
    useViewerStore.getState().updateModel('server', { maxExpressId: 300, ifcDataStore: serverStoreAt(2_000_000) });
    const view = getOrCreateMutationView(useViewerStore, 'server')!;
    assert.equal(view.createEntity('IfcMaterial', ['Retained']).expressId, 2_000_001);
    useViewerStore.getState().clearAllModels();
    const idOffset = useViewerStore.getState().registerModelOffset('server', 300);
    useViewerStore.getState().addModel({ ...fixtureModel('server'), sourceFile: file, ifcDataStore: null,
      maxExpressId: 300, idOffset, loadState: 'complete' });
    federationRegistry.registerModel('later', 10);
    const hydrated = serverStoreAt(2_000_000);
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => hydrated);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, hydrated);
    assert.equal(useViewerStore.getState().models.get('server')?.maxExpressId, 1_000_300);
    assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: false, reason: 'id-space-exhausted' });
    assert.throws(() => useViewerStore.getState().toGlobalId('server', 2_000_001));
  } finally { useViewerStore.getState().mutationViews.get('server')?.clear(); federationRegistry.clear(); }
});

for (const detail of ['Network unavailable', 'Decode failed']) it(`failed refresh preserves the loaded store and permission: ${detail} (#10139)`, async () => {
  const previous = { kind: 'succeeded' as const, runId: 42, result: undefined };
  const store = result();
  useViewerStore.getState().updateModel('server', { ifcDataStore: store });
  useViewerStore.getState().setServerPropertiesRun('server', previous);
  let jobId: string;
  await act(async () => {
    useServerModelProperties().start('server', undefined, async () => { throw new Error(detail); });
    jobId = useActivityJournal.getState().jobs.find(row => row.outcome === 'running' && row.phase?.startsWith('Server properties'))!.id;
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, store);
  assert.deepEqual(useViewerStore.getState().serverPropertiesRuns.get('server'), previous);
  assert.deepEqual(dataMutationPermission(useViewerStore.getState(), 'server'), { allowed: true });
  const row = useActivityJournal.getState().jobs.find(row => row.id === jobId)!;
  assert.equal(row.outcome, 'failed');
  assert.equal(row.detail, detail);
});

it('a commit that throws before the store swap fails the run even when capacity then changes (#10139)', async () => {
  const originalUpdate = useViewerStore.getState().updateModel;
  try {
    const { registerModelOffset, updateModel } = useViewerStore.getState();
    updateModel('server', { idOffset: registerModelOffset('server', 1), maxExpressId: 1, ifcDataStore: result() });
    registerModelOffset('later', 10);
    useViewerStore.getState().setServerPropertiesRun('server', { kind: 'succeeded', runId: 42, result: undefined });
    assert.notEqual(useViewerStore.getState().models.get('server')!.hasOverlayCapacity, false);
    assert.equal(federationRegistry.hasOverlayCapacity('server', 2), true, 'the range starts with room for edits');
    useViewerStore.setState({ updateModel: () => { throw new Error('Update failed'); } });
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => serverStoreAt(1_000_001));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.equal(useViewerStore.getState().models.get('server')!.hasOverlayCapacity, false, 'the deferred refresher committed a capacity change');
    assert.equal(useViewerStore.getState().serverPropertiesRuns.get('server')?.kind, 'failed');
  } finally { useViewerStore.setState({ updateModel: originalUpdate }); }
});

it('a refresh that fails before ownership changes keeps loaded properties editable (#10139)', async () => {
  const { registerModelOffset, updateModel } = useViewerStore.getState();
  const store = result();
  const idOffset = registerModelOffset('server', 1);
  updateModel('server', { idOffset, maxExpressId: 1, ifcDataStore: store });
  const previous = { kind: 'succeeded' as const, runId: 42, result: undefined };
  useViewerStore.getState().setServerPropertiesRun('server', previous);
  const view = new MutablePropertyView(null, 'server');
  const bounds = view.getCreatedExpressIdBounds.bind(view);
  let fail = false;
  mock.method(view, 'getCreatedExpressIdBounds', () => { if (fail) throw new Error('Bounds failed'); return bounds(); });
  useViewerStore.setState({ mutationViews: new Map([['server', view]]) });
  fail = true;
  await act(async () => {
    useServerModelProperties().start('server', undefined, async () => serverStoreAt(50));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  fail = false;
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, store);
  assert.deepEqual(useViewerStore.getState().serverPropertiesRuns.get('server'), previous);
  assert.equal(federationRegistry.getGlobalIdRange('server')!.end - idOffset, 1, 'ownership is untouched');
});

it('first hydration keeps kept edits when the registry refuses the source (#10139)', async () => {
  const idOffset = federationRegistry.registerModel('server', 990, 1001);
  useViewerStore.getState().updateModel('server', { idOffset, maxExpressId: 1000 });
  const retained = new MutablePropertyView(null, 'server');
  retained.setExpressIdWatermark(1000);
  retained.createEntity('IfcMaterial', ['Retained']);
  useViewerStore.setState({ mutationViews: new Map([['server', retained]]) });
  federationRegistry.publishOverlayRange('server', 1001, 1001);
  await act(async () => {
    useServerModelProperties().start('server', undefined, async () => serverStoreAt(1003));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  const run = useViewerStore.getState().serverPropertiesRuns.get('server');
  assert.match(run?.kind === 'failed' ? run.error : '', /^Server properties hydration refused:/);
  assert.equal(useViewerStore.getState().mutationViews.get('server'), retained, 'a refused source discards nothing');
});

it('first hydration discards overlapped kept edits when a range listener fails after ownership grew (#10139)', async () => {
  mock.method(console, 'warn', () => {});
  const idOffset = federationRegistry.registerModel('server', 100);
  useViewerStore.getState().updateModel('server', { idOffset, maxExpressId: 100 });
  const retained = new MutablePropertyView(null, 'server');
  retained.setExpressIdWatermark(100);
  retained.createEntity('IfcMaterial', ['Retained']);
  useViewerStore.setState({ mutationViews: new Map([['server', retained]]) });
  let thrown = false;
  const stop = federationRegistry.subscribe(() => {
    if (!thrown) { thrown = true; throw new Error('Range notification failed after ownership changed'); }
  });
  try {
    await act(async () => {
      useServerModelProperties().start('server', undefined, async () => serverStoreAt(150));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
  } finally { stop(); }
  assert.equal(thrown, true);
  assert.equal(federationRegistry.getGlobalIdRange('server')!.end, idOffset + 150, 'setup: the source owns the overlapped ids');
  assert.equal(useViewerStore.getState().serverPropertiesRuns.get('server')?.kind, 'failed');
  assert.equal(useViewerStore.getState().mutationViews.has('server'), false, 'no kept creation aliases a source id');
});

it('an unregistered primary drops kept edits only together with a committed source (#10139)', async () => {
  mock.method(console, 'warn', () => {});
  const retained = new MutablePropertyView(null, 'server');
  retained.createEntity('IfcMaterial', ['Retained']);
  useViewerStore.setState({ mutationViews: new Map([['server', retained]]) });
  // Supersession lands on the first view change, as a store reaction to a discard could.
  let stale = false;
  const stop = useViewerStore.subscribe((state, previous) => { if (state.mutationViews !== previous.mutationViews) stale = true; });
  const source = serverStoreAt(150);
  try {
    await act(async () => {
      useServerModelProperties().start('server', () => stale, async () => source);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
  } finally { stop(); }
  assert.equal(federationRegistry.hasModel('server'), false);
  const state = useViewerStore.getState();
  assert.equal(state.models.get('server')?.ifcDataStore, source, 'no discard lands before the commit, so the run is not superseded');
  assert.equal(state.mutationViews.has('server'), false, 'the committed source drops the overlapped edits');
});

it('an unregistered primary refuses a refresh across in-session creations (#10139)', async () => {
  const store = result();
  useViewerStore.getState().updateModel('server', { maxExpressId: 1, ifcDataStore: store });
  const previous = { kind: 'succeeded' as const, runId: 42, result: undefined };
  useViewerStore.getState().setServerPropertiesRun('server', previous);
  const view = getOrCreateMutationView(useViewerStore, 'server')!;
  const created = view.createEntity('IfcMaterial', ['Session']).expressId;
  await act(async () => {
    useServerModelProperties().start('server', undefined, async () => serverStoreAt(created + 10));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.equal(federationRegistry.hasModel('server'), false);
  assert.equal(useViewerStore.getState().models.get('server')?.ifcDataStore, store);
  assert.equal(useViewerStore.getState().mutationViews.get('server'), view);
  assert.deepEqual(useViewerStore.getState().serverPropertiesRuns.get('server'), previous);
});
