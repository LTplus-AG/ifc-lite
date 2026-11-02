/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8565: Gaussian PLY through the real `useIfcLoader().loadFile`, mounted.
 * What is real and what is faked is listed in `test/gaussian-loader-harness.ts`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { addIfcModel } from '@/test/scan-federation';
import { gaussianPly, gaussianTestRenderer, installInThreadGaussianWorker } from '@/test/gaussian-loader-harness';
import { useIfcLoader } from './useIfcLoader.js';
import { setGlobalRendererRef } from './useBCF.js';

const QUALIFIED = { gaussianQualification: 'internal-unqualified' } as const;
const CENTRES: Array<[number, number, number]> = [[1, 2, 3], [4, 5, 6], [-2, 0, 1]];

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null { hookApi = useIfcLoader(); return null; }

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let worker: ReturnType<typeof installInThreadGaussianWorker>;
let gpu: ReturnType<typeof gaussianTestRenderer>;

const splats = () => gpu.renderer.gaussianSplats;
const model = (id: string) => useViewerStore.getState().models.get(id);
const load = (file: File, target: Parameters<NonNullable<typeof hookApi>['loadFile']>[1], options?: Parameters<NonNullable<typeof hookApi>['loadFile']>[2]) =>
  act(async () => { await hookApi!.loadFile(file, target, options); });

/** No load left a slot held: with no models the shared allocator resets to 0. */
function assertNoHeldSlot(): void {
  modelIndices(new Map());
  assert.equal(modelIndices(new Map([['probe', 1]])).get('probe'), 0, 'a held model-index reservation blocked the reset');
  modelIndices(new Map());
}

beforeEach(async () => {
  hookApi = null;
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
  gpu = gaussianTestRenderer();
  setGlobalRendererRef({ current: gpu.renderer as Renderer });
  worker = installInThreadGaussianWorker();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
  assert.ok(hookApi);
});

afterEach(async () => {
  worker.restore();
  setGlobalRendererRef({ current: null });
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
});

