/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
(globalThis as unknown as { __VITE_ENV__?: Record<string, unknown> }).__VITE_ENV__ = {
  MODE: 'test', DEV: false, PROD: false, VITE_IFC_SERVER_URL: 'http://localhost:9999', VITE_USE_SERVER: 'true',
};
import { beforeEach, afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { zipSync, strToU8 } from 'fflate';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { IfcServerClient, type HealthResponse, type ParquetParseResponse } from '@ifc-lite/server-client';
import { useViewerStore } from '@/store';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
const { useIfcLoader } = await import('./useIfcLoader.js');
const { getProcessingServerUrl, setProcessingServerUrl } = await import('@/lib/processed-model');
const { loadDialogs } = await import('@/test/dialog-host.js');
const { click, settle, waitFor } = await import('@/test/render.js');
const { propertyModelBuffer } = await import('../../../../packages/server-client/test/fixtures/property-model.js');

const PARQUET_RESULT: ParquetParseResponse = {
  meshes: [
    {
      express_id: 1,
      ifc_type: 'IFCWALL',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [0.5, 0.25, 0.125, 1],
    },
  ],
  cache_key: 'test-cache-key',
  metadata: {
    schema_version: 'IFC4',
    entity_count: 1,
    geometry_entity_count: 1,
    coordinate_info: { origin_shift: [0, 0, 0], is_geo_referenced: false },
  },
  stats: {
    total_meshes: 1,
    total_vertices: 3,
    total_triangles: 1,
    parse_time_ms: 1,
    geometry_time_ms: 1,
    total_time_ms: 2,
    from_cache: false,
  },
  parquet_stats: {
    payload_size: 0,
    decode_time_ms: 0,
  },
};


let api: ReturnType<typeof useIfcLoader> | undefined;
let root: Root;
let container: HTMLDivElement;
let entered!: () => void, release!: () => void;
let properties: Promise<void>, ready: Promise<void>;
let localEntries = 0, engineInits = 0, fetches = 0;
let pollSignal: AbortSignal | undefined;
const progress = useViewerStore.getState().setProgress;
function Probe() { api = useIfcLoader(); return null; }
const file = (name: string) => new File(["ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;"], name);

beforeEach(async () => {
  localEntries = 0; engineInits = 0; fetches = 0; pollSignal = undefined;
  properties = new Promise<void>(resolve => { release = resolve; });
  ready = new Promise<void>(resolve => { entered = resolve; });
  useViewerStore.getState().resetViewerState(); useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ mergeLayers: false, setProgress(p) {
    if (p?.phase === 'Starting geometry streaming') localEntries++;
    return progress(p);
  } });
  mock.method(IfcServerClient.prototype, 'health', async () => ({ status: 'ok' }) as HealthResponse);
  mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => true);
  mock.method(IfcServerClient.prototype, 'parseParquet', async () => PARQUET_RESULT);
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async (_key: string, options?: Parameters<IfcServerClient['fetchDataModel']>[1]) => {
    if (++fetches !== 1) return null;
    const signal = typeof options === 'object' ? options.signal : undefined;
    pollSignal = signal;
    entered();
    await Promise.race([properties, new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    return null;
  });
  mock.method(GeometryProcessor.prototype, 'init', async () => { engineInits++; throw new Error('local fallback sentinel #9538'); });
  await settle();
  container = document.createElement('div'); document.body.appendChild(container);
  const { ConfirmDialogHost } = await loadDialogs();
  root = createRoot(container); await act(async () => { root.render(<><Probe /><ConfirmDialogHost /></>); });
  assert.ok(api);
});
afterEach(async () => {
  release(); useViewerStore.getState().activeLoadCanceller?.();
  await act(async () => root.unmount()); container.remove(); mock.restoreAll();
  useViewerStore.setState({ setProgress: progress });
});

