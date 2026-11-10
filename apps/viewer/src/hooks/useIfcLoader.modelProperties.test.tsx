/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
(globalThis as unknown as { __VITE_ENV__?: Record<string, unknown> }).__VITE_ENV__ = {
  MODE: 'test', DEV: false, PROD: false, VITE_IFC_SERVER_URL: 'http://localhost:9999', VITE_USE_SERVER: 'true',
};
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcServerClient, type HealthResponse, type ParquetParseResponse } from '@ifc-lite/server-client';
import { useViewerStore } from '@/store';
import { propertyModelBuffer } from '../../../../packages/server-client/test/fixtures/property-model.js';
const { useIfcLoader } = await import('./useIfcLoader.js');
const wire = propertyModelBuffer();
// Adopted from the independent #9538 real-loader re-review probe.
const roots: Root[] = [];
const containers: HTMLElement[] = [];
const pendingReleases: ((bytes: ArrayBuffer) => void)[] = [];
afterEach(async () => {
  for (const release of pendingReleases.splice(0)) release(wire);
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  useViewerStore.getState().clearAllModels();
  mock.restoreAll();
});
const R: ParquetParseResponse = {
  meshes: [{ express_id: 1, ifc_type: 'IFCWALL', positions: new Float32Array([0,0,0,1,0,0,0,1,0]), normals: new Float32Array([0,0,1,0,0,1,0,0,1]), indices: new Uint32Array([0,1,2]), color: [0.5,0.25,0.125,1] }],
  cache_key: 'k', metadata: { schema_version: 'IFC4', entity_count: 1, geometry_entity_count: 1, coordinate_info: { origin_shift: [0,0,0], is_geo_referenced: false } },
  stats: { total_meshes: 1, total_vertices: 3, total_triangles: 1, parse_time_ms: 1, geometry_time_ms: 1, total_time_ms: 2, from_cache: false },
  parquet_stats: { payload_size: 0, decode_time_ms: 0 },
};
const file = (n: string) => new File(["ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;"], n);
for (const mode of ['stay', 'remount', 'unmount'] as const) {
  it(`#9538 real loader publishes late properties (${mode})`, async () => {
    useViewerStore.getState().resetViewerState(); useViewerStore.getState().clearAllModels();
    let release!: (b: ArrayBuffer) => void; let entered!: () => void; let sig: AbortSignal | undefined;
    const ready = new Promise<void>(r => { entered = r; });
    mock.method(IfcServerClient.prototype, 'health', async () => ({ status: 'ok' }) as HealthResponse);
    mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => true);
    mock.method(IfcServerClient.prototype, 'parseParquet', async () => R);
    mock.method(IfcServerClient.prototype, 'fetchDataModel', async (_k: string, o?: { signal?: AbortSignal }) => { sig = o?.signal; entered(); return new Promise<ArrayBuffer>(r => { release = r; pendingReleases.push(r); }); });
    let api: ReturnType<typeof useIfcLoader> | undefined;
    function Probe() { api = useIfcLoader(); return null; }
    const c = document.createElement('div'); document.body.appendChild(c);
    const root = createRoot(c); roots.push(root); containers.push(c); await act(async () => { root.render(<Probe />); });
    await act(async () => { await api!.loadFile(file('a.ifc')); await ready; });
    const id = [...useViewerStore.getState().models.keys()][0];
    assert.equal(useViewerStore.getState().models.get(id)?.loadState, 'complete');
    if (mode !== 'stay') await act(async () => { root.render(null); });
    if (mode === 'remount') await act(async () => { root.render(<Probe />); });
    assert.equal(sig?.aborted, false);
    await act(async () => { release(wire); await new Promise(r => setTimeout(r, 300)); });
    assert.equal(useViewerStore.getState().models.get(id)?.ifcDataStore?.entities.getName(1), 'Server properties');
    assert.equal(useViewerStore.getState().ifcDataStore?.entities.getName(1), 'Server properties');
  });
}
it('#9538 real loader: second primary load from another hook instance aborts the first poll; first late result cannot publish', async () => {
  useViewerStore.getState().resetViewerState(); useViewerStore.getState().clearAllModels();
  const releases: ((b: ArrayBuffer) => void)[] = []; const sigs: AbortSignal[] = [];
  mock.method(IfcServerClient.prototype, 'health', async () => ({ status: 'ok' }) as HealthResponse);
  mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => true);
  mock.method(IfcServerClient.prototype, 'parseParquet', async () => R);
  mock.method(IfcServerClient.prototype, 'fetchDataModel', async (_k: string, o?: { signal?: AbortSignal }) => { sigs.push(o!.signal!); return new Promise<ArrayBuffer>(r => { releases.push(r); pendingReleases.push(r); }); });
  let a: ReturnType<typeof useIfcLoader> | undefined, b: ReturnType<typeof useIfcLoader> | undefined;
  function A() { a = useIfcLoader(); return null; } function B() { b = useIfcLoader(); return null; }
  const c = document.createElement('div'); document.body.appendChild(c);
  const root = createRoot(c); roots.push(root); containers.push(c); await act(async () => { root.render(<><A /><B /></>); });
  await act(async () => { await a!.loadFile(file('a.ifc')); await new Promise(r => setTimeout(r, 50)); });
  await act(async () => { await b!.loadFile(file('b.ifc')); await new Promise(r => setTimeout(r, 50)); });
  assert.equal(sigs.length, 2); assert.equal(sigs[0].aborted, true); assert.equal(sigs[1].aborted, false);
  const id = [...useViewerStore.getState().models.keys()][0];
  await act(async () => { releases[0](wire); await new Promise(r => setTimeout(r, 300)); });
  assert.equal(useViewerStore.getState().models.get(id)?.ifcDataStore ?? null, null);
  await act(async () => { releases[1](wire); await new Promise(r => setTimeout(r, 300)); });
  assert.equal(useViewerStore.getState().models.get(id)?.ifcDataStore?.entities.getName(1), 'Server properties');
  assert.equal(useViewerStore.getState().serverPropertiesRuns.size <= 1, true);
});
