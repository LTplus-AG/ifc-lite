/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { GaussianSplatError, type Renderer } from '@ifc-lite/renderer';
import { totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { useViewerStore } from '@/store';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { gaussianPly, gaussianTestRenderer, installInThreadGaussianWorker } from '@/test/gaussian-loader-harness.js';
import { buildFederationSetupFile } from '@/lib/federation/federationSetupFile.js';
import { useIfcLoader } from '../useIfcLoader.js';
import { useFederationSetup } from '../useFederationSetup.js';
import { setGlobalRendererRef } from '../useBCF.js';
import { gaussianModelShell } from './gaussianIngest.js';
import { convergeFederationRtcFrame } from './federationRtcRebase.js';
import { gaussianModelState, rebindGaussianAssets, reframeGaussianCapture, setGaussianCaptureUpAxis } from './gaussianAssets.js';

const FRAME = { originShift: { x: 10, y: 20, z: 30 }, wasmRtcOffset: { x: 2_600_000, y: 1_200_000, z: 500 } };
const WORLD: [number, number, number] = [2_600_012, 1_200_003, 524];
const BOUNDS = { min: [2, 4, -33], max: [2, 4, -33] };
let loader: ReturnType<typeof useIfcLoader>;
let setup: ReturnType<typeof useFederationSetup>;
let gpu: ReturnType<typeof gaussianTestRenderer>;
let worker: ReturnType<typeof installInThreadGaussianWorker>;
function Probe() { loader = useIfcLoader(); setup = useFederationSetup(); return null; }
const capture = () => useViewerStore.getState().models.get('capture')!.gaussianSplat!;
const bounds = () => gpu.renderer.gaussianSplats.getBounds(capture().handle);
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function settled(expected: object) {
  for (let i = 0; i < 100 && JSON.stringify(bounds()) !== JSON.stringify(expected); i++) await tick();
  assert.deepEqual(bounds(), expected);
}
async function loadCapture() {
  await loader.loadFile(gaussianPly('survey.ply', [WORLD]), { kind: 'federated', modelId: 'capture' });
  assert.ok(capture());
}
/** Known IFC decode frame: tests below exercise live convergence and real
 * Gaussian placement/packing/bounds, without substituting the placement API. */
function addIfc() {
  const model = fixtureModel('ifc', { entities: [] });
  model.loadedAt = 1;
  model.loadState = 'complete';
  model.geometryResult = gaussianModelShell(0).geometryResult;
  model.geometryResult.coordinateInfo = { ...model.geometryResult.coordinateInfo, ...FRAME };
  useViewerStore.getState().addModel(model);
  convergeFederationRtcFrame();
}

beforeEach(async () => {
  useViewerStore.getState().clearAllModels();
  useViewerStore.getState().resetViewerState();
  gpu = gaussianTestRenderer();
  worker = installInThreadGaussianWorker();
  setGlobalRendererRef({ current: gpu.renderer as Renderer });
  render(<Probe />);
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().clearAllModels();
  worker.restore();
  setGlobalRendererRef({ current: null });
});

it('capture-then-IFC matches IFC-then-capture with origin shift AND RTC; removal restores world coordinates (#8752)', async () => {
  await act(async () => {
    await loadCapture();
    addIfc();
    await settled(BOUNDS);
    const early = bounds();
    const record = capture();
    const uploads = gpu.backend.sources.length;
    convergeFederationRtcFrame();
    await reframeGaussianCapture('capture');
    assert.equal(capture(), record, 'unchanged frame does not republish');
    assert.equal(gpu.backend.sources.length, uploads, 'unchanged frame does not re-upload');
    useViewerStore.getState().removeModel('ifc');
    await settled({ min: [WORLD[0], WORLD[2], -WORLD[1]], max: [WORLD[0], WORLD[2], -WORLD[1]] });
    useViewerStore.getState().clearAllModels();
    addIfc();
    await loadCapture();
    await settled(BOUNDS);
    assert.deepEqual(bounds(), early, 'load orders give identical renderer centre bounds');
  });
});

it('an in-flight frame edit is serialized with the next frame and axis edit (#8752)', async () => {
  await act(async () => {
    const centre: [number, number, number] = [WORLD[0], 3, 4];
    await loader.loadFile(gaussianPly('axis.ply', [centre]), { kind: 'federated', modelId: 'capture' });
    const original = capture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const splats = gpu.renderer.gaussianSplats;
    const place = splats.setPlacement.bind(splats);
    splats.setPlacement = async (...args) => { await gate; return place(...args); };
    try {
      addIfc();
      // Let the first placement reach the held backend before removing its anchor.
      await tick();
      assert.equal(capture(), original, 'store keeps the accepted frame during upload');
      useViewerStore.getState().removeModel('ifc');
      const axis = setGaussianCaptureUpAxis('capture', 'y');
      release();
      assert.equal(await axis, true);
      await settled({ min: centre, max: centre });
      assert.deepEqual(capture().frameOffset, { x: 0, y: 0, z: 0 });
    } finally { release(); }
  });
});

for (const withIfc of [false, true]) {
  it(`survey-scale capture changes z→y→z with${withIfc ? '' : 'out'} an IFC frame (#8858)`, async () => {
    await act(async () => {
      if (withIfc) addIfc();
      await loadCapture();
      const offset = withIfc ? totalYupOffset(FRAME) : { x: 0, y: 0, z: 0 };
      const z = [WORLD[0] - offset.x, WORLD[2] - offset.y, -WORLD[1] - offset.z];
      const y = [WORLD[0] - offset.x, WORLD[1] - offset.y, WORLD[2] - offset.z];
      assert.deepEqual(bounds(), { min: z, max: z });
      const first = capture().handle;
      assert.equal(await setGaussianCaptureUpAxis('capture', 'y'), true);
      assert.equal(capture().upAxis, 'y');
      assert.notEqual(capture().handle, first, 'the old anchor was replaced');
      assert.deepEqual(bounds(), { min: y, max: y });
      const second = capture().handle;
      assert.equal(await setGaussianCaptureUpAxis('capture', 'z'), true);
      assert.equal(capture().upAxis, 'z');
      assert.notEqual(capture().handle, second);
      assert.deepEqual(bounds(), { min: z, max: z });
      assert.equal(gpu.renderer.gaussianSplats.getStats().assets, 1);
    });
  });
}

it('a failed survey-scale re-add restores the old axis, placement and resident rows (#8858)', async () => {
  await act(async () => {
    await loadCapture();
    const before = capture();
    const oldBounds = bounds();
    const splats = gpu.renderer.gaussianSplats;
    const add = splats.add.bind(splats);
    let failNext = true;
    splats.add = async (...args) => {
      if (failNext) { failNext = false; throw new GaussianSplatError('resource-limit', 'forced re-add failure'); }
      return add(...args);
    };
    try {
      await assert.rejects(setGaussianCaptureUpAxis('capture', 'y'), /forced re-add failure/);
      assert.equal(capture().upAxis, 'z');
      assert.deepEqual(capture().placement, before.placement);
      assert.notEqual(capture().handle, before.handle, 'rollback publishes the restored handle');
      assert.deepEqual(bounds(), oldBounds);
      assert.equal(splats.getState(capture().handle).state, 'resident');
    } finally { splats.add = add; }
  });
});

it('a failed rollback leaves a visible reload-required capture state (#8858)', async () => {
  await act(async () => {
    await loadCapture();
    const splats = gpu.renderer.gaussianSplats;
    const add = splats.add.bind(splats);
    splats.add = async () => { throw new GaussianSplatError('resource-limit', 'forced add failure'); };
    try {
      await assert.rejects(setGaussianCaptureUpAxis('capture', 'y'), /forced add failure/);
      assert.equal(capture().upAxis, 'z');
      assert.equal(gaussianModelState(useViewerStore.getState().models.get('capture')!).state, 'invalid');
    } finally { splats.add = add; }
  });
});

it('a survey-scale axis re-anchor stays serialized with an incoming IFC frame (#8858)', async () => {
  await act(async () => {
    await loadCapture();
    const splats = gpu.renderer.gaussianSplats;
    const place = splats.setPlacement.bind(splats);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    splats.setPlacement = async (...args) => { entered = true; await gate; return place(...args); };
    try {
      const axis = setGaussianCaptureUpAxis('capture', 'y');
      for (let i = 0; i < 100 && !entered; i++) await tick();
      assert.ok(entered);
      assert.equal(capture().upAxis, 'z', 'the store changes only after upload');
      addIfc();
      release();
      assert.equal(await axis, true);
      await reframeGaussianCapture('capture');
      const offset = totalYupOffset(FRAME);
      const expected = [WORLD[0] - offset.x, WORLD[1] - offset.y, WORLD[2] - offset.z];
      await settled({ min: expected, max: expected });
      assert.equal(capture().upAxis, 'y');
    } finally { release(); splats.setPlacement = place; }
  });
});

it('a replaced renderer never receives the old handle or an accepted frame record (#8752)', async () => {
  await act(async () => {
    await loadCapture();
    const record = capture();
    const next = gaussianTestRenderer();
    setGlobalRendererRef({ current: next.renderer as Renderer });
    rebindGaussianAssets(next.renderer.gaussianSplats);
    addIfc();
    assert.equal(await reframeGaussianCapture('capture'), false);
    assert.equal(capture(), record);
    assert.equal(next.renderer.gaussianSplats.getStats().assets, 0);
  });
});

it('real setup restore loads a capture slot before its survey reference and re-frames it (#8752)', async () => {
  // Plan coordinates are parsed by the real LandXML loader. This
  // complements the explicit IFC RTC invariant above with the actual setup loop.
  const survey = new File([`<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
    <Units><Metric linearUnit="meter" elevationUnit="meter"/></Units>
    <CgPoints><CgPoint name="control">1200000 2600000 500</CgPoint></CgPoints>
    <PlanFeatures><PlanFeature name="survey"><CoordGeom><Line><Start>1200000 2600000 500</Start><End>1200010 2600010 500</End></Line></CoordGeom></PlanFeature></PlanFeatures>
    </LandXML>`], 'reference.xml');
  await act(async () => {
    await loadCapture();
    Reflect.deleteProperty(globalThis, 'Worker');
    await loader.loadFile(survey, { kind: 'federated', modelId: 'survey' });
    const models = [...useViewerStore.getState().models.values()];
    assert.equal(models.length, 2, String(useViewerStore.getState().error));
    const saved = await buildFederationSetupFile(models, null);
    assert.equal(saved.slots[0].name, 'survey.ply');
    const files = [gaussianPly('survey.ply', [WORLD]), survey];
    useViewerStore.getState().clearAllModels();
    worker.restore();
    worker = installInThreadGaussianWorker();
    const matches = await setup.matchFederationSetup(saved, files);
    // Once Gaussian decode has published, let the real LandXML Node parser
    // run instead of the Gaussian-only worker transport used by this harness.
    const unsubscribe = useViewerStore.subscribe(state => {
      if ([...state.models.values()].some(m => m.gaussianSplat)) Reflect.deleteProperty(globalThis, 'Worker');
    });
    let restored: Awaited<ReturnType<typeof setup.applyFederationSetup>>;
    try { restored = await setup.applyFederationSetup(saved, matches); }
    finally { unsubscribe(); }
    assert.equal(restored.outcome, 'restored', JSON.stringify(restored));
    const loaded = [...useViewerStore.getState().models.values()];
    assert.ok(loaded[0].gaussianSplat, 'capture actually loaded first');
    const offset = totalYupOffset(loaded[1].geometryResult!.coordinateInfo);
    assert.notEqual(offset.x, 0, 'reference establishes a nonzero render frame');
    const expected = [WORLD[0] - offset.x, WORLD[2] - offset.y, -WORLD[1] - offset.z];
    const handle = loaded[0].gaussianSplat.handle;
    for (let i = 0; i < 100 && JSON.stringify(gpu.renderer.gaussianSplats.getBounds(handle)?.min) !== JSON.stringify(expected); i++) await tick();
    assert.deepEqual(gpu.renderer.gaussianSplats.getBounds(handle), { min: expected, max: expected });
  });
});

it('every capture follows a survey-scale frame once, including a later-added capture (#8752)', async () => {
  await act(async () => {
    await loadCapture();
    await loader.loadFile(gaussianPly('other.ply', [[WORLD[0] + 5, WORLD[1], WORLD[2]]]), { kind: 'federated', modelId: 'other' });
    addIfc();
    await settled(BOUNDS);
    const other = useViewerStore.getState().models.get('other')!.gaussianSplat!;
    for (let i = 0; i < 100 && useViewerStore.getState().models.get('other')!.gaussianSplat!.frameOffset?.x !== capture().frameOffset?.x; i++) await tick();
    assert.deepEqual(gpu.renderer.gaussianSplats.getBounds(other.handle), { min: [7, 4, -33], max: [7, 4, -33] });
    await loader.loadFile(gaussianPly('late.ply', [[WORLD[0] + 10, WORLD[1], WORLD[2]]]), { kind: 'federated', modelId: 'late' });
    const late = useViewerStore.getState().models.get('late')!.gaussianSplat!;
    assert.deepEqual(gpu.renderer.gaussianSplats.getBounds(late.handle), { min: [12, 4, -33], max: [12, 4, -33] });
    assert.deepEqual(bounds(), BOUNDS, 'adding a capture does not shift existing captures again');
  });
});

it('a primary IFC frame held in geometryResult aligns a capture before and after reconcile (#8778)', async () => {
  await act(async () => {
    const primary = fixtureModel('primary', { entities: [] });
    primary.loadState = 'complete';
    primary.geometryResult = null;
    useViewerStore.getState().addModel(primary);
    const geometry = gaussianModelShell(0).geometryResult;
    geometry.coordinateInfo = { ...geometry.coordinateInfo, ...FRAME };
    useViewerStore.setState({ geometryResult: geometry });
    await loadCapture();
    await settled(BOUNDS);
    await reframeGaussianCapture('capture');
    assert.deepEqual(bounds(), BOUNDS, 'reconcile keeps the primary geometry fallback');
  });
});

it('an upload waits behind a pending adapter translation and lands in the IFC-first frame (#8778)', async () => {
  await act(async () => {
    await loadCapture();
    const splats = gpu.renderer.gaussianSplats;
    const translate = splats.translateFrame.bind(splats);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    splats.translateFrame = async delta => { entered = true; await gate; return translate(delta); };
    try {
      addIfc();
      for (let i = 0; i < 100 && !entered; i++) await tick();
      assert.ok(entered, 'the old capture has a pending frame translation');
      const decodedBefore = worker.stats.terminated;
      const pending = loader.loadFile(gaussianPly('concurrent.ply', [WORLD]), { kind: 'federated', modelId: 'concurrent' });
      for (let i = 0; i < 100 && worker.stats.terminated === decodedBefore; i++) await tick();
      assert.ok(worker.stats.terminated > decodedBefore, 'the new capture decoded while translation was held');
      assert.equal(splats.getStats().assets, 1, 'the new upload waits for the adapter frame');
      release();
      await pending;
      await settled(BOUNDS);
      const next = useViewerStore.getState().models.get('concurrent')!.gaussianSplat!;
      assert.deepEqual(splats.getBounds(next.handle), BOUNDS, 'new upload and IFC-first ordering agree');
    } finally { release(); splats.translateFrame = translate; }
  });
});