for (const cause of ['cancel', 'supersede'] as const) {
  it(`#9538 ${cause} during server geometry never enters the local fallback`, async () => {
    let first = true;
    mock.method(IfcServerClient.prototype, 'parseParquet', async () => {
      if (first) { first = false; entered(); await properties; }
      return PARQUET_RESULT;
    });
    const pending = api!.loadFile(file('first.ifc')); let replacement: Promise<void> | undefined;
    try {
      await ready;
      await act(async () => {
        if (cause === 'cancel') useViewerStore.getState().activeLoadCanceller?.();
        else replacement = api!.loadFile(file('replacement.ifc'));
        release();
        await Promise.all([pending, replacement]);
      });
      assert.equal(localEntries, 0, 'stale server result must not publish local-path progress');
      assert.equal(engineInits, 0, 'stale server result must not initialize WASM');
    } finally { release(); await Promise.allSettled([pending, replacement]); }
  });
}

it('#9538 a current server failure starts local processing', async () => {
  mock.method(IfcServerClient.prototype, 'parseParquet', async () => { throw new Error('server unavailable #9538'); });
  await act(async () => { await api!.loadFile(file('fallback.ifc')); });
  assert.equal(localEntries, 1, 'a current server failure must publish local-path progress');
  assert.equal(engineInits, 1, 'a current server failure must try local WASM');
});

for (const image of ['unused.png', 'unused.JPG']) it(`#10264 small ZIP with unreferenced ${image} stays local after extraction`, async () => {
  let serverAttempts = 0;
  mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => { serverAttempts++; return true; });
  const model = new Uint8Array(await file('model.ifc').arrayBuffer());
  const bytes = zipSync({ 'model.ifc': model, [image]: new Uint8Array([1, 2, 3]) });
  await act(async () => { await api!.loadFile(new File([bytes as BlobPart], 'with-unused-image.ifcZIP')); });
  assert.equal(serverAttempts, 0, 'archive eligibility must also guard the later server attempt');
  assert.equal(engineInits, 1, 'unreferenced images create no bitmaps but the model still takes the local path');
});

it('#9538 geometry completes and load finally leaves the model property poll alive', async () => {
  let completed = false;
  const pending = api!.loadFile(file('geometry-ready.ifc')).then(() => { completed = true; });
  try {
    await ready;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await act(async () => { await Promise.race([pending, new Promise(resolve => { deadline = setTimeout(resolve, 1000); })]); });
    } finally { clearTimeout(deadline); }
    assert.equal(completed, true, 'optional properties must not delay load completion');
    assert.equal(useViewerStore.getState().loading, false);
    assert.equal(useViewerStore.getState().progress?.phase, 'Complete');
    assert.equal(useViewerStore.getState().models.values().next().value?.loadState, 'complete');
    assert.equal(pollSignal?.aborted, false, 'the load finally must not abort model-owned properties');
  } finally { release(); await pending; }
});

