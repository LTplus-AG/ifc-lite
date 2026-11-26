/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
(globalThis as unknown as { __VITE_ENV__?: Record<string, unknown> }).__VITE_ENV__ = {
  MODE: 'test', DEV: false, PROD: false, VITE_USE_SERVER: 'true', VITE_IFC_SERVER_URL: 'http://localhost:49159',
};
import { afterEach, beforeEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { zipSync, strToU8 } from 'fflate';
import type { Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from './useBCF.js';
import { recordModelLoadedSnapshot, getModelLoadedSnapshot } from '@/utils/loadTelemetry.js';
import { IfcServerClient } from '@ifc-lite/server-client';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { click, waitFor } from '@/test/render.js';
import { loadDialogs } from '@/test/dialog-host.js';
const { useIfcLoader } = await import('./useIfcLoader.js');
const { getProcessingServerUrl, setProcessingServerUrl } = await import('@/lib/processed-model');
const step = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
let api: ReturnType<typeof useIfcLoader>;
let root: Root, container: HTMLDivElement;
let healthCalls = 0, previousServerUrl = '';
function Probe() { api = useIfcLoader(); return null; }
beforeEach(async (context) => {
  healthCalls = 0;
  previousServerUrl = getProcessingServerUrl();
  setProcessingServerUrl(`/admission-server-case-${encodeURIComponent(context.name)}`);
  useViewerStore.getState().resetViewerState(); useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ ...fixtureModels(fixtureModel('existing')), mergeLayers: false });
  mock.method(IfcServerClient.prototype, 'health', async () => { healthCalls++; throw new Error('connection refused'); });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const { ConfirmDialogHost } = await loadDialogs();
  await act(async () => { root.render(<><Probe /><ConfirmDialogHost /></>); });
});
afterEach(async () => {
  setProcessingServerUrl(previousServerUrl);
  useViewerStore.getState().activeLoadCanceller?.();
  await act(async () => root.unmount()); container.remove(); setGlobalRendererRef({ current: null }); mock.restoreAll();
});

it('#10596 runs the replacement guard after preflight and preserves the open scene on refusal', async () => {
  const oldModel = useViewerStore.getState().models.get('existing');
  const file = new File([step], 'replacement.ifc');
  const readHeader = mock.method(file, 'slice');
  const errors: string[] = [];
  let guardCallCount = 0;
  await act(async () => {
    await api.loadFile(file, { kind: 'primary', modelId: 'replacement' }, {
      beforePrimaryReset: () => {
        guardCallCount++;
        assert.ok(readHeader.mock.callCount() > 0);
        throw new Error('The current model was edited during preflight');
      },
      onLoadError: message => errors.push(message),
    });
  });
  assert.equal(guardCallCount, 1);
  assert.match(errors[0] ?? '', /edited during preflight/);
  assert.equal(useViewerStore.getState().models.get('existing'), oldModel);
  assert.equal(useViewerStore.getState().models.has('replacement'), false);
});

