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
import { gaussianPly, gaussianTestRenderer, installInThreadGaussianWorker, setGaussianBuild } from '@/test/gaussian-loader-harness';
import { useIfcLoader, type LoadTarget } from './useIfcLoader.js';
import { render, cleanup } from '@/test/render.js';
import { GaussianCaptureMetadataPanel } from '@/components/viewer/properties/GaussianCaptureMetadataPanel';
import { buildFederationSetupFile, parseFederationSetupFile, serializeFederationSetupFile } from '@/lib/federation/federationSetupFile';
import { ViewportLoadErrorCard } from '@/components/viewer/ViewportLoadErrorCard';
import { useIfcFederation } from './useIfcFederation.js';
import { setGlobalRendererRef } from './useBCF.js';

const CENTRES: Array<[number, number, number]> = [[1, 2, 3], [4, 5, 6], [-2, 0, 1]];

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
let federation: ReturnType<typeof useIfcFederation>;
let restoreBuild: () => void = () => {};
let otherFederation: ReturnType<typeof useIfcFederation>;
let afterFederationLoad: ((target?: LoadTarget) => Promise<void>) | null = null;
function Probe() {
  const loader = useIfcLoader();
  hookApi = loader;
  federation = useIfcFederation(async (file, target, options) => {
    await loader.loadFile(file, target, options);
    await afterFederationLoad?.(target);
  });
  const otherLoader = useIfcLoader();
  otherFederation = useIfcFederation((file, target, options) =>
    otherLoader.loadFile(file, target, options));
  return <ViewportLoadErrorCard />;
}

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
  restoreBuild = setGaussianBuild(undefined);
  afterFederationLoad = null;
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
  cleanup();
  restoreBuild();
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
  it('the kill-switch build refuses before any worker, renderer asset or model slot exists (#8568)', async () => {
    setGaussianBuild('disabled');
    await load(gaussianPly('capture.ply', CENTRES), { kind: 'primary', modelId: 'public' });
    assert.match(String(useViewerStore.getState().error), /Gaussian capture loading is turned off in this viewer build/);
    assert.equal(model('public')?.loadState, 'error');
    assert.equal(worker.stats.created, 0, 'no decoder worker for a refused capture');
    assert.equal(splats().getStats().assets, 0);
    await load(gaussianPly('added.ply', CENTRES), { kind: 'federated', modelId: 'public-add' });
    assert.equal(model('public-add'), undefined, 'a refused federated add registers nothing');
    assertNoHeldSlot();
  });

  it('the default build admits: a standalone capture publishes the exact renderer handle and frees it with its model', async () => {
    await load(gaussianPly('capture.ply', CENTRES), { kind: 'primary', modelId: 'capture' });
    const capture = model('capture');
    assert.equal(capture?.loadState, 'complete', String(capture?.loadError));
    const record = capture.gaussianSplat;
    assert.ok(record && Object.isFrozen(record.handle), 'the renderer-issued frozen handle itself');
    assert.equal(splats().getState(record.handle).state, 'resident');
    assert.equal(record.handle.modelIndex, modelIndices(useViewerStore.getState().models).get('capture'));
    assert.deepEqual({ count: record.count, shDegree: record.shDegree, format: record.format, origin: record.placementOrigin, calibration: record.calibration },
      { count: 3, shDegree: 0, format: 'gaussian-ply', origin: 'source', calibration: 'uncalibrated' });
    assert.deepEqual(record.sourceCenterBounds, { min: [-2, 0, 1], max: [4, 5, 6] });
    const bounds = splats().getBounds(record.handle)!;
    assert.deepEqual(bounds.min, [-2, 1, -5]);
    assert.ok(bounds.max.every((value, axis) => Math.abs(value - [4, 6, 0][axis]) < 1e-12), 'Z-up scan bounds, allowing quaternion roundoff');
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
    await load(gaussianPly('a.ply', CENTRES), { kind: 'federated', modelId: 'a', name: 'a.ply' });
    await load(gaussianPly('b.ply', [[10, 0, 0]]), { kind: 'federated', modelId: 'b', name: 'b.ply' });
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
    await load(gaussianPly('first.ply', CENTRES), { kind: 'primary', modelId: 'first' });
    assert.equal(splats().getState(b.handle).state, 'invalid', 'a primary load frees the replaced scene');
    await load(gaussianPly('second.ply', [[0, 0, 0]]), { kind: 'federated', modelId: 'second' });
    assert.equal(splats().getStats().assets, 2);
    useViewerStore.getState().clearAllModels();
    assert.equal(splats().getStats().assets, 0);
    assertNoHeldSlot();
  });

  for (const removeFirst of ['capture', 'ifc'] as const) it(`splat-first IFC join preserves both models when removing ${removeFirst} first (#8565)`, async () => {
    const placement = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 12, 20, 30, 1];
    await load(gaussianPly('primary.ply', CENTRES), { kind: 'primary', modelId: 'capture' },
      { gaussianPlacement: placement });
    const capture = model('capture')!;
    const record = capture.gaussianSplat!;
    const index = modelIndices(useViewerStore.getState().models).get('capture');
    const bounds = splats().getBounds(record.handle);
    assert.equal(splats().getStats().assets, 1);

    // Same registration/finalization boundary as the existing IFC-first harness;
    // Gaussian admission/decoding/upload above runs through the mounted loader.
    const ifc = addIfcModel('ifc', [{ expressId: 7, type: 'IfcWall' }]);
    const indices = modelIndices(useViewerStore.getState().models);
    assert.equal(useViewerStore.getState().models.size, 2);
    assert.equal(model('capture')!.gaussianSplat, record);
    assert.equal(model('capture')!.gaussianSplat!.handle, record.handle);
    assert.equal(indices.get('capture'), index);
    assert.equal(record.handle.modelIndex, index);
    assert.notEqual(indices.get('ifc'), index);
    assert.deepEqual(record.placement, placement);
    assert.deepEqual(splats().getBounds(record.handle), bounds);
    assert.equal(splats().getState(record.handle).state, 'resident');
    assert.equal(model('ifc'), ifc);
    assert.equal(ifc.ifcDataStore!.entities.getTypeName(7), 'IfcWall');
    assert.deepEqual(ifc.geometryResult!.meshes.map(mesh => mesh.expressId), [7]);
    assert.equal(ifc.visible, true);
    assert.equal(splats().getStats().assets, 1, 'IFC registration creates no Gaussian asset');

    useViewerStore.getState().removeModel(removeFirst);
    const survivor = removeFirst === 'capture' ? 'ifc' : 'capture';
    assert.equal(useViewerStore.getState().models.size, 1);
    if (survivor === 'ifc') assert.equal(model(survivor), ifc);
    else assert.equal(model(survivor)!.gaussianSplat, record);
    assert.equal(splats().getStats().assets, survivor === 'capture' ? 1 : 0);
    assert.equal(splats().getState(record.handle).state, survivor === 'capture' ? 'resident' : 'invalid');
    if (survivor === 'capture') {
      assert.equal(modelIndices(useViewerStore.getState().models).get('capture'), index);
      assert.deepEqual(splats().getBounds(record.handle), bounds);
      assert.deepEqual(model('capture')!.gaussianSplat!.placement, placement);
    } else {
      assert.equal(model('ifc')!.ifcDataStore!.entities.getTypeName(7), 'IfcWall');
      assert.deepEqual(model('ifc')!.geometryResult!.meshes.map(mesh => mesh.expressId), [7]);
    }
    useViewerStore.getState().removeModel(survivor);
    assert.equal(splats().getStats().assets, 0);
    assertNoHeldSlot();
  });

  it('cancelling during decode terminates the worker and publishes nothing', async () => {
    const release = worker.hold();
    await act(async () => {
      const pending = hookApi!.loadFile(gaussianPly('slow.ply', CENTRES), { kind: 'federated', modelId: 'slow' });
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
      const stale = hookApi!.loadFile(gaussianPly('stale.ply', CENTRES), { kind: 'primary', modelId: 'stale' });
      await new Promise(resolve => setTimeout(resolve, 50));
      const next = hookApi!.loadFile(gaussianPly('next.ply', [[9, 9, 9]]), { kind: 'primary', modelId: 'next' });
      release();
      await Promise.all([stale, next]);
    });
    assert.equal(model('stale'), undefined);
    assert.equal(model('next')?.loadState, 'complete');
    assert.equal(splats().getStats().assets, 1, 'the superseded upload left no asset behind');
    assert.deepEqual(splats().getBounds(), { min: [9, 9, -9], max: [9, 9, -9] });
  });

  it('a lost device refuses before decoding; a rejected upload retains nothing', async () => {
    gpu.loseDevice();
    await load(gaussianPly('lost.ply', CENTRES), { kind: 'primary', modelId: 'lost' });
    assert.match(String(useViewerStore.getState().error), /graphics device was lost/);
    assert.equal(worker.stats.created, 0);

    gpu = gaussianTestRenderer({ maxStorageBufferBindingSize: 16, maxBufferSize: 16 });
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    await load(gaussianPly('big.ply', CENTRES), { kind: 'federated', modelId: 'big' });
    assert.match(String(useViewerStore.getState().error), /could not be loaded: .*byte binding/);
    assert.equal(model('big'), undefined);
    assert.equal(splats().getStats().assets, 0);
    assertNoHeldSlot();
  });

  it('a malformed capture keeps its admission reason, and an explicit placement is recorded as explicit', async () => {
    await load(new File([new Uint8Array(31)], 'broken.splat'), { kind: 'primary', modelId: 'broken' });
    assert.match(String(useViewerStore.getState().error), /Truncated or empty \.splat/);
    assert.equal(worker.stats.created, 0);
    const rx180 = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    await load(gaussianPly('placed.ply', [[1, 2, 3]]), { kind: 'primary', modelId: 'placed' }, { gaussianPlacement: rx180 });
    const placed = model('placed')!.gaussianSplat!;
    assert.deepEqual([placed.placementOrigin, placed.placement, placed.calibration], ['explicit', rx180, 'uncalibrated']);
    assert.deepEqual(splats().getBounds(placed.handle), { min: [1, -2, -3], max: [1, -2, -3] });
  });
});