for (const archive of [false, true]) for (const scenario of ['unavailable', 'ineligible', 'success'] as const) {
  it(`#10264 ${archive ? 'IFC ZIP' : 'STEP'} server ${scenario} does not allocate an oversized local source`, async () => {
    const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 4 });
    const source = archive
      ? new File([zipSync({ 'model.ifc': strToU8('ISO-10303-21;\nHEADER;\nFILE_SCHEMA((\'IFC4\'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;') }) as BlobPart], 'oversized-server.ifcZIP')
      : file('oversized-server.ifc');
    // Keep the real ZIP metadata slices while reporting an over-budget model size.
    const content = new Blob([source]);
    Object.defineProperty(source, 'slice', { value: content.slice.bind(content) });
    Object.defineProperty(source, 'size', { value: 1.26e9 });
    let fullReads = 0, largeAllocations = 0, attempts = 0;
    const priorServerUrl = getProcessingServerUrl();
    const servers: string[] = [];
    Object.defineProperty(source, 'arrayBuffer', { value: async () => {
      fullReads++; throw new Error('unexpected whole-source read #10264');
    } });
    const realSab = globalThis.SharedArrayBuffer;
    globalThis.SharedArrayBuffer = new Proxy(realSab, { construct(target, args) {
      if (args[0] >= 1e9) { largeAllocations++; throw new Error('unexpected source allocation #10264'); }
      return Reflect.construct(target, args);
    } });
    mock.method(IfcServerClient.prototype, 'parseParquetStream', async function (this: IfcServerClient, _file: Parameters<IfcServerClient['parseParquetStream']>[0], onBatch: Parameters<IfcServerClient['parseParquetStream']>[1]) {
      attempts++;
      servers.push((this as unknown as { baseUrl: string }).baseUrl);
      if (scenario !== 'success') throw new Error('unavailable server #10264');
      onBatch({ meshes: PARQUET_RESULT.meshes, batch_number: 1, decode_time_ms: 0 });
      return { cache_key: PARQUET_RESULT.cache_key, total_meshes: 1,
        stats: PARQUET_RESULT.stats, metadata: PARQUET_RESULT.metadata };
    });
    useViewerStore.setState({ mergeLayers: scenario === 'ineligible' });
    const errors: string[] = [];
    try {
      setProcessingServerUrl('/memory-admission-runtime');
      await act(async () => { await api!.loadFile(source, undefined, { onLoadError: message => errors.push(message) }); });
      assert.equal(fullReads, 0, 'no whole-file ArrayBuffer acquisition');
      assert.equal(largeAllocations, 0, 'no file-sized shared allocation before server/fallback decision');
      assert.equal(engineInits, 0, 'never starts an oversized local fallback');
      assert.equal(attempts, scenario === 'ineligible' ? 0 : 1, 'eligible server upload is still attempted');
      assert.deepEqual(servers, scenario === 'ineligible' ? [] : ['/memory-admission-runtime'], 'pre-allocation server admission uses the runtime URL (#10142/#10264)');
      assert.equal(useViewerStore.getState().loading, false);
      if (scenario === 'success') {
        assert.deepEqual(errors, []);
        assert.equal(useViewerStore.getState().models.values().next().value?.loadState, 'complete');
        assert.equal(useViewerStore.getState().geometryResult?.meshes.length, 1);
      } else {
        assert.equal(errors.length, 1);
        assert.match(errors[0], /local processing memory budget/);
      }
    } finally {
      setProcessingServerUrl(priorServerUrl);
      globalThis.SharedArrayBuffer = realSab;
      if (memory) Object.defineProperty(navigator, 'deviceMemory', memory);
      else Reflect.deleteProperty(navigator, 'deviceMemory');
    }
  });
}

for (const publishes of [false, true]) it(`#10264 server failure ${publishes ? 'after' : 'before'} publication uses the real consent host`, async () => {
  useViewerStore.setState(fixtureModels(fixtureModel('prior-model')));
  const prior = useViewerStore.getState().models;
  const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
  Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
  const source = file('server-partial.ifc');
  Object.defineProperty(source, 'size', { value: 1.26e9 });
  let reads = 0;
  Object.defineProperty(source, 'arrayBuffer', { value: () => { reads++; throw new Error('unexpected local source read'); } });
  Object.defineProperty(source, 'stream', { value: () => { reads++; throw new Error('unexpected local source stream'); } });
  mock.method(IfcServerClient.prototype, 'parseParquetStream', async (_source: Parameters<IfcServerClient['parseParquetStream']>[0], batch: Parameters<IfcServerClient['parseParquetStream']>[1]) => {
    assert.equal(useViewerStore.getState().models, prior, 'the server request itself does not replace the scene');
    assert.equal(useViewerStore.getState().loading, true, 'server work still has a loading indicator before replacement');
    if (!publishes) throw new Error('server stream failed before geometry');
    batch({ meshes: PARQUET_RESULT.meshes, batch_number: 0, decode_time_ms: 0 });
    assert.notEqual(useViewerStore.getState().models, prior, 'first server geometry commits the replacement');
    assert.equal(useViewerStore.getState().geometryResult?.totalTriangles, 1);
    assert.match(useViewerStore.getState().progress?.phase ?? '', /Streaming batch/);
    throw new Error('server stream failed after first geometry');
  });
  const errors: string[] = [];
  let pending: Promise<void> | undefined;
  let completed = false;
  try {
    await act(async () => {
      pending = api!.loadFile(source, { kind: 'primary', modelId: 'partial-server' }, { onLoadError: message => errors.push(message) })
        .finally(() => { completed = true; });
    });
    await waitFor(() => completed || !!document.querySelector('[role="alertdialog"]'), 'server failure settles or requests local consent');
    const dialog = document.querySelector('[role="alertdialog"]');
    if (!publishes) {
      assert.ok(dialog, 'the mounted host must visibly request consent before any replacement');
      assert.match(dialog.textContent ?? '', /available memory/);
      assert.equal(useViewerStore.getState().models, prior, 'pre-publication Cancel can preserve the prior scene');
      const activityId = useActivityJournal.getState().jobs.filter(job => job.subject === source.name && job.outcome === 'running').at(-1)?.id;
      assert.ok(activityId, 'the warning belongs to a running activity');
      click(dialog.querySelector('button')!);
      await pending;
      assert.equal(useActivityJournal.getState().jobs.find(job => job.id === activityId)?.outcome, 'cancelled', 'dialog Cancel is a cancellation, not a failed no-model load');
      assert.deepEqual(errors, []);
      assert.equal(useViewerStore.getState().models, prior);
      assert.equal(reads, 0);
      assert.equal(engineInits, 0);
      return;
    }
    assert.equal(dialog !== null, false, 'no consent whose Cancel could no longer preserve the prior scene');
    await pending;
    assert.equal(completed, true, 'post-publication failure settles without waiting for consent');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /server stream failed after first geometry/);
    assert.equal(useViewerStore.getState().models.get('partial-server')?.loadState, 'error');
    assert.equal(useViewerStore.getState().models.get('partial-server')?.sourceReadRefused, undefined, 'published server geometry is admitted even if completion fails');
    assert.equal(useViewerStore.getState().loading, false);
    assert.equal(reads, 0);
    assert.equal(engineInits, 0, 'no implicit local fallback after server publication');
  } finally {
    release(); // release this fixture's deliberately held model-property request
    await act(async () => { root.render(null); }); // host teardown resolves any unexpected consent
    await pending;
    if (memory) Object.defineProperty(navigator, 'deviceMemory', memory); else Reflect.deleteProperty(navigator, 'deviceMemory');
  }
});