for (const kind of ['primary', 'federated'] as const) for (const archive of ['step', 'zip-file', 'zip-expanded'] as const) for (const memory of [8, 4]) {
  it(`#10264 ${kind} ${archive}: server fallback ${memory === 8 ? 'Cancel' : 'refusal'} preserves existing models before acquisition`, async () => {
    const oldMemory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: memory });
    const bytes = archive === 'step' ? strToU8(step) : zipSync({ 'model.ifc': strToU8(step) });
    if (archive === 'zip-expanded') {
      // A small archive declaring an over-budget model must stop without inflation.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const directory = view.getUint32(bytes.length - 22 + 16, true);
      view.setUint32(directory + 24, 1.26e9, true);
    }
    const file = new File([bytes as BlobPart], archive === 'step' ? 'large.ifc' : 'large.ifcZIP');
    const content = new Blob([bytes as BlobPart]);
    Object.defineProperty(file, 'slice', { value: content.slice.bind(content) });
    if (archive !== 'zip-expanded') Object.defineProperty(file, 'size', { value: 1.26e9 });
    else assert.ok(file.size < 4096, 'compressed input itself is well below the warning threshold');
    let reads = 0;
    const read = file.arrayBuffer.bind(file), stream = file.stream.bind(file);
    Object.defineProperty(file, 'arrayBuffer', { value: () => { reads++; return read(); } });
    Object.defineProperty(file, 'stream', { value: () => { reads++; return stream(); } });
    const models = useViewerStore.getState().models, active = useViewerStore.getState().activeModelId;
    const snapshot = { fileSizeMB: 7, totalTriangles: 12 };
    recordModelLoadedSnapshot(snapshot);
    const providerWrites = mock.fn<ReturnType<Renderer['getScene']>['setColdGeometryProvider']>();
    const drains = mock.fn(async () => {});
    const scene = { setColdGeometryProvider: providerWrites, drainColdTier: drains };
    setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
    const errors: string[] = [];
    const realShared = globalThis.SharedArrayBuffer;
    const allocations: number[] = [];
    Object.defineProperty(globalThis, 'SharedArrayBuffer', { configurable: true, writable: true,
      value: function (size: number) { allocations.push(size); return new realShared(Math.min(size, bytes.byteLength)); } });
    try {
      let pending: Promise<void> | undefined;
      await act(async () => { pending = api.loadFile(file, kind === 'primary' ? { kind } : { kind, modelId: 'admission-candidate' }, { onLoadError: message => errors.push(message) }); });
      if (memory === 8) {
        await waitFor(() => !!document.querySelector('[role="alertdialog"]'), 'local memory warning after server failure');
        assert.equal(useViewerStore.getState().models, models, 'opening the warning must not replace existing models');
        click(document.querySelector('[role="alertdialog"] button')!);
      }
      await act(async () => { await pending; });
      assert.equal(reads, 0, 'no whole-source acquisition, including a ZIP archive, before the decision');
      assert.deepEqual(allocations.filter(size => size >= 1024 * 1024), [], 'no file-sized source allocation');
      assert.equal(useViewerStore.getState().models, models, 'Cancel/refusal preserves existing model identities');
      assert.equal(useViewerStore.getState().activeModelId, active);
      assert.equal(getModelLoadedSnapshot(), snapshot, 'Cancel/refusal retains the displayed model telemetry');
      assert.equal(providerWrites.mock.callCount(), 0, 'Cancel/refusal must not invalidate the displayed cold geometry');
      assert.equal(drains.mock.callCount(), 0, 'Cancel/refusal must not drain the existing cold tier');
      assert.equal(useViewerStore.getState().loading, false);
      if (memory === 4) { assert.equal(errors.length, 1); assert.match(errors[0], /local processing memory budget/); }
      else { assert.equal(errors.length, 0); assert.equal(useViewerStore.getState().error, null); }
      assert.equal(healthCalls, kind === 'primary' ? 1 : 0, 'this case independently exercises its eligible server route');
    } finally {
      Object.defineProperty(globalThis, 'SharedArrayBuffer', { configurable: true, writable: true, value: realShared });
      if (oldMemory) Object.defineProperty(navigator, 'deviceMemory', oldMemory); else Reflect.deleteProperty(navigator, 'deviceMemory');
    }
  });
}

for (const provisional of [true, false]) it(`#10264 preflight marks only an unadmitted provisional source, provisional=${provisional}`, async () => {
  const oldMemory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
  Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 4 });
  const source = new File([step], 'refused-source.ifc'), blob = new Blob([step]);
  Object.defineProperty(source, 'size', { value: 1.26e9 });
  Object.defineProperty(source, 'slice', { value: blob.slice.bind(blob) });
  let reads = 0;
  Object.defineProperty(source, 'arrayBuffer', { value: () => { reads++; throw new Error('unadmitted source read'); } });
  const candidate = { ...fixtureModel('candidate'), sourceFile: source, loadState: provisional ? 'pending' as const : 'complete' as const, geometryResult: null };
  useViewerStore.setState(fixtureModels(candidate));
  const errors: string[] = [];
  try {
    await act(async () => { await api.loadFile(source, { kind: 'primary', modelId: 'candidate' }, { onLoadError: message => errors.push(message) }); });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /local processing memory budget/);
    assert.equal(reads, 0);
    assert.equal(useViewerStore.getState().models.get('candidate')?.sourceReadRefused, provisional ? true : undefined,
      'refusal must never poison an already admitted model, even when the retry reuses its File and ID');
  } finally {
    if (oldMemory) Object.defineProperty(navigator, 'deviceMemory', oldMemory); else Reflect.deleteProperty(navigator, 'deviceMemory');
  }
});
