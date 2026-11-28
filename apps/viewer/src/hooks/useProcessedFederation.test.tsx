/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A federation of processed models (`open.federation`): every slot opened by
 * hash from the processing server, the first as the primary model and the
 * rest as federated models through the one load path.
 *
 * Driven through the same entry a host uses (`applyProcessingConfig` and the
 * mounted autoload), so each test pins what a host sees: which models are
 * listed, in which ID ranges, with which properties, placement and visibility.
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
(globalThis as unknown as { __VITE_ENV__?: Record<string, unknown> }).__VITE_ENV__ = {
  MODE: 'test', DEV: false, PROD: false, VITE_IFC_SERVER_URL: 'http://localhost:9999',
};
import { beforeEach, afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { federationRegistry } from '@ifc-lite/renderer';
import { IfcServerClient, IfcServerError, type HealthResponse, type ParquetParseResponse, type ProcessedModelRef } from '@ifc-lite/server-client';
import { useViewerStore } from '@/store';
import { waitFor } from '@/test/render.js';
import { deferred } from '@/test/race.js';
import { propertyModelBuffer } from '../../../../packages/server-client/test/fixtures/property-model.js';
const { useProcessedModelAutoload } = await import('./useProcessedModelAutoload.js');
const { applyProcessingConfig, resetProcessedModelRequestsForTests, setProcessingServerUrl } = await import('@/lib/processed-model');

const hash = (c: string) => c.repeat(64);
/** One meshed wall (#1); the data model adds a project (#2) and property sets (#10, #11) with no mesh. */
const stored = (sha256: string, x = 0): ParquetParseResponse => ({
  meshes: [{
    express_id: 1, ifc_type: 'IFCWALL',
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.25, 0.125, 1],
  }],
  cache_key: `${sha256}-key`,
  metadata: { schema_version: 'IFC4', entity_count: 2, geometry_entity_count: 1, coordinate_info: { origin_shift: [0, 0, 0], is_geo_referenced: false } },
  stats: { total_meshes: 1, total_vertices: 3, total_triangles: 1, parse_time_ms: 1, geometry_time_ms: 1, total_time_ms: 2, from_cache: true },
  parquet_stats: { payload_size: 0, decode_time_ms: 0 },
  data_model: propertyModelBuffer(),
});

const slot = (id: string, c: string, over: Record<string, unknown> = {}) => ({
  slot: id, label: `Label ${id}`, sha256: hash(c), bytes: 1_000_000, name: `${id}.ifc`, visible: true, ...over,
});

let root: Root, container: HTMLDivElement;
let asked: string[], engineInits: number;
let respond: (sha256: string) => Promise<ParquetParseResponse>;
let restoreGpu: (() => void) | undefined;
function Entry() { useProcessedModelAutoload(); return null; }
const models = () => useViewerStore.getState().models;
/** Registered with its geometry. A federated record carries no `loadState`, like a local federated add; a primary's is 'complete'. */
const loaded = (id: string) => { const m = models().get(id); return !!m && m.loadState !== 'error' && m.geometryResult != null; };

beforeEach(() => {
  asked = []; engineInits = 0;
  respond = async sha256 => stored(sha256);
  useViewerStore.getState().resetViewerState(); useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ error: null, lastLoadRetry: null });
  mock.method(IfcServerClient.prototype, 'health', async () => ({ status: 'ok' }) as HealthResponse);
  mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => true);
  mock.method(IfcServerClient.prototype, 'parseParquet', async (source: ProcessedModelRef) => { asked.push(source.sha256); return respond(source.sha256); });
  for (const upload of ['parse', 'parseParquetStream'] as const) {
    mock.method(IfcServerClient.prototype, upload, async () => { throw new Error('a processed model must not take this route'); });
  }
  mock.method(GeometryProcessor.prototype, 'init', async () => { engineInits++; throw new Error('local engine sentinel'); });
  const original = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(), limits: {} }) } });
  restoreGpu = () => { if (original) Object.defineProperty(navigator, 'gpu', original); else Reflect.deleteProperty(navigator, 'gpu'); };
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  useViewerStore.getState().activeLoadCanceller?.();
  await act(async () => root.unmount()); container.remove(); mock.restoreAll();
  restoreGpu?.(); restoreGpu = undefined;
  resetProcessedModelRequestsForTests(); setProcessingServerUrl('http://localhost:9999');
  useViewerStore.getState().clearAllModels();
});

async function openFederation(slots: ReturnType<typeof slot>[], settled: (ids: string[]) => boolean = ids => ids.length === slots.length) {
  applyProcessingConfig({ open: { federation: { id: 'workspace', slots } } });
  await act(async () => { root.render(<Entry />); });
  await act(async () => {
    await waitFor(() => settled([...models().values()].filter(m => loaded(m.id) || m.loadState === 'error').map(m => m.id)), 'every slot settles');
  });
}

