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
import { GeometryProcessor } from '@ifc-lite/geometry';
import { IfcServerClient, type HealthResponse, type ParquetParseResponse } from '@ifc-lite/server-client';
import { useViewerStore } from '@/store';
const { useIfcLoader } = await import('./useIfcLoader.js');

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
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container); await act(async () => { root.render(<Probe />); });
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