it('#10264 ZIP extraction cannot exceed its admitted model size when the directory lies', async () => {
  const failureLog = mock.method(console, 'error');
  const bytes = zipSync({ 'model.ifc': strToU8('ISO-10303-21;'.repeat(20000)) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = view.getUint32(bytes.length - 22 + 16, true);
  view.setUint32(directory + 24, 32, true);
  const errors: string[] = [];
  await act(async () => {
    await api!.loadFile(new File([bytes as BlobPart], 'forged-size.ifcZIP'), undefined, { onLoadError: message => errors.push(message) });
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /extraction size limit/);
  assert.ok(failureLog.mock.calls.some(call => call.arguments.some(value =>
    value instanceof Error && /extracted entry.*exceeds.*limit/.test(value.message))),
  'the bounded extractor aborts while streaming, rather than after a full size-mismatch result');
  assert.equal(engineInits, 0, 'bounded archive extraction stops before WASM');
});

it('a server URL set at runtime takes the upload of a locally opened IFC too', async () => {
  const { setProcessingServerUrl } = await import('@/lib/processed-model');
  const servers: string[] = [];
  mock.method(IfcServerClient.prototype, 'parseParquet', async function (this: IfcServerClient) {
    servers.push((this as unknown as { baseUrl: string }).baseUrl);
    return PARQUET_RESULT;
  });
  try {
    setProcessingServerUrl('/runtime-processor');
    await act(async () => { await api!.loadFile(file('runtime.ifc')); });
    assert.deepEqual(servers, ['/runtime-processor'], 'the upload gate and the request read the same URL');
    assert.equal(engineInits, 0);

    setProcessingServerUrl('');
    await act(async () => { await api!.loadFile(file('no-server.ifc')); });
    assert.deepEqual(servers, ['/runtime-processor'], 'with no server URL the build flag alone uploads nothing');
    assert.equal(engineInits, 1, 'the file is processed locally');
  } finally { setProcessingServerUrl('http://localhost:9999'); release(); }
});

for (const spaces of [100, 5000]) it(`#10264 an unknown IFC header after ${spaces} spaces cannot bypass preflight`, async () => {
  const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
  Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 4 });
  const source = new File([' '.repeat(spaces), await file('model.ifc').text()], 'spaced.ifc');
  const blob = new Blob([source]);
  Object.defineProperty(source, 'size', { value: 1.05e9 });
  Object.defineProperty(source, 'slice', { value: blob.slice.bind(blob) });
  let fullReads = 0;
  Object.defineProperty(source, 'arrayBuffer', { value: async () => { fullReads++; throw new Error('unadmitted source read'); } });
  useViewerStore.setState({ ...fixtureModels(fixtureModel('prior-spaced')), mergeLayers: true });
  const prior = useViewerStore.getState().models, errors: string[] = [];
  try {
    await act(async () => { await api!.loadFile(source, undefined, { onLoadError: error => errors.push(error) }); });
    assert.equal(fullReads, 0);
    assert.equal(engineInits, 0);
    assert.equal(useViewerStore.getState().models, prior, 'unknown IFC admission must precede replacement');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /local processing memory budget/);
  } finally {
    if (memory) Object.defineProperty(navigator, 'deviceMemory', memory); else Reflect.deleteProperty(navigator, 'deviceMemory');
  }
});