it('opens every slot by hash, the first as the primary, each in its own ID range with its properties', async () => {
  await openFederation([slot('arch', 'a'), slot('struct', 'b'), slot('mep', 'c')]);

  assert.deepEqual([...models().keys()].sort(), ['arch', 'mep', 'struct'], 'each model keeps its slot id as its id');
  assert.equal(asked[0], hash('a'), 'the primary is asked for first');
  assert.deepEqual([...asked].sort(), [hash('a'), hash('b'), hash('c')]);
  assert.equal(engineInits, 0, 'no slot reaches the local engine');
  for (const id of ['arch', 'struct', 'mep']) {
    const model = models().get(id)!;
    assert.ok(loaded(id), id);
    assert.equal(model.name, `Label ${id}`, 'the model list shows the slot label');
    assert.equal(model.sourceFile, undefined, 'no slot has source bytes here');
    assert.equal(model.processedModel?.sha256, hash({ arch: 'a', struct: 'b', mep: 'c' }[id]!));
    assert.ok(model.ifcDataStore, `${id} is registered with its properties`);
  }

  // Disjoint ranges, and each one covers the entity without geometry (project #2, above the one meshed id):
  // a federated slot registers from its store, so a later slot can never take that id.
  const ranges = ['struct', 'mep'].map(id => ({ id, offset: federationRegistry.getOffset(id)!, max: models().get(id)!.maxExpressId }));
  assert.ok(ranges.every(r => r.offset > 0 && r.max >= 2), JSON.stringify(ranges));
  // The primary registers from its one mesh; the others waited for its properties, so its range grew to #2 first.
  assert.ok(models().get('arch')!.maxExpressId >= 2 && ranges.every(r => r.offset > models().get('arch')!.maxExpressId), 'the primary keeps its project id');
  assert.deepEqual(useViewerStore.getState().resolveGlobalIdFromModels(2), { modelId: 'arch', expressId: 2 });
  assert.ok(ranges[0].offset + ranges[0].max < ranges[1].offset || ranges[1].offset + ranges[1].max < ranges[0].offset, 'ranges do not overlap');
  const state = useViewerStore.getState();
  for (const { id, offset } of ranges) {
    for (const expressId of [1, 2]) {
      const globalId = state.toGlobalId(id, expressId);
      assert.equal(globalId, offset + expressId);
      // Selection, picking and properties resolve a global id back through the models.
      assert.deepEqual(state.resolveGlobalIdFromModels(globalId), { modelId: id, expressId });
    }
    assert.equal(models().get(id)!.ifcDataStore!.entities.getName(2), 'Project', 'properties of an entity without geometry');
    // Mesh ids moved into the global space with the model.
    assert.equal(models().get(id)!.geometryResult!.meshes[0].expressId, offset + 1);
  }
  // The active slot is still the primary's; no federated slot wrote into it.
  assert.equal(state.activeModelId, 'arch');
  assert.equal(state.geometryResult, models().get('arch')!.geometryResult);
});

it('lists a failed slot as failed beside the loaded ones, and Retry loads just that slot', async () => {
  let failStruct = true;
  const mepGate = deferred<ParquetParseResponse>();
  respond = async sha256 => {
    if (sha256 === hash('b') && failStruct) throw new IfcServerError('overloaded', 503, 'OVERLOADED');
    if (sha256 === hash('c')) return mepGate.promise;
    return stored(sha256);
  };
  mock.method(console, 'warn', () => {});
  applyProcessingConfig({ open: { federation: { id: 'workspace', slots: [slot('arch', 'a'), slot('struct', 'b'), slot('mep', 'c')] } } });
  await act(async () => { root.render(<Entry />); });
  await act(async () => { await waitFor(() => models().get('struct')?.loadState === 'error', 'the second slot fails'); });

  const failed = models().get('struct')!;
  assert.match(failed.loadError ?? '', /busy/);
  assert.equal(failed.name, 'Label struct');
  assert.equal(failed.geometryResult, null);
  assert.equal(federationRegistry.getOffset('struct'), null, 'a failed slot owns no ids');
  assert.ok(loaded('arch'));
  const retry = useViewerStore.getState().lastLoadRetry;
  assert.equal(typeof retry, 'function', 'a busy server is worth retrying');

  await act(async () => { mepGate.resolve(stored(hash('c'))); });
  await act(async () => { await waitFor(() => loaded('mep'), 'a later slot is not blocked by the failure'); });

  failStruct = false;
  const before = asked.length;
  await act(async () => { retry!(); });
  await act(async () => { await waitFor(() => loaded('struct'), 'the retried slot loads'); });
  assert.deepEqual(asked.slice(before), [hash('b')], 'Retry asks for that slot only');
  assert.ok(federationRegistry.getOffset('struct')! > 0);
  assert.equal(models().size, 3);
  assert.ok(loaded('mep'), 'retrying one slot leaves the others loaded');
});

