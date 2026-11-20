/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ModelLoadOptions.processedModel` opens a result the server already holds.
 *
 * The contract is mostly a NEGATIVE: the source file is not in this browser,
 * so nothing may read, hash, cache or upload it, and a miss may not reach the
 * local WASM path. Each test therefore pins what the server client was handed
 * and that the local engine never started, not only that a model appeared.
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
// A server URL alone: opening a processed model does not need VITE_USE_SERVER, which only routes
// uploads of local files through the server.
(globalThis as unknown as { __VITE_ENV__?: Record<string, unknown> }).__VITE_ENV__ = {
  MODE: 'test', DEV: false, PROD: false, VITE_IFC_SERVER_URL: 'http://localhost:9999',
};
import { beforeEach, afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { IfcServerClient, IfcServerError, type HealthResponse, type ParquetParseResponse, type ProcessedModelRef } from '@ifc-lite/server-client';
import { useViewerStore } from '@/store';
import { waitFor } from '@/test/render.js';
import { deferred } from '@/test/race.js';
import { propertyModelBuffer } from '../../../../packages/server-client/test/fixtures/property-model.js';
const { useIfcLoader } = await import('./useIfcLoader.js');
const { processedModelFromQuery, useProcessedModelAutoload } = await import('./useProcessedModelAutoload.js');
const { isStepSourceModel } = await import('@/components/viewer/step-export-source');
const { getReportPrompt, clearLoadReport } = await import('@/lib/error-reports/context');
const { applyProcessingConfig, openProcessedModel, processedModelRequested, resetProcessedModelRequestsForTests, setProcessingServerUrl, takeProcessedModelRequest } = await import('@/lib/processed-model');
const { useModelUrlAutoload } = await import('./useModelUrlAutoload.js');

const sha256 = 'c'.repeat(64);
const processedModel = { sha256, bytes: 46_000_000 };
/** One meshed wall (#1). The data model adds a project (#2) that has no mesh. */
const stored = (): ParquetParseResponse => ({
  meshes: [{
    express_id: 1, ifc_type: 'IFCWALL',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.25, 0.125, 1],
  }],
  cache_key: `${sha256}-key`,
  metadata: { schema_version: 'IFC4', entity_count: 2, geometry_entity_count: 1, coordinate_info: { origin_shift: [0, 0, 0], is_geo_referenced: false } },
  stats: { total_meshes: 1, total_vertices: 3, total_triangles: 1, parse_time_ms: 1, geometry_time_ms: 1, total_time_ms: 2, from_cache: true },
  parquet_stats: { payload_size: 0, decode_time_ms: 0 },
  data_model: propertyModelBuffer(),
});

let api: ReturnType<typeof useIfcLoader> | undefined;
let root: Root, container: HTMLDivElement;
let asked: unknown[], engineInits: number, uploads: number, servers: string[];
let restoreGpu: (() => void) | undefined;
function Probe({ fromUrl = false }: { fromUrl?: boolean }) {
  api = useIfcLoader();
  return fromUrl ? <UrlEntry /> : null;
}
function UrlEntry() { useProcessedModelAutoload(); return null; }
const model = () => useViewerStore.getState().models.values().next().value;
const nameOnly = () => new File([], 'stored.ifc');

beforeEach(async () => {
  asked = []; engineInits = 0; uploads = 0; servers = []; clearLoadReport();
  useViewerStore.getState().resetViewerState(); useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ error: null, lastLoadRetry: null });
  mock.method(IfcServerClient.prototype, 'health', async () => ({ status: 'ok' }) as HealthResponse);
  mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => true);
  // Records which server each request went to: the runtime URL must reach the client.
  mock.method(IfcServerClient.prototype, 'parseParquet', async function (this: IfcServerClient, source: unknown) {
    servers.push((this as unknown as { baseUrl: string }).baseUrl);
    asked.push(source);
    return stored();
  });
  for (const upload of ['parse', 'parseParquetStream'] as const) {
    mock.method(IfcServerClient.prototype, upload, async () => { uploads++; throw new Error('a processed model must not take this route'); });
  }
  mock.method(GeometryProcessor.prototype, 'init', async () => { engineInits++; throw new Error('local engine sentinel'); });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  useViewerStore.getState().activeLoadCanceller?.();
  await act(async () => root.unmount()); container.remove(); mock.restoreAll();
  restoreGpu?.(); restoreGpu = undefined;
  window.history.replaceState(null, '', '/');
  resetProcessedModelRequestsForTests(); setProcessingServerUrl('http://localhost:9999');
  useViewerStore.getState().clearAllModels();
});

it('opens a stored result from a loopback server explicitly configured for an HTTPS viewer (#10822)', async () => {
  mock.getter(window.location, 'href', () => 'https://viewer.example.org/');
  mock.getter(window.location, 'hostname', () => 'viewer.example.org');
  const url = 'http://localhost:8080/ifc';
  applyProcessingConfig({ server: { url } });
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel }); });
  assert.deepEqual(servers, [url]);
  assert.equal(model()?.loadState, 'complete');
});

it('opens the stored result from the reference alone and publishes its properties', async () => {
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel }); });

  assert.deepEqual(asked, [processedModel], 'the server client is handed the reference, never a File or bytes');
  assert.equal(uploads, 0);
  assert.equal(engineInits, 0, 'the local engine has nothing to parse');
  assert.equal(useViewerStore.getState().error, null);
  assert.equal(model()?.loadState, 'complete');
  assert.equal(model()?.loadPath, 'server');
  assert.equal(model()?.geometryResult?.meshes.length, 1);
  assert.equal(model()?.fileSize, 46_000_000, 'the size comes from the reference; the File is empty');
  // No bytes are here, so nothing may treat the stand-in File as the source: no reload, export or
  // download of an empty file.
  assert.equal(model()?.sourceFile, undefined);
  assert.deepEqual(model()?.processedModel, processedModel);
  assert.equal(isStepSourceModel(model()!), false, 'STEP-based exports do not offer a model with no source bytes');

  // Properties arrive after the model is registered from its one mesh. The project (#2) has no
  // geometry and an id above the meshed range; resolving it must not throw.
  await act(async () => { await waitFor(() => model()?.ifcDataStore != null, 'the data model hydrates'); });
  assert.equal(model()?.ifcDataStore?.entities.getName(2), 'Project');
  assert.equal(model()?.ifcDataStore?.fileSize, 46_000_000);
  assert.equal(useViewerStore.getState().toGlobalId(model()!.id, 2), 2);
});

// Each cause has its own message; only a transient one offers Retry.
const CAUSES: ReadonlyArray<readonly [string, () => unknown, RegExp, string, boolean]> = [
  ['not stored (404)', () => new IfcServerError('not cached', 404, 'NOT_FOUND'), /not available on the server \(yet\)/, 'processed_model_not_stored', false],
  ['no access (403)', () => new IfcServerError('forbidden', 403, 'FORBIDDEN'), /no access to this model/, 'processed_model_forbidden', false],
  ['no access (401)', () => new IfcServerError('unauthorized', 401, 'UNAUTHORIZED'), /no access to this model/, 'processed_model_forbidden', false],
  ['server busy (503)', () => new IfcServerError('overloaded', 503, 'OVERLOADED'), /busy/, 'processed_model_server_busy', true],
  ['request timeout (408)', () => new IfcServerError('timeout', 408, 'TIMEOUT'), /busy/, 'processed_model_server_busy', true],
  ['server error (500)', () => new IfcServerError('boom', 500, 'INTERNAL'), /failed to send/, 'processed_model_server_error', true],
  ['network', () => new TypeError('Failed to fetch'), /Check the connection/, 'processed_model_network', true],
  ['unrecognised error', () => new Error('decoder exploded'), /decoder exploded|could not|failed/i, 'processed_model_failed', false],
];
for (const [cause, error, message, code, retryable] of CAUSES) {
  it(`a failure (${cause}) ends in its own error card: no upload, no local fallback`, async () => {
    mock.method(IfcServerClient.prototype, 'parseParquet', async (source: unknown) => { asked.push(source); throw error(); });
    const errors: unknown[][] = [];
    mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel }); });

    assert.deepEqual(asked, [processedModel]);
    assert.equal(uploads, 0);
    assert.equal(engineInits, 0, 'a failure must not start local WASM on a file that is not here');
    assert.match(useViewerStore.getState().error ?? '', message);
    assert.equal(typeof useViewerStore.getState().lastLoadRetry === 'function', retryable, retryable ? 'a transient cause offers Retry' : 'retrying cannot change this cause');
    assert.equal(getReportPrompt()?.context.errorCode, code);
    assert.equal(getReportPrompt()?.context.sourceFile, undefined, 'the error report offers no empty file as an attachment');
    assert.equal(model()?.loadState, 'error');
    assert.equal(useViewerStore.getState().loading, false);
    assert.equal(errors.some(args => /Server parse failed/.test(String(args[0]))), false, 'the card shows it; no console error');
  });
}

it('the load option lowercases a hash for the model record, and refuses a malformed one without Retry', async () => {
  mock.method(console, 'error', () => {});
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel: { sha256: sha256.toUpperCase(), bytes: 7 } }); });
  assert.deepEqual(model()?.processedModel, { sha256, bytes: 7 });
  assert.deepEqual(asked, [{ sha256, bytes: 7 }]);

  // The real client refuses the hash before any request; the card offers no Retry loop.
  mock.method(IfcServerClient.prototype, 'parseParquet', async () => { throw new TypeError('A processed model is named by the SHA-256 of its source file: 64 hex characters'); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel: { sha256: 'not-a-hash', bytes: 7 } }); });
  assert.equal(model()?.loadState, 'error');
  assert.equal(useViewerStore.getState().lastLoadRetry, null);
});

it('retries decoder initialization and opens the same processed model (#10469)', async () => {
  stubWebGpu();
  let attempts = 0;
  mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => ++attempts > 1);
  mock.method(console, 'error', () => {});
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel }); });

  assert.equal(model()?.loadState, 'error');
  assert.equal(asked.length, 0, 'wait for decoder initialization before requesting the model');
  assert.equal(uploads, 0);
  const retry = useViewerStore.getState().lastLoadRetry;
  assert.ok(retry, 'a failed Parquet initialization offers Retry');
  assert.match(useViewerStore.getState().error ?? '', /initialize the Parquet decoder/);
  await act(async () => { retry(); });
  await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'processed retry completes'); });
  assert.equal(attempts, 2);
  assert.deepEqual(asked, [processedModel]);
  assert.equal(uploads, 0);
  assert.equal(engineInits, 0);
});

for (const bytes of [0, undefined, Number.NaN, '12'] as const) it(`a model of unknown size (${String(bytes)}) streams, since the streamed route works at any size`, async () => {
  let streamed: unknown;
  mock.method(IfcServerClient.prototype, 'parseParquetStream', async (source: unknown, onBatch: (batch: { meshes: ParquetParseResponse['meshes'] }) => void) => {
    streamed = source;
    onBatch({ meshes: stored().meshes });
    const { meshes: _meshes, parquet_stats: _stats, data_model: _dataModel, ...rest } = stored();
    return rest;
  });
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel: { sha256, bytes } as ProcessedModelRef }); }); // '12' and NaN as a host calling from JS might
  assert.deepEqual(streamed, { sha256, bytes: 0 });
  assert.deepEqual(asked, [], 'the one-shot route is not taken for an unknown size');
  assert.equal(model()?.loadState, 'complete');
  assert.equal(model()?.geometryResult?.meshes.length, 1);
  const record = model()?.processedModel;
  assert.ok(record);
  // The record always carries a number even when the load input does not (#10469).
  const recordedBytes: number = record.bytes;
  assert.equal(recordedBytes, 0);
  assert.equal(model()?.fileSize, 0, 'unknown, shown as N/A rather than as a size');
});

it('refuses a federated target, whose geometry the server replay cannot address', async () => {
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'federated', modelId: 'second' }, { processedModel }); });
  assert.deepEqual(asked, []);
  assert.match(useViewerStore.getState().error ?? '', /only be opened as the first model/);
  assert.equal(useViewerStore.getState().lastLoadRetry, null);
  assert.equal(useViewerStore.getState().models.size, 0);
});

it('federated processed refusal leaves an in-flight primary load in control (#10469)', async () => {
  const release = deferred<ParquetParseResponse>();
  const started = deferred();
  mock.method(IfcServerClient.prototype, 'parseParquet', async () => {
    started.resolve();
    return release.promise;
  });
  await act(async () => { root.render(<Probe />); });
  const initialLoad = api!.loadFile(new File([], 'in-flight.ifc'), { kind: 'primary' }, { processedModel });
  await started.promise;
  const initial = useViewerStore.getState();
  const refusals: string[] = [];
  const ownershipChanges: string[] = [];
  const stop = useViewerStore.subscribe((state, prior) => {
    if (state.activeLoadCanceller !== prior.activeLoadCanceller) ownershipChanges.push('canceller');
    if (state.loadingFileName !== prior.loadingFileName) ownershipChanges.push('filename');
    if (state.progress !== prior.progress) ownershipChanges.push('progress');
  });
  try {
    await act(async () => {
      await api!.loadFile(nameOnly(), { kind: 'federated', modelId: 'refused' }, {
        processedModel, onLoadError: message => { refusals.push(message); },
      });
    });
    const current = useViewerStore.getState();
    assert.equal(refusals.length, 1);
    assert.match(refusals[0], /only be opened as the first model/);
    assert.equal(current.models.has('refused'), false);
    assert.equal(current.loading, true);
    assert.equal(current.activeLoadCanceller, initial.activeLoadCanceller);
    assert.deepEqual(ownershipChanges, []);
  } finally {
    stop();
    release.resolve(stored());
    await act(async () => { await initialLoad; });
  }
  assert.equal(model()?.loadState, 'complete');
  assert.equal(model()?.name, 'in-flight.ifc');
});

function stubWebGpu(): void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(), limits: {} }) } });
  restoreGpu = () => { if (original) Object.defineProperty(navigator, 'gpu', original); else Reflect.deleteProperty(navigator, 'gpu'); };
}

it('?processed= opens the named result with the size and name from the URL', async () => {
  stubWebGpu();
  window.history.replaceState(null, '', `/?processed=${sha256}&bytes=1234567&name=${encodeURIComponent('Haus A.ifc')}`);
  await act(async () => { root.render(<Probe fromUrl />); });
  await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'the URL entry loads the model'); });
  assert.deepEqual(asked, [{ sha256, bytes: 1234567 }]);
  assert.equal(model()?.name, 'Haus A.ifc');
  assert.equal(model()?.fileSize, 1234567);
  assert.equal(engineInits, 0);
});

it('?processed= accepts the hash in upper case and asks for it in lower case', async () => {
  stubWebGpu();
  window.history.replaceState(null, '', `/?processed=${sha256.toUpperCase()}&bytes=10`);
  await act(async () => { root.render(<Probe fromUrl />); });
  await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'the URL entry loads the model'); });
  assert.deepEqual(asked, [{ sha256, bytes: 10 }]);
});

it('?processed= reads a size that is not plain digits as unknown', () => {
  for (const bad of ['abc', '0x9502F900', '1.6e8', '-5', ' 12', '', '99999999999999999999']) {
    assert.equal((processedModelFromQuery(`?processed=${sha256}&bytes=${encodeURIComponent(bad)}`) as ProcessedModelRef).bytes, 0, bad);
  }
});

it('?processed= with a bad size opens the model as unknown size', async () => {
  stubWebGpu();
  let streamed: unknown;
  mock.method(IfcServerClient.prototype, 'parseParquetStream', async (source: unknown, onBatch: (batch: { meshes: ParquetParseResponse['meshes'] }) => void) => {
    streamed = source; onBatch({ meshes: stored().meshes });
    const { meshes: _meshes, parquet_stats: _stats, data_model: _dataModel, ...rest } = stored();
    return rest;
  });
  window.history.replaceState(null, '', `/?processed=${sha256}&bytes=abc`);
  await act(async () => { root.render(<Probe fromUrl />); });
  await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'the URL entry loads the model'); });
  assert.deepEqual(streamed, { sha256, bytes: 0 });
});

it('?processed= with something that is not a SHA-256 asks the server nothing and says so', async () => {
  stubWebGpu();
  window.history.replaceState(null, '', '/?processed=../../etc/passwd');
  await act(async () => { root.render(<Probe fromUrl />); });
  await act(async () => { await waitFor(() => useViewerStore.getState().error !== null, 'a malformed hash is reported'); });
  assert.deepEqual(asked, []);
  assert.match(useViewerStore.getState().error ?? '', /model link is incomplete or damaged/, 'its own message, not the ?model= one');
  assert.equal(useViewerStore.getState().lastLoadRetry, null, 'the same string cannot succeed on retry');
  assert.equal(useViewerStore.getState().models.size, 0);
});

for (const when of ['before the viewer mounts', 'after the viewer mounted'] as const) {
  it(`openProcessedModel called ${when} opens the result from the server it names`, async () => {
    stubWebGpu();
    const serverUrl = when === 'before the viewer mounts' ? '/processor' : '/other-processor';
    const open = () => openProcessedModel({ sha256, bytes: 7_000_000, name: 'From the host.ifc' }, { serverUrl: `${serverUrl}/` });
    if (when === 'before the viewer mounts') open();
    await act(async () => { root.render(<Probe fromUrl />); });
    if (when === 'after the viewer mounted') await act(async () => { open(); });
    await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'the host request loads the model'); });
    assert.deepEqual(asked, [{ sha256, bytes: 7_000_000, serverUrl }]);
    assert.deepEqual(servers, [serverUrl], 'the runtime URL replaces the build-time one for this request');
    assert.equal(model()?.name, 'From the host.ifc');
    assert.equal(model()?.fileSize, 7_000_000);
    assert.equal(engineInits, 0);
    assert.equal(takeProcessedModelRequest(), null, 'a request is loaded once');
  });
}

for (const atStartup of [false, true]) {
  it(atStartup
    ? 'reschedules engine prewarm after a queued startup model settles on a low-memory device'
    : 'does not fetch the engine at idle while mounted autoload owns the processed request', async () => {
    stubWebGpu();
    const idle: (() => void)[] = [];
    const takeIdle = () => {
      const run = idle.shift();
      assert.ok(run, 'an idle callback is scheduled');
      run();
    };
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true, value: (run: () => void) => idle.push(run),
    });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 2 });
    const fetch = mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      assert.match(String(input), /\.wasm$/);
      return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), {
        headers: { 'Content-Type': 'application/wasm' },
      });
    });
    const result = deferred<ParquetParseResponse>();
    const parse = mock.method(IfcServerClient.prototype, 'parseParquet', () => result.promise);
    const open = () => openProcessedModel({ ...processedModel, name: 'stored.ifc' });
    try {
      const path = `../lib/wasm-prewarm.js?autoload-${atStartup}`;
      const prewarm: typeof import('../lib/wasm-prewarm.js') = await import(path);
      if (atStartup) open();
      prewarm.scheduleWasmPrewarm();
      assert.equal(idle.length, atStartup ? 0 : 1);
      await act(async () => { root.render(<Probe fromUrl />); });
      if (!atStartup) await act(async () => { open(); });
      await waitFor(() => parse.mock.callCount() === 1, 'autoload reaches the server');
      assert.equal(processedModelRequested(), false, 'autoload already took the request');
      assert.equal(useViewerStore.getState().loading, true);

      if (!atStartup) {
        takeIdle();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(fetch.mock.callCount(), 0, 'prewarm waits while the server request is in flight');
      }
      assert.equal(idle.length, 0);
      await act(async () => {
        result.resolve(stored());
        await waitFor(() => !useViewerStore.getState().loading, 'processed load settles');
      });
      assert.equal(idle.length, 1, 'settling schedules prewarm without the fast path');
      if (atStartup) {
        takeIdle();
        await waitFor(() => fetch.mock.callCount() === 1, 'idle callback fetches the engine');
      }
    } finally {
      result.resolve(stored());
      Reflect.deleteProperty(window, 'requestIdleCallback');
      Reflect.deleteProperty(navigator, 'deviceMemory');
    }
  });
}

it('openProcessedModel refuses a hash that is not a SHA-256 before anything is asked', async () => {
  assert.throws(() => openProcessedModel({ sha256: '../x', bytes: 1, name: 'x.ifc' }, { serverUrl: '/elsewhere' }), /SHA-256 of its source file/);
  assert.equal(takeProcessedModelRequest(), null);
  await act(async () => { root.render(<Probe fromUrl />); });
  assert.deepEqual(asked, []);
  assert.deepEqual(servers, []);
});

it('with no processing server configured, the error says so and offers no Retry', async () => {
  mock.method(console, 'error', () => {});
  setProcessingServerUrl('');
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel }); });
  assert.deepEqual(asked, [], 'nothing is asked of a server that does not exist');
  assert.match(useViewerStore.getState().error ?? '', /No processing server is configured/);
  assert.equal(useViewerStore.getState().lastLoadRetry, null);
});

it("a host request filed before the viewer mounts wins over ?processed= in the page URL", async () => {
  stubWebGpu();
  const infos: unknown[][] = [];
  mock.method(console, 'info', (...args: unknown[]) => { infos.push(args); });
  window.history.replaceState(null, '', `/?processed=${'d'.repeat(64)}&bytes=9&name=url.ifc`);
  openProcessedModel({ sha256, bytes: 7_000_000, name: 'From the host.ifc' });
  await act(async () => { root.render(<Probe fromUrl />); });
  await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'the host model loads'); });
  assert.deepEqual(asked, [{ sha256, bytes: 7_000_000 }], "only the host's model is asked for");
  assert.equal(model()?.name, 'From the host.ifc');
  assert.equal(infos.filter((args) => /ignored/.test(String(args[0]))).length, 1, 'the ignored URL is logged once');
});

function ModelUrlEntry() { useModelUrlAutoload(); return null; }
for (const hash of [sha256, 'malformed'] as const) {
  it(`a ${hash === sha256 ? 'valid' : 'malformed'} processed link does not start a second model load (#10469)`, async () => {
    stubWebGpu();
    const fetched: string[] = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(null, { status: 404 });
    });
    window.history.replaceState(null, '', `/?model=other.ifc&processed=${hash}&bytes=123&name=stored.ifc`);
    // Match ViewerLayout's ordering, where the model URL hook comes first.
    await act(async () => { root.render(<><ModelUrlEntry /><Probe fromUrl /></>); });
    if (hash === sha256) {
      await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'the processed model loads'); });
      assert.deepEqual(asked, [{ sha256, bytes: 123 }]);
      assert.equal(model()?.name, 'stored.ifc');
    } else {
      await act(async () => { await waitFor(() => useViewerStore.getState().error !== null, 'the processed link is refused'); });
      assert.deepEqual(asked, []);
    }
    assert.deepEqual(fetched.filter(url => url.endsWith('/other.ifc')), []);
    if (hash !== sha256) assert.match(useViewerStore.getState().error ?? '', /model link is incomplete or damaged/);
  });
}