for (const phase of ['header', 'dialog']) it(`#10264 loading-card Cancel during ${phase} preserves the displayed primary scene`, async () => {
  const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
  Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
  useViewerStore.setState({ ...fixtureModels(fixtureModel('prior-cancel')), selectedEntityId: 7, mergeLayers: true });
  const prior = useViewerStore.getState().models;
  const source = file('cancel-preflight.ifc'), blob = new Blob([source]);
  Object.defineProperty(source, 'size', { value: 1.05e9 });
  let releaseHead!: () => void, readHead = false;
  const gate = new Promise<void>(resolve => { releaseHead = resolve; });
  Object.defineProperty(source, 'slice', { value: (start?: number, end?: number) => {
    const part = blob.slice(start, end);
    return { arrayBuffer: async () => { readHead = true; if (phase === 'header') await gate; return part.arrayBuffer(); } };
  } });
  let pending: Promise<void> | undefined;
  try {
    await act(async () => { pending = api!.loadFile(source); });
    await waitFor(() => phase === 'header' ? readHead : !!document.querySelector('[role="alertdialog"]'), 'preflight is waiting');
    assert.equal(useViewerStore.getState().loading, true);
    await act(async () => { useViewerStore.getState().activeLoadCanceller?.(); });
    releaseHead(); await pending;
    assert.equal(useViewerStore.getState().models, prior, 'loading-card Cancel must not commit a primary replacement');
    assert.equal(useViewerStore.getState().selectedEntityId, 7);
    assert.equal(useViewerStore.getState().loading, false);
    assert.equal(engineInits, 0);
    assert.equal(document.querySelector('[role="alertdialog"]') !== null, false);
  } finally {
    releaseHead(); await act(async () => { root.render(null); }); await pending;
    if (memory) Object.defineProperty(navigator, 'deviceMemory', memory); else Reflect.deleteProperty(navigator, 'deviceMemory');
  }
});

