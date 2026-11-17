/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { resetFeaturesForTest } from '@/lib/features';
import { createMainViewerToolHost } from './main-viewer-host';
import { dispatchMainViewerTool } from './main-viewer-dispatch';
import { viewerOperation } from './operations/registry';
import { operationArtifacts, listArtifacts, readArtifact, removeArtifact } from './operations/artifacts';
import type { OperationExecutionContext } from './operations/contract';
import type { ToolHost } from './types';

const initial = useViewerStore.getState();
let host: ToolHost;
let lifetime: AbortController;
beforeEach(() => {
  resetFeaturesForTest();
  lifetime = new AbortController();
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, mutationVersion: 0, envExposure: 1 });
  host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }), { lifetimeSignal: lifetime.signal });
});
afterEach(() => { mock.restoreAll(); lifetime.abort(); useViewerStore.setState(initial); resetFeaturesForTest(); });
const call = (id: string, input: Record<string, unknown>, signal?: AbortSignal, extra = {}) =>
  dispatchMainViewerTool(host, 'viewer_operation_execute', { operation_id: id, input, ...extra }, { signal, canEdit: () => true });

test('global viewer settings execute with no IFC model, and model operations still require a target', async () => {
  const result = await call('environment.exposure', { value: 1.2 });
  assert.equal(result.isError, false, result.text);
  assert.equal(useViewerStore.getState().envExposure, 1.2);
  assert.equal((await call('selection.replace', { express_ids: [1] })).isError, true);
  assert.equal((await call('environment.exposure', { value: 1.4 }, undefined, { model_id: 'fabricated' })).isError, true);
});

test('a signal aborted by the synchronous native store notification cannot report a committed write as cancelled', async () => {
  const controller = new AbortController();
  const unsubscribe = useViewerStore.subscribe(state => { if (state.envExposure === 1.3) controller.abort(); });
  try {
    const result = await call('environment.exposure', { value: 1.3 }, controller.signal);
    assert.equal(result.isError, false, result.text);
    assert.equal(useViewerStore.getState().envExposure, 1.3);
    assert.equal((result.structured as { committed: boolean }).committed, true);
  } finally { unsubscribe(); }
});