it("a host request filed before the viewer mounts also wins over ?model= in the page URL", async () => {
  stubWebGpu();
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => { fetched.push(String(input)); return new Response(null, { status: 404 }); }) as typeof fetch;
  const infos: unknown[][] = [];
  mock.method(console, 'info', (...args: unknown[]) => { infos.push(args); });
  try {
    window.history.replaceState(null, '', '/?model=other.ifc');
    openProcessedModel({ sha256, bytes: 7_000_000, name: 'From the host.ifc' });
    await act(async () => { root.render(<><Probe fromUrl /><ModelUrlEntry /></>); });
    await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'the host model loads'); });
    assert.deepEqual(asked, [{ sha256, bytes: 7_000_000 }]);
    assert.deepEqual(fetched.filter((url) => url.includes('other.ifc')), [], '?model= is not fetched');
    assert.equal(infos.filter((args) => /\?model= .*ignored/.test(String(args[0]))).length, 1, 'logged once');
  } finally { globalThis.fetch = realFetch; }
});


// #10142: the serverUrl option belongs to its request; without one the load asks the global server.
for (const override of [undefined, '/host-processor']) {
  it(`asks the request's server, else the global one at load time, also on Retry (override ${override}, #10142)`, async () => {
    stubWebGpu();
    mock.method(console, 'error', () => {});
    setProcessingServerUrl('');
    openProcessedModel({ sha256, bytes: 7_000_000, name: 'host.ifc' }, { serverUrl: override });
    setProcessingServerUrl('/set-after-filing'); // a host may name the server after asking for the model
    let attempts = 0;
    mock.method(IfcServerClient.prototype, 'parseParquet', async function (this: IfcServerClient) {
      servers.push((this as unknown as { baseUrl: string }).baseUrl);
      if (++attempts === 1) throw new IfcServerError('temporary', 503, 'OVERLOADED');
      return stored();
    });
    await act(async () => { root.render(<Probe fromUrl />); });
    await act(async () => { await waitFor(() => !!useViewerStore.getState().lastLoadRetry, 'Retry appears'); });
    setProcessingServerUrl('/changed-again');
    await act(async () => { useViewerStore.getState().lastLoadRetry!(); });
    await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'Retry completes'); });
    assert.deepEqual(servers, override ? [override, override] : ['/set-after-filing', '/changed-again']);
  });
}