describe('Gaussian capture lifecycle across renderers and reloads (#8566)', () => {
  it('before rebinding, a capture on a replaced renderer reports replaced and has no fit bounds', async () => {
    const { rebindGaussianAssets, gaussianModelState, gaussianModelBounds } = await import('./ingest/gaussianAssets.js');
    await load(gaussianPly('stale.ply', CENTRES), { kind: 'federated', modelId: 'stale', name: 'stale.ply' });
    assert.ok(gaussianModelBounds(model('stale')!), 'resident capture frames');
    const previous = gpu; // the old adapter still holds the asset: only the ownership check can refuse it
    gpu = gaussianTestRenderer();
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    assert.deepEqual(gaussianModelState(model('stale')!), { state: 'invalid', reason: 'renderer-replaced' });
    assert.equal(gaussianModelBounds(model('stale')!), null, 'no bounds from a replaced renderer');
    previous.renderer.gaussianSplats.clear();
    rebindGaussianAssets(gpu.renderer.gaussianSplats);
  });

  it('a replaced renderer never receives an old handle; the capture reports it and reloads from source', async () => {
    const { rebindGaussianAssets, gaussianModelState } = await import('./ingest/gaussianAssets.js');
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    await load(gaussianPly('kept.ply', CENTRES), { kind: 'federated', modelId: 'kept', name: 'kept.ply' });
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
        const id = options.modelId!;
        await hookApi!.loadFile(file, { kind: 'federated', modelId: id, name: options.name, visible: options.visible }, { gaussianPlacement: options.gaussianPlacement, onGaussianLoadSettled: options.onGaussianLoadSettled });
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

  it('a reloaded capture keeps the federation anchor it held (#8566)', async () => {
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    await load(gaussianPly('anchor.ply', CENTRES), { kind: 'federated', modelId: 'anchor', name: 'anchor.ply' });
    useViewerStore.getState().setAnchorModelIdOverride('anchor');
    const result = await act(async () => reloadGaussianCapture('anchor', {
      removeModel: (id) => useViewerStore.getState().removeModel(id),
      addModel: async (file, options) => {
        const id = options.modelId!;
        await hookApi!.loadFile(file, { kind: 'federated', modelId: id, name: options.name, visible: options.visible }, { gaussianPlacement: options.gaussianPlacement, onGaussianLoadSettled: options.onGaussianLoadSettled });
        return useViewerStore.getState().models.has(id) ? id : null;
      },
    }));
    assert.ok(result.ok);
    assert.equal(useViewerStore.getState().anchorModelIdOverride, result.modelId, 'the replacement is the anchor, not the removed id');
    useViewerStore.getState().setAnchorModelIdOverride(null);
    useViewerStore.getState().clearAllModels();
    assertNoHeldSlot();
  });

  it('failed admission and upload preserve the retry row; successful retry carries metadata (#8566)', async () => {
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    const placement = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    const source = gaussianPly('retry.ply', CENTRES);
    await load(source, { kind: 'federated', modelId: 'retry', name: 'Survey', visible: false, collapsed: false },
      { gaussianPlacement: placement, gaussianAttribution: 'Survey team' });
    const original = model('retry')!;
    const tag = useViewerStore.getState().createModelTag('Survey phase')!;
    useViewerStore.getState().assignModelTags(['retry'], [tag]);

    setGaussianBuild('disabled');
    const refused = await act(async () => reloadGaussianCapture('retry', federation));
    assert.deepEqual(refused, { ok: false, reason: 'not-loaded' });
    assert.equal(model('retry'), original, 'refused admission keeps source, placement and display metadata');
    assert.deepEqual([...useViewerStore.getState().modelTagAssignments.get('retry')!], [tag]);
    assert.equal(splats().getState(original.gaussianSplat!.handle).state, 'resident');

    setGaussianBuild(undefined);
    const previous = gpu;
    previous.loseDevice();
    gpu = gaussianTestRenderer({ maxStorageBufferBindingSize: 16, maxBufferSize: 16 });
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    const failed = await act(async () => reloadGaussianCapture('retry', federation));
    assert.deepEqual(failed, { ok: false, reason: 'not-loaded' });
    assert.equal(model('retry'), original, 'upload failure leaves the lost-device capture recoverable');
    assert.equal(splats().getStats().assets, 0);

    gpu = gaussianTestRenderer();
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    const success = await act(async () => reloadGaussianCapture('retry', federation));
    assert.ok(success.ok);
    const replacement = model(success.modelId)!;
    assert.equal(model('retry'), undefined);
    assert.equal(replacement.sourceFile, source);
    assert.deepEqual([replacement.name, replacement.visible, replacement.collapsed], ['Survey', false, false]);
    assert.deepEqual(replacement.gaussianSplat!.placement, placement);
    assert.equal(replacement.gaussianSplat!.attribution, 'Survey team');
    assert.equal(splats().getState(replacement.gaussianSplat!.handle).state, 'resident');
    assert.deepEqual([...useViewerStore.getState().modelTagAssignments.get(success.modelId)!], [tag]);
    assert.equal(useViewerStore.getState().modelTagAssignments.has('retry'), false);
    await load(source, { kind: 'federated', modelId: 'unrelated' });
    assert.equal(useViewerStore.getState().modelTagAssignments.has('unrelated'), false, 'same filename alone never inherits tags');
  });

  for (const independent of [false, true]) it(`concurrent reloads share one transaction across ${independent ? 'independent hooks' : 'one federation hook'} (#8566)`, async () => {
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    await load(gaussianPly('concurrent.ply', CENTRES), { kind: 'federated', modelId: 'old' });
    const tag = useViewerStore.getState().createModelTag('Concurrent capture')!;
    useViewerStore.getState().assignModelTags(['old'], [tag]);
    const created = worker.stats.created;
    const release = worker.hold();
    await act(async () => {
      const first = reloadGaussianCapture('old', federation);
      let second: ReturnType<typeof reloadGaussianCapture>;
      try {
        for (let i = 0; i < 100 && worker.stats.created === created; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(worker.stats.created, created + 1, 'first reload is decoding before the second click');
        second = reloadGaussianCapture('old', independent ? otherFederation : federation);
        assert.equal(first, second, 'all callers await the same owned replacement');
      } finally { release(); }
      const [a, b] = await Promise.all([first, second!]);
      assert.ok(a.ok && b.ok);
      assert.equal(a.modelId, b.modelId);
      assert.deepEqual([...useViewerStore.getState().modelTagAssignments.get(a.modelId)!], [tag]);
    });
    assert.equal(worker.stats.created - created, 1, 'only one decode/admission was started');
    assert.equal(useViewerStore.getState().models.size, 1);
    assert.equal(splats().getStats().assets, 1);
    assert.equal(model('old'), undefined);
  });

  it('cleans a published replacement when an unrelated add supersedes its federation session (#8566)', async () => {
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    await load(gaussianPly('old.ply', CENTRES), { kind: 'federated', modelId: 'old' });
    const original = model('old')!;
    const tag = useViewerStore.getState().createModelTag('Superseded reload')!;
    useViewerStore.getState().assignModelTags(['old'], [tag]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let replacementId: string | undefined;
    // Hold between real loadFile publication and the real federation session
    // check: another add then makes the first add return null despite publishing.
    afterFederationLoad = async target => {
      if (target?.modelId === 'unrelated') return;
      replacementId = target?.modelId;
      await held;
    };
    await act(async () => {
      const pending = reloadGaussianCapture('old', federation);
      try {
        for (let i = 0; i < 100 && !replacementId; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(replacementId && model(replacementId)?.gaussianSplat);
        assert.equal(await federation.addModel(gaussianPly('other.ply', CENTRES), { modelId: 'unrelated' }), 'unrelated');
      } finally { release(); }
      assert.deepEqual(await pending, { ok: false, reason: 'not-loaded' });
    });
    const retained = model('old');
    assert.ok(retained, 'original retry row survives');
    assert.equal(retained.sourceFile, original.sourceFile, 'retry retains the exact source');
    assert.equal(retained.gaussianSplat?.handle, original.gaussianSplat!.handle, 'original renderer handle survives');
    assert.deepEqual(
      [retained.name, retained.visible, retained.sourceHandle, retained.sourceFingerprint, retained.gaussianSplat],
      [original.name, original.visible, original.sourceHandle, original.sourceFingerprint, original.gaussianSplat],
      'source and capture metadata survive the losing replacement',
    );
    assert.deepEqual([...useViewerStore.getState().modelTagAssignments.get('old')!], [tag]);
    // Canonical addModel collapses existing rows when another model is added.
    assert.equal(retained.collapsed, true);
    assert.equal(model(replacementId!), undefined, 'published losing row is removed');
    assert.equal(useViewerStore.getState().models.size, 2);
    assert.equal(splats().getStats().assets, 2, 'only original and unrelated assets remain');
  });

  for (const cancel of [true, false]) it(`a reload ${cancel ? 'cancelled' : 'completed'} during post-publication fingerprinting preserves the transaction contract (#8566)`, async () => {
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    const source = gaussianPly('fingerprint.ply', CENTRES);
    await load(source, { kind: 'federated', modelId: 'old', name: 'Original survey', visible: false },
      { gaussianAttribution: 'Original credit' });
    const original = model('old')!;
    const tag = useViewerStore.getState().createModelTag('Fingerprint race')!;
    useViewerStore.getState().assignModelTags(['old'], [tag]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    let hold = true;
    let replacementId: string | undefined;
    const slice = source.slice.bind(source);
    // Hold a real Blob read only AFTER the canonical loader published its
    // replacement. Admission and the worker decoder still run unmodified.
    source.slice = (start, end, contentType) => {
      const blob = slice(start, end, contentType);
      const replacement = [...useViewerStore.getState().models.values()].find(m =>
        m.id !== 'old' && m.sourceFile === source && m.gaussianSplat);
      if (hold && replacement && start === 0 && end === source.size) {
        replacementId = replacement.id;
        const read = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = async () => { held = true; await gate; return read(); };
      }
      return blob;
    };
    try {
      await act(async () => {
        const pending = reloadGaussianCapture('old', federation);
        try {
          for (let i = 0; i < 100 && !held; i++) await new Promise(resolve => setTimeout(resolve, 10));
          assert.ok(held && replacementId, 'fingerprint read reached after publication');
          assert.ok(model(replacementId)?.gaussianSplat);
          assert.equal(splats().getStats().assets, 2, 'both original and uncommitted replacement exist');
          const cancelLoad = useViewerStore.getState().activeLoadCanceller;
          assert.ok(cancelLoad, 'Cancel remains active while the fingerprint is pending');
          if (cancel) cancelLoad();
        } finally { hold = false; release(); }
        const result = await pending;
        if (cancel) assert.deepEqual(result, { ok: false, reason: 'not-loaded' });
        else assert.deepEqual(result, { ok: true, modelId: replacementId });
      });
    } finally { hold = false; release(); source.slice = slice; }
    const survivor = model(cancel ? 'old' : replacementId!);
    assert.ok(survivor);
    assert.equal(model(cancel ? replacementId! : 'old'), undefined);
    assert.equal(survivor.sourceFile, source);
    assert.deepEqual([survivor.name, survivor.visible, survivor.gaussianSplat?.attribution],
      ['Original survey', false, 'Original credit']);
    assert.deepEqual([...useViewerStore.getState().modelTagAssignments.get(survivor.id)!], [tag]);
    if (cancel) assert.equal(survivor.gaussianSplat?.handle, original.gaussianSplat!.handle);
    else assert.notEqual(survivor.gaussianSplat?.handle, original.gaussianSplat!.handle);
    assert.equal(useViewerStore.getState().models.size, 1);
    assert.equal(splats().getStats().assets, 1, 'the transaction releases only its losing asset');
  });

  it('the mounted error-card Retry completes the whole failed reload transaction (#8566)', async () => {
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    const source = gaussianPly('retry-click.ply', CENTRES);
    await load(source, { kind: 'federated', modelId: 'old', name: 'Tagged survey', visible: false },
      { gaussianAttribution: 'Survey credit' });
    const tag = useViewerStore.getState().createModelTag('Retry click')!;
    useViewerStore.getState().assignModelTags(['old'], [tag]);
    gpu.loseDevice();
    gpu = gaussianTestRenderer({ maxStorageBufferBindingSize: 16, maxBufferSize: 16 });
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    assert.deepEqual(await act(async () => reloadGaussianCapture('old', federation)), { ok: false, reason: 'not-loaded' });
    assert.ok(model('old'));
    const retry = [...container!.querySelectorAll('button')].find(button => button.textContent === 'Retry');
    assert.ok(retry, 'the actual canonical error card offers Retry');
    gpu = gaussianTestRenderer();
    setGlobalRendererRef({ current: gpu.renderer as Renderer });
    await act(async () => {
      retry.click();
      for (let i = 0; i < 100 && model('old'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    });
    assert.equal(model('old'), undefined, 'Retry removed the old row after replacement committed');
    const models = [...useViewerStore.getState().models.values()];
    assert.equal(models.length, 1, 'Retry did not leave old and new rows together');
    const next = models[0];
    assert.equal(next.sourceFile, source);
    assert.deepEqual([next.name, next.visible, next.gaussianSplat?.attribution], ['Tagged survey', false, 'Survey credit']);
    assert.deepEqual([...useViewerStore.getState().modelTagAssignments.get(next.id)!], [tag]);
    assert.equal(splats().getStats().assets, 1);
    assert.equal(container!.querySelector('[data-viewport-load-error-card]'), null);
  });

  it('a reload without a retained source refuses explicitly', async () => {
    const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
    await load(gaussianPly('nosource.ply', CENTRES), { kind: 'federated', modelId: 'nosource' });
    useViewerStore.getState().updateModel('nosource', { sourceFile: undefined });
    const result = await reloadGaussianCapture('nosource', { removeModel: () => assert.fail('nothing is removed'), addModel: async () => assert.fail('nothing is loaded') });
    assert.deepEqual(result, { ok: false, reason: 'source-unavailable' });
    assert.ok(model('nosource'), 'the capture stays until a source is available');
  });

  it('a re-evaluated assets module reuses the one registry and store subscription', async () => {
    await load(gaussianPly('one.ply', CENTRES), { kind: 'federated', modelId: 'one' });
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

it('a renderer clear during an outstanding upload aborts it and the loader retains nothing (#8640 round 3)', async () => {
  const release = gpu.backend.hold();
  await act(async () => {
    const pending = hookApi!.loadFile(gaussianPly('cleared.ply', CENTRES), { kind: 'federated', modelId: 'cleared' });
    for (let i = 0; i < 100 && gpu.backend.sources.length === 0 && worker.stats.terminated === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    splats().clear();
    release();
    await pending;
  });
  assert.equal(model('cleared'), undefined, 'nothing is published');
  assert.match(String(useViewerStore.getState().error), /could not be loaded/);
  assert.equal(splats().getStats().assets, 0, 'no unpublished or cleared rows survive');
  assertNoHeldSlot();
});


it('mounted up-axis control updates actual renderer bounds; setup and reload preserve axes without double shifting (#8752)', async () => {
  const { reloadGaussianCapture } = await import('./ingest/gaussianReload.js');
  const ifc = addIfcModel('survey-ifc', [{ expressId: 7, type: 'IfcWall' }]);
  const geometry = ifc.geometryResult!;
  useViewerStore.getState().updateModel('survey-ifc', { loadedAt: 1, geometryResult: { ...geometry, coordinateInfo: {
    ...geometry.coordinateInfo, originShift: { x: 10, y: 20, z: 30 },
    wasmRtcOffset: { x: 2_600, y: 1_200, z: 500 },
  } } });
  const file = gaussianPly('survey.ply', [[2_612, 1_203, 524]]);
  await load(file, { kind: 'federated', modelId: 'survey' });
  const initial = model('survey')!.gaussianSplat!;
  assert.deepEqual(splats().getBounds(initial.handle), { min: [2, 4, -33], max: [2, 4, -33] },
    'canonical ingest rotates then subtracts the combined nonzero IFC origin/RTC offset');
  function Panel() {
    const selected = useViewerStore(state => state.models.get('survey'))!;
    return <GaussianCaptureMetadataPanel model={selected} capture={selected.gaussianSplat!} />;
  }
  const ui = render(<Panel />);
  let select = ui.querySelector<HTMLSelectElement>('select')!;
  assert.equal(select.value, 'z');
  assert.equal(select.disabled, false);
  assert.equal(ui.querySelector('label')!.textContent, 'Source up-axis');
  const change = async (axis: string) => {
    select = ui.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      select.value = axis;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      for (let i = 0; i < 100 && model('survey')!.gaussianSplat!.upAxis !== axis; i++) await new Promise(resolve => setTimeout(resolve, 10));
    });
  };
  await change('y');
  assert.equal(model('survey')!.gaussianSplat!.upAxis, 'y');
  assert.deepEqual(splats().getBounds(initial.handle), { min: [2, 683, 1_694], max: [2, 683, 1_694] });
  // Y-up is a persisted override, not a second copy of the final shifted matrix.
  const savedY = await buildFederationSetupFile([model('survey')!], null);
  const parsedY = parseFederationSetupFile(serializeFederationSetupFile(savedY));
  assert.ok(parsedY.ok);
  assert.equal(parsedY.setup.slots[0].gaussianUpAxis, 'y');
  assert.equal(parsedY.setup.slots[0].gaussianPlacement, undefined);
  await change('z');
  assert.deepEqual(splats().getBounds(initial.handle), { min: [2, 4, -33], max: [2, 4, -33] });
  const setup = await buildFederationSetupFile([model('survey')!], null);
  const parsed = parseFederationSetupFile(serializeFederationSetupFile(setup));
  assert.ok(parsed.ok);
  cleanup();
  useViewerStore.getState().removeModel('survey');
  let id: string | null = null;
  await act(async () => { id = await federation.addModel(file, { ...parsedY.setup.slots[0], modelId: 'restored' }); });
  assert.equal(id, 'restored');
  const restored = model('restored')!.gaussianSplat!;
  assert.equal(restored.upAxis, 'y', 'portable setup axis reaches the canonical loader through addModel');
  assert.deepEqual(splats().getBounds(restored.handle), { min: [2, 683, 1_694], max: [2, 683, 1_694] });
  const result = await act(async () => reloadGaussianCapture('restored', federation));
  assert.ok(result.ok);
  assert.equal(model(result.modelId)!.gaussianSplat!.upAxis, 'y');
  assert.deepEqual(splats().getBounds(model(result.modelId)!.gaussianSplat!.handle), { min: [2, 683, 1_694], max: [2, 683, 1_694] }, 'reload does not rotate or shift twice');
});

it('canonical Gaussian ingest reconciles a Swiss survey-scale IFC origin plus RTC offset (#8752)', async () => {
  const ifc = addIfcModel('georeferenced', [{ expressId: 7, type: 'IfcWall' }]);
  const geometry = ifc.geometryResult!;
  useViewerStore.getState().updateModel('georeferenced', { loadedAt: 1, geometryResult: { ...geometry, coordinateInfo: {
    ...geometry.coordinateInfo, originShift: { x: 10, y: 20, z: 30 },
    wasmRtcOffset: { x: 2_600_000, y: 1_200_000, z: 500 },
  } } });
  await load(gaussianPly('survey-world.ply', [[2_600_012, 1_200_003, 524]]), { kind: 'federated', modelId: 'survey-world' });
  assert.ok(model('survey-world'), String(useViewerStore.getState().error));
  const record = model('survey-world')!.gaussianSplat!;
  assert.deepEqual(splats().getBounds(record.handle), { min: [2, 4, -33], max: [2, 4, -33] });
  assert.equal(record.calibration, 'uncalibrated', 'render-origin reconciliation makes no registration or scale claim');
});
