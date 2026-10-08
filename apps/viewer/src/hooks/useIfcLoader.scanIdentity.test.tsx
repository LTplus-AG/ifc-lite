/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6887: the real `useIfcLoader().loadFile` binds a streamed scan's identity.
 *
 * `bindPointCloudIdentity` is unit-tested on its own (`ingest/pointCloudIdentity.test.ts`),
 * but those tests replay the finalize steps by hand (`test/scan-federation.ts`),
 * so deleting or reordering the call in `loadFile` kept every one of them
 * green. This drives the production entry point: a federated LAS scan loaded
 * after an IFC model must come out of `loadFile` with the renderer asset
 * carrying (a) the global expressId that resolves back to the scan's model and
 * (b) the scan's own model index. Without the bind the asset keeps its local
 * synthetic id and an unset model index, which a pick or the Deviation CSV
 * readback reports as model 0, the IFC model.
 *
 * Real: `loadFile`, the format dispatch, `ingestPointCloud`, the LAS decoder
 * (run by `decode-worker.ts` itself), a real `Renderer` with a live
 * `PointCloudRenderer`, the store and the federation registry. Faked: the
 * browser's `Worker` (an in-thread loop to the real decode worker's message
 * handler, since node has no Worker) the GPU device, and `Renderer.whenReady`. The IFC model is
 * seeded into the store; a real STEP load needs the wasm engine, which this
 * harness cannot start (see `useIfcLoader.federatedIdOffset.test.tsx`).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { __resetSharedSessionForTests } from '../../../../packages/pointcloud/dist/streaming/worker-client.js';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { addIfcModel, readbackIdentities, scanTestRenderer } from '@/test/scan-federation';
import { useIfcLoader } from './useIfcLoader.js';
import { setGlobalRendererRef } from './useBCF.js';
import { removePointCloudScanCache } from './ingest/pointCloudScanCache.js';
import { unregisterPointCloudAlignment } from './ingest/pointCloudAlignment.js';

const POINTS: Array<[number, number, number]> = [[-5, 0, 1], [2, 3, 4], [5, -5, 0], [0, 0, 0], [1, 1, 1]];

/** LAS 1.2, point format 0, scale 1, offset 0. */
function lasFile(name: string): File {
  const headerSize = 227, recordLen = 20;
  const view = new DataView(new ArrayBuffer(headerSize + POINTS.length * recordLen));
  view.setUint32(0, 0x4653414c, true);
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint16(105, recordLen, true);
  view.setUint32(107, POINTS.length, true);
  for (const at of [131, 139, 147]) view.setFloat64(at, 1, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(179 + axis * 16, Math.max(...POINTS.map((p) => p[axis])), true);
    view.setFloat64(187 + axis * 16, Math.min(...POINTS.map((p) => p[axis])), true);
  }
  POINTS.forEach((p, i) => p.forEach((v, axis) => view.setInt32(headerSize + i * recordLen + axis * 4, v, true)));
  return new File([view.buffer], name);
}

/**
 * A `Worker` whose far end is the real `decode-worker.ts`: that module talks
 * to `self`, so `self` is a scope that loops its `postMessage` back to the
 * client's `message` listeners and feeds the client's `postMessage` into the
 * worker's `onmessage`.
 */
function installInThreadDecodeWorker(): () => void {
  const globals = globalThis as Record<string, unknown>;
  const savedWorker = globals.Worker;
  const selfDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const listeners = new Set<(event: MessageEvent) => void>();
  const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(data: unknown): void } = {
    onmessage: null,
    postMessage(data) { queueMicrotask(() => listeners.forEach((l) => l({ data } as MessageEvent))); },
  };
  Object.defineProperty(globalThis, 'self', { value: scope, configurable: true, writable: true });
  class InThreadWorker {
    addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === 'message') listeners.add(listener); }
    removeEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === 'message') listeners.delete(listener); }
    postMessage(data: unknown) { queueMicrotask(() => scope.onmessage?.({ data })); }
    terminate() {}
  }
  globals.Worker = InThreadWorker;
  return () => {
    globals.Worker = savedWorker;
    if (selfDescriptor) Object.defineProperty(globalThis, 'self', selfDescriptor);
  };
}

