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
import { IfcServerClient, IfcServerError, type HealthResponse, type ParquetParseResponse } from '@ifc-lite/server-client';
import { useViewerStore } from '@/store';
import { waitFor } from '@/test/render.js';
import { propertyModelBuffer } from '../../../../packages/server-client/test/fixtures/property-model.js';
const { useIfcLoader } = await import('./useIfcLoader.js');
const { useProcessedModelAutoload } = await import('./useProcessedModelAutoload.js');
const { isStepSourceModel } = await import('@/components/viewer/step-export-source');
const { getReportPrompt, clearLoadReport } = await import('@/lib/error-reports/context');
const { applyProcessingConfig, openProcessedModel, setProcessingServerUrl, takeProcessedModelRequest } = await import('@/lib/processed-model');
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
  takeProcessedModelRequest(); setProcessingServerUrl('http://localhost:9999');
  useViewerStore.getState().clearAllModels();
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

it('a browser without Parquet support is told so instead of falling back to an upload', async () => {
  mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => false);
  mock.method(console, 'error', () => {});
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel }); });
  assert.equal(uploads, 0);
  assert.match(useViewerStore.getState().error ?? '', /cannot open processed models/);
  assert.equal(useViewerStore.getState().lastLoadRetry, null);
});

it('a model of unknown size streams, since the streamed route works at any size', async () => {
  let streamed: unknown;
  mock.method(IfcServerClient.prototype, 'parseParquetStream', async (source: unknown, onBatch: (batch: { meshes: ParquetParseResponse['meshes'] }) => void) => {
    streamed = source;
    onBatch({ meshes: stored().meshes });
    const { meshes: _meshes, parquet_stats: _stats, data_model: _dataModel, ...rest } = stored();
    return rest;
  });
  await act(async () => { root.render(<Probe />); });
  await act(async () => { await api!.loadFile(nameOnly(), { kind: 'primary' }, { processedModel: { sha256, bytes: 0 } }); });
  assert.deepEqual(streamed, { sha256, bytes: 0 });
  assert.deepEqual(asked, [], 'the one-shot route is not taken for an unknown size');
  assert.equal(model()?.loadState, 'complete');
  assert.equal(model()?.geometryResult?.meshes.length, 1);
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
    assert.deepEqual(asked, [{ sha256, bytes: 7_000_000 }]);
    assert.deepEqual(servers, [serverUrl], 'the runtime URL replaces the build-time one for this request');
    assert.equal(model()?.name, 'From the host.ifc');
    assert.equal(model()?.fileSize, 7_000_000);
    assert.equal(engineInits, 0);
    assert.equal(takeProcessedModelRequest(), null, 'a request is loaded once');
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

// Last in this file: a host's start model is fixed for the page, so nothing after this runs without it.
function BothUrlEntries() { useProcessedModelAutoload(); useModelUrlAutoload(); return null; }
it("with a host start model, ?processed= and ?model= in the page URL are ignored and only the host's model loads, from the host's server", async () => {
  stubWebGpu();
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => { fetched.push(String(input)); return new Response(null, { status: 404 }); }) as typeof fetch;
  const infos: unknown[][] = [];
  mock.method(console, 'info', (...args: unknown[]) => { infos.push(args); });
  try {
    window.history.replaceState(null, '', `/?processed=${'d'.repeat(64)}&bytes=9&model=other.ifc`);
    applyProcessingConfig({ server: { url: '/host-processor' }, open: { processedModel: { sha256, bytes: 46_000_000, name: 'Host model.ifc' } } });
    await act(async () => { root.render(<><Probe /><BothUrlEntries /></>); });
    await act(async () => { await waitFor(() => model()?.loadState === 'complete', 'the host model loads'); });
    assert.deepEqual(asked, [{ sha256, bytes: 46_000_000 }], 'only the host model is asked for');
    assert.deepEqual(servers, ['/host-processor'], "from the host's server");
    assert.equal(model()?.name, 'Host model.ifc');
    assert.deepEqual(fetched.filter((url) => url.includes('other.ifc')), [], '?model= is not fetched');
    const ignored = infos.map((args) => String(args[0])).filter((line) => /ignored/.test(line));
    assert.equal(ignored.length, 2, 'each ignored parameter logged once for the page');
    assert.ok(ignored.some((line) => line.includes('?processed=')) && ignored.some((line) => line.includes('?model=')), ignored.join('\n'));
  } finally { globalThis.fetch = realFetch; }
});