for (const outcome of ['refusal', 'same-id-refusal', 'dialog-cancel', 'loading-cancel', 'replacement']) it(`#10264 pending displayed-model properties survive candidate ${outcome} until replacement commits`, async () => {
  const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
  let deliver: ((bytes: ArrayBuffer) => void) | undefined, propertySignal: AbortSignal | undefined;
  let polls = 0;
  const wire = propertyModelBuffer();
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async (_key: string, options?: Parameters<IfcServerClient['fetchDataModel']>[1]) => {
    if (++polls !== 1) return null;
    propertySignal = typeof options === 'object' ? options.signal : undefined;
    return new Promise<ArrayBuffer>(resolve => { deliver = resolve; });
  });
  let candidate: Promise<void> | undefined;
  try {
    await act(async () => { await api!.loadFile(file('prior-with-properties.ifc'), { kind: 'primary', modelId: 'hydration-prior' }); });
    await waitFor(() => !!deliver, 'displayed model property fetch is held');
    assert.equal(useViewerStore.getState().models.get('hydration-prior')?.loadState, 'complete');
    assert.equal(propertySignal?.aborted, false);
    if (outcome === 'replacement') {
      await act(async () => { await api!.loadFile(file('accepted-replacement.ifc'), { kind: 'primary', modelId: 'replacement' }); });
      assert.equal(propertySignal?.aborted, true, 'an actually committed replacement still supersedes old properties');
      deliver!(wire);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      assert.equal(useViewerStore.getState().models.has('hydration-prior'), false);
      assert.equal(useViewerStore.getState().models.has('replacement'), true);
      return;
    }
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: outcome.endsWith('refusal') ? 4 : 8 });
    useViewerStore.setState({ mergeLayers: outcome !== 'same-id-refusal' });
    if (outcome === 'same-id-refusal') mock.method(IfcServerClient.prototype, 'parseParquetStream', async () => { throw new Error('candidate server unavailable'); });
    const source = file('unadmitted-candidate.ifc'), blob = new Blob([source]);
    Object.defineProperty(source, 'size', { value: 1.05e9 });
    Object.defineProperty(source, 'slice', { value: blob.slice.bind(blob) });
    await act(async () => { candidate = api!.loadFile(source, outcome === 'same-id-refusal' ? { kind: 'primary', modelId: 'hydration-prior' } : undefined); });
    if (!outcome.endsWith('refusal')) {
      await waitFor(() => !!document.querySelector('[role="alertdialog"]'), 'candidate awaits admission');
      if (outcome === 'dialog-cancel') click(document.querySelector('[role="alertdialog"] button')!);
      else await act(async () => { useViewerStore.getState().activeLoadCanceller?.(); });
    }
    await candidate;
    assert.equal(propertySignal?.aborted, false, 'displayed model hydration survives a refused or cancelled candidate');
    deliver!(wire);
    await waitFor(() => useViewerStore.getState().models.get('hydration-prior')?.ifcDataStore?.entities.getName(1) === 'Server properties', 'real server wire properties commit to the still-displayed model');
    assert.equal(useViewerStore.getState().models.get('hydration-prior')?.ifcDataStore?.entities.getName(1), 'Server properties');
  } finally {
    deliver?.(wire); await act(async () => { root.render(null); }); await candidate;
    if (memory) Object.defineProperty(navigator, 'deviceMemory', memory); else Reflect.deleteProperty(navigator, 'deviceMemory');
  }
});

for (const archive of [false, true]) it(`#10264 ordinary acquired ${archive ? 'ZIP' : 'STEP'} retries the local engine after partial server failure`, async () => {
  useViewerStore.setState(fixtureModels(fixtureModel('prior-model')));
  const prior = useViewerStore.getState().models;
  const header = new Uint8Array(await file('model.ifc').arrayBuffer());
  const step = new Uint8Array(151 * 1024 * 1024); step.fill(32); step.set(header);
  // A real acquired source above the 150 MiB streaming threshold, below the 4 GiB memory warning.
  const source = archive ? new File([zipSync({ 'model.ifc': step }, { level: 0 }) as BlobPart], 'ordinary-medium.ifcZIP')
    : new File([step as BlobPart], 'ordinary-medium.ifc');
  let acquired = 0, serverBatches = 0;
  const read = source.arrayBuffer.bind(source);
  Object.defineProperty(source, 'arrayBuffer', { value: () => { acquired++; return read(); } });
  mock.method(IfcServerClient.prototype, 'parseParquetStream', async (_source: Parameters<IfcServerClient['parseParquetStream']>[0], batch: Parameters<IfcServerClient['parseParquetStream']>[1]) => {
    assert.equal(acquired, 1, 'ordinary source acquisition precedes this server attempt');
    assert.notEqual(useViewerStore.getState().models, prior, 'this attempt already committed its scene reset');
    batch({ meshes: PARQUET_RESULT.meshes, batch_number: 0, decode_time_ms: 0 });
    serverBatches++;
    assert.equal(useViewerStore.getState().geometryResult?.totalTriangles, 1);
    throw new Error('ordinary server stream failed after first geometry');
  });
  const errors: string[] = [];
  await act(async () => { await api!.loadFile(source, undefined, { onLoadError: message => errors.push(message) }); });
  assert.equal(serverBatches, 1, 'the failure occurs after real batch publication');
  assert.equal(engineInits, 1, 'ordinary acquired source must reach local WASM fallback');
  assert.equal(document.querySelector('[role="alertdialog"]') !== null, false, 'no consent decision is involved');
  assert.equal(errors.length, 1, 'the deliberately failing local-engine sentinel settles the fallback attempt');
  assert.equal(useViewerStore.getState().loading, false);
});