test('an admitted async native commit settles before cancellation and reports its actual durable outcome', async () => {
  const controller = new AbortController();
  let admitted!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { admitted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const operation = viewerOperation('environment.exposure');
  mock.method(operation, 'execute', async (_input: unknown, context: OperationExecutionContext) => context.commitAsync(async () => {
    admitted(); await gate;
    useViewerStore.getState().setEnvExposure(1.4);
    return viewerOperation('environment.read').execute({}, context);
  }));
  const pending = call('environment.exposure', { value: 1.4 }, controller.signal);
  await started; controller.abort(); release();
  const result = await pending;
  assert.equal(result.isError, false, result.text);
  assert.equal(useViewerStore.getState().envExposure, 1.4);
  assert.equal((result.structured as { committed: boolean }).committed, true);
});

test('a declined native async save does not claim that changes committed', async () => {
  mock.method(viewerOperation('environment.exposure'), 'execute', async (_input: unknown, context: OperationExecutionContext) =>
    context.commitAsync(async () => viewerOperation('environment.read').execute({}, context), () => false));
  const result = await call('environment.exposure', { value: 1.4 });
  assert.equal(result.isError, false, result.text);
  assert.equal((result.structured as { committed: boolean }).committed, false);
  assert.equal(useViewerStore.getState().envExposure, 1);
});

test('idempotent retries remain deduplicated after their own native revision changes', async () => {
  const operation = viewerOperation('environment.exposure');
  mock.method(operation, 'execute', async (_input: unknown, context: OperationExecutionContext) => context.commit(() => {
    const state = useViewerStore.getState();
    useViewerStore.setState({ envExposure: state.envExposure + 0.1, mutationVersion: state.mutationVersion + 1 });
    return { preset: state.envPreset, skyEnabled: state.envSkyEnabled, exposure: state.envExposure + 0.1,
      hardness: state.envHardness, softness: state.envSoftness, shadowsEnabled: state.envShadowsEnabled,
      sunAngle: state.envSunAngle, shadowResolution: state.envShadowResolution, sunTimeEnabled: state.envSunTimeEnabled, sunTime: state.envSunTime };
  }));
  const first = await call('environment.exposure', { value: 1.1 }, undefined, { idempotency_key: 'once', expected_revision: 0 });
  const second = await call('environment.exposure', { value: 1.1 }, undefined, { idempotency_key: 'once', expected_revision: 0 });
  assert.equal(first.isError, false, first.text); assert.equal(second.isError, false, second.text);
  assert.equal(useViewerStore.getState().mutationVersion, 1);
  assert.equal(useViewerStore.getState().envExposure, 1.1);
  assert.deepEqual(second.structured, first.structured);
});

test('artifacts are bounded, model independent, connection owned and removed on disconnect', async () => {
  const artifacts = operationArtifacts(host, write => write());
  const metadata = await artifacts.create({ filename: '../result.txt', mimeType: 'text/plain', data: 'Grüezi' });
  assert.equal(metadata.bytes, new TextEncoder().encode('Grüezi').length);
  assert.equal(metadata.filename.includes('/'), false);
  const first = await readArtifact(host, metadata.artifact_id, 0, 3);
  assert.equal(first.length, 3); assert.equal(first.next_offset, 3);
  assert.deepEqual([...Uint8Array.from(atob(first.data), ch => ch.charCodeAt(0))], [0x47, 0x72, 0xc3]);
  const long = await artifacts.create({ filename: `${'A'.repeat(80)}.csv`, mimeType: 'text/csv', data: 'a' });
  assert.match(long.filename, /\.csv$/, 'truncating a long name keeps its extension');
  const other = createMainViewerToolHost(useViewerStore, host.bim!);
  assert.deepEqual(listArtifacts(other), []);
  await assert.rejects(readArtifact(other, metadata.artifact_id, 0, 1), /Unknown artifact/);
  await assert.rejects(readArtifact(host, metadata.artifact_id, 0, 65537), /65536/);
  removeArtifact(host, metadata.artifact_id); removeArtifact(host, long.artifact_id);
  assert.deepEqual(listArtifacts(host), []);
  lifetime.abort();
  await assert.rejects(artifacts.create({ filename: 'closed.txt', mimeType: 'text/plain', data: 'no' }));
});

test('a browser download acknowledged during synchronous abort remains dispatched', async () => {
  const metadata = await operationArtifacts(host, write => write()).create({ filename: 'data.txt', mimeType: 'text/plain', data: 'data' });
  const controller = new AbortController();
  mock.method(URL, 'createObjectURL', () => 'blob:owned-download');
  const abort = () => controller.abort();
  document.addEventListener('click', abort, { once: true });
  try {
    const result = await dispatchMainViewerTool(host, 'viewer_artifact_download', { artifact_id: metadata.artifact_id }, { signal: controller.signal, canEdit: () => true });
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.isError, false, result.text);
    assert.equal((result.structured as { status: string }).status, 'dispatched');
  } finally { document.removeEventListener('click', abort); }
});

test('artifact download and deletion refuse a revoked grant even with a valid owned handle', async () => {
  const metadata = await operationArtifacts(host, write => write()).create({ filename: 'data.txt', mimeType: 'text/plain', data: 'kept' });
  for (const tool of ['viewer_artifact_download', 'viewer_artifact_delete']) {
    const result = await dispatchMainViewerTool(host, tool, { artifact_id: metadata.artifact_id }, { canEdit: () => false });
    assert.equal(result.errorCode, 'READ_ONLY');
  }
  assert.equal(listArtifacts(host).length, 1);
});