describe('Gaussian captures through the canonical loader (#8565)', () => {
  it('public loads refuse before any worker, renderer asset or model slot exists', async () => {
    await load(gaussianPly('capture.ply', CENTRES), { kind: 'primary', modelId: 'public' });
    assert.match(String(useViewerStore.getState().error), /disabled pending the native rendering contract/);
    assert.equal(model('public')?.loadState, 'error');
    assert.equal(worker.stats.created, 0, 'no decoder worker for a refused capture');
    assert.equal(splats().getStats().assets, 0);
    await load(gaussianPly('added.ply', CENTRES), { kind: 'federated', modelId: 'public-add' });
    assert.equal(model('public-add'), undefined, 'a refused federated add registers nothing');
    assertNoHeldSlot();
  });

  it('a standalone capture publishes the exact renderer handle and frees it with its model', async () => {
    await load(gaussianPly('capture.ply', CENTRES), { kind: 'primary', modelId: 'capture' }, QUALIFIED);
    const capture = model('capture');
    assert.equal(capture?.loadState, 'complete', String(capture?.loadError));
    const record = capture.gaussianSplat;
    assert.ok(record && Object.isFrozen(record.handle), 'the renderer-issued frozen handle itself');
    assert.equal(splats().getState(record.handle).state, 'resident');
    assert.equal(record.handle.modelIndex, modelIndices(useViewerStore.getState().models).get('capture'));
    assert.deepEqual({ count: record.count, shDegree: record.shDegree, format: record.format, origin: record.placementOrigin, calibration: record.calibration },
      { count: 3, shDegree: 0, format: 'gaussian-ply', origin: 'source', calibration: 'uncalibrated' });
    assert.deepEqual(record.sourceCenterBounds, { min: [-2, 0, 1], max: [4, 5, 6] });
    assert.deepEqual(splats().getBounds(record.handle), { min: [-2, 0, 1], max: [4, 5, 6] }, 'identity placement: raw source coordinates');
    assert.equal(capture.ifcDataStore?.entityCount ?? 0, 0, 'no IFC entity row is invented for a capture');
    assert.equal(capture.loadPath, 'gaussian');
    assert.match(String(capture.sourceFingerprint), /^capture\.ply:/);
    assert.deepEqual([worker.stats.created, worker.stats.terminated], [1, 1], 'the dedicated worker ends with its request');
    assert.equal(useViewerStore.getState().loading, false);

    useViewerStore.getState().setModelVisibility('capture', false);
    assert.equal(splats().getStats().visibleAssetSplats, 0, 'model visibility reaches the renderer in the same tick');
    useViewerStore.getState().setModelVisibility('capture', true);
    assert.equal(splats().getStats().visibleAssetSplats, 3);
    useViewerStore.getState().removeModel('capture');
    assert.equal(splats().getState(record.handle).state, 'invalid', 'removal frees the asset synchronously');
    assert.equal(splats().getStats().assets, 0);
    assertNoHeldSlot();
  });

  it('IFC-first, splat-first and N captures keep the index each model is registered under', async () => {
    addIfcModel('ifc', [{ expressId: 7, type: 'IfcWall' }]);
    await load(gaussianPly('a.ply', CENTRES), { kind: 'federated', modelId: 'a', name: 'a.ply' }, QUALIFIED);
    await load(gaussianPly('b.ply', [[10, 0, 0]]), { kind: 'federated', modelId: 'b', name: 'b.ply' }, QUALIFIED);
    const indices = modelIndices(useViewerStore.getState().models);
    const [a, b] = [model('a')!.gaussianSplat!, model('b')!.gaussianSplat!];
    assert.deepEqual([a.handle.modelIndex, b.handle.modelIndex], [indices.get('a'), indices.get('b')]);
    assert.deepEqual([indices.get('ifc'), indices.get('a'), indices.get('b')], [0, 1, 2]);
    assert.equal(model('ifc')?.visible, true, 'the IFC model is untouched');
    useViewerStore.getState().isolateModels(['b']);
    assert.equal(splats().getStats().visibleAssetSplats, 1, 'isolating one capture hides the other');
    useViewerStore.getState().removeModel('a');
    assert.equal(splats().getState(a.handle).state, 'invalid');
    assert.equal(splats().getState(b.handle).state, 'resident', 'only the removed model loses its asset');

    // Splat-first: a primary capture replaces the scene, then a capture joins it.
    await load(gaussianPly('first.ply', CENTRES), { kind: 'primary', modelId: 'first' }, QUALIFIED);
    assert.equal(splats().getState(b.handle).state, 'invalid', 'a primary load frees the replaced scene');
    await load(gaussianPly('second.ply', [[0, 0, 0]]), { kind: 'federated', modelId: 'second' }, QUALIFIED);
    assert.equal(splats().getStats().assets, 2);
    useViewerStore.getState().clearAllModels();
    assert.equal(splats().getStats().assets, 0);
    assertNoHeldSlot();
  });

  it('cancelling during decode terminates the worker and publishes nothing', async () => {
    const release = worker.hold();
    await act(async () => {
      const pending = hookApi!.loadFile(gaussianPly('slow.ply', CENTRES), { kind: 'federated', modelId: 'slow' }, QUALIFIED);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(worker.stats.created, 1);
      useViewerStore.getState().activeLoadCanceller?.();
      release();
      await pending;
    });
    assert.equal(worker.stats.terminated, 1, 'cancellation terminates the busy worker');
    assert.equal(model('slow'), undefined);
    assert.equal(splats().getStats().assets, 0);
    assert.equal(useViewerStore.getState().loading, false);
    assertNoHeldSlot();
  });

  it('an upload that resolves after its load was superseded is removed by its exact handle', async () => {
    const release = gpu.backend.hold();
    await act(async () => {
      const stale = hookApi!.loadFile(gaussianPly('stale.ply', CENTRES), { kind: 'primary', modelId: 'stale' }, QUALIFIED);
      await new Promise(resolve => setTimeout(resolve, 50));
      const next = hookApi!.loadFile(gaussianPly('next.ply', [[9, 9, 9]]), { kind: 'primary', modelId: 'next' }, QUALIFIED);
      release();
      await Promise.all([stale, next]);
    });
    assert.equal(model('stale'), undefined);
    assert.equal(model('next')?.loadState, 'complete');
    assert.equal(splats().getStats().assets, 1, 'the superseded upload left no asset behind');
    assert.deepEqual(splats().getBounds(), { min: [9, 9, 9], max: [9, 9, 9] });
  });

  it('a lost device refuses before decoding; a rejected upload retains nothing', async () => {
    gpu.loseDevice();
    await load(gaussianPly('lost.ply', CENTRES), { kind: 'primary', modelId: 'lost' }, QUALIFIED);
    assert.match(String(useViewerStore.getState().error), /graphics device was lost/);
    assert.equal(worker.stats.created, 0);

    gpu = gaussianTestRenderer({ maxStorageBufferBindingSize: 16, maxBufferSize: 16 });
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    await load(gaussianPly('big.ply', CENTRES), { kind: 'federated', modelId: 'big' }, QUALIFIED);
    assert.match(String(useViewerStore.getState().error), /could not be loaded: .*byte binding/);
    assert.equal(model('big'), undefined);
    assert.equal(splats().getStats().assets, 0);
    assertNoHeldSlot();
  });

  it('a malformed capture keeps its admission reason, and an explicit placement is recorded as explicit', async () => {
    await load(new File([new Uint8Array(31)], 'broken.splat'), { kind: 'primary', modelId: 'broken' }, QUALIFIED);
    assert.match(String(useViewerStore.getState().error), /Truncated or empty \.splat/);
    assert.equal(worker.stats.created, 0);
    const rx180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    await load(gaussianPly('placed.ply', [[1, 2, 3]]), { kind: 'primary', modelId: 'placed' }, { ...QUALIFIED, gaussianPlacement: rx180 });
    const placed = model('placed')!.gaussianSplat!;
    assert.deepEqual([placed.placementOrigin, placed.placement, placed.calibration], ['explicit', rx180, 'uncalibrated']);
    assert.deepEqual(splats().getBounds(placed.handle), { min: [1, -2, -3], max: [1, -2, -3] });
  });
});