it('loads the primary first, then at most two slots at a time', async () => {
  const pending = new Map<string, ReturnType<typeof deferred<ParquetParseResponse>>>();
  let inFlight = 0, most = 0;
  const order: string[] = [];
  respond = async sha256 => {
    inFlight++; most = Math.max(most, inFlight); order.push(sha256);
    const gate = deferred<ParquetParseResponse>();
    pending.set(sha256, gate);
    try { return await gate.promise; } finally { inFlight--; }
  };
  const slots = ['a', 'b', 'c', 'd', 'e'].map(c => slot(`s${c}`, c));
  applyProcessingConfig({ open: { federation: { id: 'workspace', slots } } });
  await act(async () => { root.render(<Entry />); });
  await act(async () => { await waitFor(() => pending.has(hash('a')), 'the primary is requested'); });
  assert.equal(pending.size, 1, 'no other slot starts while the primary loads');
  await act(async () => { pending.get(hash('a'))!.resolve(stored(hash('a'))); });
  // Release the rest one at a time, in whatever order they were asked for.
  for (let released = 1; released < slots.length; released++) {
    await act(async () => { await waitFor(() => order.length > released, `slot ${released} is requested`); });
    await act(async () => { pending.get(order[released])!.resolve(stored(order[released])); });
  }
  await act(async () => { await waitFor(() => [...models().values()].filter(m => loaded(m.id)).length === slots.length, 'every slot loads'); });
  assert.equal(order[0], hash('a'));
  assert.equal(most, 2, 'two slots at a time, never more');
});

it('applies each slot visibility and transform, and keeps a slot without a transform where it is', async () => {
  // A quarter turn about the vertical axis, then 10 m east and 2 m up (column-major, metres, Z-up).
  const turned = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 0, 2, 1];
  await openFederation([
    slot('arch', 'a', { visible: false, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1] }),
    slot('struct', 'b', { visible: false, transform: turned }),
    slot('mep', 'c'),
  ]);
  assert.equal(models().get('arch')!.visible, false, 'the primary follows its slot too');
  assert.equal(models().get('struct')!.visible, false);
  assert.equal(models().get('mep')!.visible, true);
  const placements = useViewerStore.getState().modelPlacement.placements;
  assert.deepEqual(placements.get('arch')?.translation, [3, 4, 5]);
  assert.equal(placements.get('arch')?.rotation.angle, 0);
  assert.deepEqual(placements.get('struct')?.translation, [10, 0, 2]);
  assert.ok(Math.abs((placements.get('struct')?.rotation.angle ?? 0) - Math.PI / 2) < 1e-12);
  assert.equal(placements.has('mep'), false);
  assert.equal(useViewerStore.getState().modelPlacement.undo.length, 0, 'a host placement is the starting state, not an undoable move');
});

it('a slot that fails mid-federation never blocks the next: properties unavailable is a failure of that slot only', async () => {
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async () => null);
  respond = async sha256 => ({ ...stored(sha256), ...(sha256 === hash('b') ? { data_model: new ArrayBuffer(0) } : {}) });
  mock.method(console, 'warn', () => {});
  await openFederation([slot('arch', 'a'), slot('struct', 'b'), slot('mep', 'c')]);
  assert.equal(models().get('struct')!.loadState, 'error');
  assert.match(models().get('struct')!.loadError ?? '', /properties/);
  assert.equal(federationRegistry.getOffset('struct'), null);
  assert.equal(typeof useViewerStore.getState().lastLoadRetry, 'function', 'the server may still be writing them: Retry is offered');
  assert.ok(loaded('mep'));
});

it('a newer primary load replaces the federation: slots not yet started never start', async () => {
  const gate = deferred<ParquetParseResponse>();
  // Both lanes stay busy, so the fourth slot is still waiting when the user opens another model.
  respond = async sha256 => (sha256 === hash('b') || sha256 === hash('c') ? gate.promise : stored(sha256));
  const slots = [slot('arch', 'a'), slot('struct', 'b'), slot('mep', 'c'), slot('fire', 'd')];
  applyProcessingConfig({ open: { federation: { id: 'workspace', slots } } });
  await act(async () => { root.render(<Entry />); });
  await act(async () => { await waitFor(() => asked.includes(hash('b')) && asked.includes(hash('c')), 'both lanes are busy'); });
  // The user opens another stored model as the primary: the federation is replaced.
  const { openProcessedModel } = await import('@/lib/processed-model');
  await act(async () => { openProcessedModel({ sha256: hash('f'), bytes: 1, name: 'other.ifc' }); });
  await act(async () => { gate.resolve(stored(hash('b'))); });
  await act(async () => { await waitFor(() => [...models().values()].some(m => m.processedModel?.sha256 === hash('f') && m.loadState === 'complete'), 'the newer primary loads'); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(asked.includes(hash('d')), false, 'a slot that had not started does not start after the federation was replaced');
  assert.equal(models().has('fire'), false);
});
