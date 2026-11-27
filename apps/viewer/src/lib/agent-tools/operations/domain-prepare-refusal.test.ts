/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-fixture';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { ToolErrorCode } from '@ifc-lite/mcp/browser';
import { createBimContext } from '@ifc-lite/sdk';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { loadStoreyAdapter } from '@/sdk/adapters/store-adapter-storey';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { GROUND_STOREY, SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { createMainViewerToolHost } from '../main-viewer-host';
import type { ToolHost } from '../types';
import { clashSettings } from './clash-native';
import { executeOperationRequest } from './executor';
import { viewerOperation } from './registry';

const SOURCE = 'refusal-source';
const hostForFixture = () => createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
const request = (operation_id: string, input: unknown, model_id?: string) =>
  ({ operation_id, input, ...(model_id ? { model_id } : {}) });
const execute = (host: ToolHost, args: ReturnType<typeof request>, readOnly = true, signal = new AbortController().signal) =>
  executeOperationRequest(host, args, { signal, canEdit: () => true }, readOnly);

function nativeResult<T>(outcome: unknown): T {
  return JSON.parse((outcome as { result: { native_json: string } }).result.native_json) as T;
}

/** Abort after the real handler stores its candidate and before the executor accepts its result. */
async function refusedToken(host: ToolHost, args: ReturnType<typeof request>, readOnly = true) {
  const controller = new AbortController();
  const entry = viewerOperation(args.operation_id);
  const handler = entry.execute.bind(entry);
  let token: string | undefined;
  const spy = mock.method(entry, 'execute', async (...input: Parameters<typeof handler>) => {
    const result = await handler(...input);
    token = nativeResult<{ token: string }>({ result }).token;
    controller.abort();
    return result;
  });
  try {
    await assert.rejects(execute(host, args, readOnly, controller.signal), { code: ToolErrorCode.CANCELLED });
    assert.ok(token, 'the prepare completed and returned a candidate token');
    return token;
  } finally {
    spy.mock.restore();
  }
}

async function seedTexturedSource() {
  const { dataStore } = await seedAuthoringSample();
  const asset = await appearanceAssets.add(
    Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0)),
    { owner: { kind: 'source', id: SOURCE }, mimeType: 'image/png' },
  );
  modelAppearanceAssets.registerAuthored(SOURCE, SOURCE, [asset.id]);
  const mesh: MeshData = {
    expressId: 10,
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, -2]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    color: [1, 1, 1, 1],
    textureRef: { textureId: 1, url: modelAppearanceAssets.getAuthoredUri(SOURCE, asset.id), repeatS: false, repeatT: false },
  };
  const state = useViewerStore.getState(), target = state.models.get(SAMPLE_MODEL)!;
  const source = {
    ...fixtureModel(SOURCE, { idOffset: 1_000_000 }),
    ifcDataStore: null,
    sourceFile: new File(['source identity fixture'], 'scan.glb'),
    geometryResult: { ...target.geometryResult!, meshes: [mesh], totalTriangles: 1, totalVertices: 3 },
  };
  useViewerStore.setState({
    models: new Map(state.models).set(SAMPLE_MODEL, { ...target, schemaVersion: 'IFC4' }).set(SOURCE, source),
    modelPlacement: emptyPlacementState(),
  });
  return { host: hostForFixture(), containerId: dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY) };
}

afterEach(() => {
  modelAppearanceAssets.unregisterAuthored(SOURCE, SOURCE);
  appearanceAssets.clear();
});

it('#11028: a refused storey prepare leaves no candidate to apply', async () => {
  const { dataStore } = await seedAuthoringSample();
  await loadStoreyAdapter();
  const host = hostForFixture();
  const prepare = request('storeys.prepare', {
    kind: 'add', express_id: 0,
    params_json: JSON.stringify({ Name: 'Level 1', Elevation: 3, referenceStoreyId: dataStore.entities.getExpressIdByGlobalId(GROUND_STOREY) }),
  }, SAMPLE_MODEL);
  const token = await refusedToken(host, prepare);
  await assert.rejects(execute(host, request('storeys.apply', { token }, SAMPLE_MODEL), false), /Unknown native Storey candidate/);
  const delivered = nativeResult<{ token: string; plan: { refusal: unknown } }>(await execute(host, prepare));
  assert.equal(delivered.plan.refusal, null);
  await execute(host, request('storeys.apply', { token: delivered.token }, SAMPLE_MODEL), false);
});

it('#11028: a refused clash classification prepare leaves no review to sample', async () => {
  await seedCoincidentWalls(2);
  const state = useViewerStore.getState();
  state.clearClashExclusions();
  state.setClashMode('hard');
  state.setClashTolerance(0.002);
  state.setClashReportTouch(false);
  const host = hostForFixture();
  await execute(host, request('clash.run', {
    kind: 'all', preset_id: '', expected_model_ids: [...state.models.keys()], expected_settings: JSON.stringify(clashSettings()),
  }), false);
  const prepare = request('clash.classification.prepare', {});
  const answer = JSON.stringify({ version: 1, kind: 'clash.groups',
    groups: [{ name: 'Collision', explanation: 'Coincident walls', citations: ['E1'] }] });
  const sample = (token: string) => execute(host, request('clash.classification.sample', { token, answer }), false);
  await assert.rejects(sample(await refusedToken(host, prepare, false)), {
    code: 'INVALID_INPUT', details: { reason: 'unknown-target' },
  });
  await sample(nativeResult<{ token: string }>(await execute(host, prepare, false)).token);
});

it('#11028: a refused appearance capture prepare leaves no candidate to discard', async () => {
  const { host, containerId } = await seedTexturedSource();
  const prepare = request('appearance.capture.prepare', {
    source_model_id: SOURCE, mesh_ordinal: 0, triangles: [0], container_id: containerId, Name: 'Reviewed triangle',
  }, SAMPLE_MODEL);
  const discard = (token: string) => execute(host, request('appearance.capture.discard', { token }, SAMPLE_MODEL), false);
  await assert.rejects(discard(await refusedToken(host, prepare)), /Unknown capture candidate/);
  const delivered = nativeResult<{ token: string; triangles: number }>(await execute(host, prepare));
  assert.equal(delivered.triangles, 1);
  assert.deepEqual(nativeResult(await discard(delivered.token)), { discarded: true });
});

it('#11028: a refused appearance scan prepare leaves no session to inspect', async () => {
  const { host } = await seedTexturedSource();
  const prepare = request('appearance.scan.prepare', { source_model_id: SOURCE, source_kind: 'mesh', mesh_ordinal: 0 }, SAMPLE_MODEL);
  const inspect = (token: string) => execute(host, request('appearance.scan.inspect', { token, version: 0 }, SAMPLE_MODEL));
  await assert.rejects(inspect(await refusedToken(host, prepare)), /Unknown scan session/);
  const delivered = nativeResult<{ token: string }>(await execute(host, prepare));
  const session = nativeResult<{ token: string; stale: string | null }>(await inspect(delivered.token));
  assert.equal(session.token, delivered.token);
  assert.equal(session.stale, null);
});