describe('Gaussian capture lifecycle across renderers and reloads (#8566)', () => {
  it('a replaced renderer never receives an old handle; the capture reports it and reloads from source', async () => {
    const { rebindGaussianAssets, gaussianModelState } = await import('./ingest/gaussianAssets.js');
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    await load(gaussianPly('kept.ply', CENTRES), { kind: 'federated', modelId: 'kept', name: 'kept.ply' }, QUALIFIED);
    const old = model('kept')!.gaussianSplat!.handle;
    const previous = gpu;
    previous.renderer.gaussianSplats.clear(); // what destroying the old viewport's renderer releases
    gpu = gaussianTestRenderer();
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    rebindGaussianAssets(gpu.renderer.gaussianSplats);
    assert.deepEqual(gaussianModelState(model('kept')!), { state: 'invalid', reason: 'renderer-replaced' }, 'never shown as loaded');
    assert.equal(splats().getStats().assets, 0, 'the old handle was not handed to the new renderer');
    const result = await act(async () => reloadGaussianCapture('kept', {
      removeModel: (id) => useViewerStore.getState().removeModel(id),
      addModel: async (file, options) => {
        const id = crypto.randomUUID();
        await hookApi!.loadFile(file, { kind: 'federated', modelId: id, name: options.name, visible: options.visible }, { ...QUALIFIED, gaussianPlacement: options.gaussianPlacement });
        return useViewerStore.getState().models.has(id) ? id : null;
      },
    }));
    assert.ok(result.ok);
    const reloaded = model(result.modelId)!.gaussianSplat!;
    assert.notEqual(reloaded.handle, old);
    assert.equal(splats().getState(reloaded.handle).state, 'resident', 'resident on the renderer that issued it');
    assert.equal(model('kept'), undefined);
    useViewerStore.getState().clearAllModels();
    assertNoHeldSlot();
  });

  it('a reload without a retained source refuses explicitly', async () => {
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    await load(gaussianPly('nosource.ply', CENTRES), { kind: 'federated', modelId: 'nosource' }, QUALIFIED);
    useViewerStore.getState().updateModel('nosource', { sourceFile: undefined });
    const result = await reloadGaussianCapture('nosource', { removeModel: () => assert.fail('nothing is removed'), addModel: async () => assert.fail('nothing is loaded') });
    assert.deepEqual(result, { ok: false, reason: 'source-unavailable' });
    assert.ok(model('nosource'), 'the capture stays until a source is available');
  });

  it('a re-evaluated assets module reuses the one registry and store subscription', async () => {
    await load(gaussianPly('one.ply', CENTRES), { kind: 'federated', modelId: 'one' }, QUALIFIED);
    const subscribe = useViewerStore.subscribe;
    let subscriptions = 0;
    useViewerStore.subscribe = ((...args: Parameters<typeof subscribe>) => { subscriptions++; return subscribe(...args); }) as typeof subscribe;
    try {
      const fresh = await import(`./ingest/gaussianAssets.js?reload=${Date.now()}`) as typeof import('./ingest/gaussianAssets.js');
      const handle = model('one')!.gaussianSplat!.handle;
      fresh.adoptGaussianAsset('one', handle, splats());
      assert.equal(subscriptions, 0, 'no second subscription after HMR/remount');
      useViewerStore.getState().removeModel('one');
      assert.equal(splats().getState(handle).state, 'invalid', 'freed exactly once through the shared registry');
    } finally { useViewerStore.subscribe = subscribe; }
  });
});