/** A variable specifier: the worker module declares its own `self` type, which must stay out of the viewer's tsc program. */
const DECODE_WORKER = '../../../../packages/pointcloud/src/streaming/decode-worker.ts';

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let restoreWorker: (() => void) | null = null;
let scanRenderer: ReturnType<typeof scanTestRenderer> | null = null;
const handles: number[] = [];

beforeEach(async () => {
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  scanRenderer = scanTestRenderer();
  // `Renderer.init` (the WebGPU adapter) never runs here, so readiness would never publish.
  scanRenderer.renderer.whenReady = async () => {};
  setGlobalRendererRef({ current: scanRenderer.renderer as Renderer });
  // The worker module registers `self.onmessage` when first imported, so the
  // fake scope must be in place before that import.
  __resetSharedSessionForTests();
  restoreWorker = installInThreadDecodeWorker();
  await import(`${DECODE_WORKER}?scope=${Date.now()}-${Math.random()}`);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
  assert.ok(hookApi, 'the hook must expose loadFile');
});

afterEach(async () => {
  for (const id of handles.splice(0)) { removePointCloudScanCache(id); unregisterPointCloudAlignment(id); }
  restoreWorker?.();
  restoreWorker = null;
  setGlobalRendererRef({ current: null });
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
});

describe('useIfcLoader.loadFile binds a streamed scan identity (#6887)', () => {
  it('a federated LAS after an IFC model: the asset carries the scan\'s global id range and model index 1', async () => {
    const { points } = scanRenderer!;
    const ifc = addIfcModel('ifc', [{ expressId: 1, type: 'IfcWall' }, { expressId: 40, type: 'IfcSlab' }]);

    await act(async () => {
      await hookApi!.loadFile(lasFile('scan.las'), { kind: 'federated', modelId: 'scan', name: 'scan.las' });
    });

    const state = useViewerStore.getState();
    const scan = state.models.get('scan');
    assert.ok(scan, 'the scan registered as a model');
    assert.notEqual(scan.loadState, 'error', `the scan loaded (${scan.loadError ?? ''})`);
    if (scan.pointCloudHandleId !== undefined) handles.push(scan.pointCloudHandleId);
    assert.equal(points.getPointCount(), POINTS.length, 'the real decoder streamed every point through the loader');
    assert.ok(scan.idOffset > ifc.maxExpressId, 'the scan\'s global id range sits past the IFC model\'s');

    const nodes = readbackIdentities(points);
    assert.equal(nodes.length, 1, 'one renderer asset');
    const [asset] = nodes;
    assert.ok(asset.expressId > scan.idOffset, 'the asset id is in the scan\'s global range (not the local synthetic id)');
    assert.equal(asset.expressId, scan.geometryResult?.pointClouds?.[0].expressId, 'the asset id is the descriptor\'s global id');
    assert.equal(state.resolveGlobalIdFromModels(asset.expressId)?.modelId, 'scan', 'the id resolves back to the scan, not the IFC model');
    assert.equal(asset.modelIndex, modelIndices(state.models).get('scan'), 'the asset reports the model\'s own index');
    assert.equal(asset.modelIndex, 1, 'second model, so index 1: not the readback default 0 (the IFC model)');
  });
});

// #6952: a published primary placeholder is not completion when its stream aborts.
it('a native point-cloud AbortError after model publication is journaled as cancelled', async () => {
  const renderer = scanRenderer!.renderer;
  const append = renderer.appendPointCloudChunk;
  let publishedAtAbort = false;
  renderer.appendPointCloudChunk = function (...args) {
    publishedAtAbort = useViewerStore.getState().models.has('cancelled-scan');
    append.apply(this, args);
    // Native upload boundary: a browser/GPU abort reaches the real stream and loader catch.
    throw new DOMException('Upload aborted', 'AbortError');
  };
  try {
    await act(async () => hookApi!.loadFile(lasFile('cancelled-scan.las'), { kind: 'primary', modelId: 'cancelled-scan' }));
    assert.equal(publishedAtAbort, true, 'the primary model was visible before the native abort');
    assert.equal(useViewerStore.getState().models.get('cancelled-scan')?.loadError, 'cancelled');
    const row = useActivityJournal.getState().jobs.find(job => job.subject === 'cancelled-scan.las');
    assert.ok(row);
    assert.equal(row.outcome, 'cancelled');
  } finally { renderer.appendPointCloudChunk = append; }
});
