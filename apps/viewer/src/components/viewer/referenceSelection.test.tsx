/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Camera, type PickOptions, type PickResult, type ReferenceImageHit, type Renderer } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { appearanceAssets } from '@/lib/appearance/model-assets.js';
import { emptyPlacementState } from '@/lib/model-placement/state.js';
import { placementFrameKey } from '@/lib/model-placement/persistence.js';
import { handleSelectionClick } from './selectionHandlers.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { useTouchControls, type UseTouchControlsParams } from './useTouchControls.js';
import { invalidateSelectionPick } from './referenceSelection.js';

const ref = <T,>(current: T) => ({ current });
const owner = { kind: 'source' as const, id: 'reference-selection-fixture' };
afterEach(() => {
  cleanup();
  useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [], referenceRevision: 0,
    selectedAppearanceReferenceId: null, modelPlacement: emptyPlacementState(), models: new Map(), activeModelId: null,
    selectedEntityId: null, activeTool: 'select' });
  appearanceAssets.releaseOwner(owner);
  for (const canvas of document.querySelectorAll('canvas')) canvas.remove();
});
async function fixture(modelCount = 1) {
  useViewerStore.setState({ models: new Map(Array.from({ length: modelCount }, (_, index) => [`model-${index}`, fixtureModel(`model-${index}`)])),
    activeTool: 'select' });
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
  const asset = await appearanceAssets.add(png, { owner });
  useViewerStore.getState().addAppearanceReference({ id: 'drawing:one', assetId: asset.id, sourceId: 'original',
    cornersIfcWorld: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]], frameKey: placementFrameKey(useViewerStore.getState()),
    visible: true, locked: false, opacity: 1 });
  const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
  document.body.appendChild(canvas);
  const camera = new Camera(); camera.setAspect(800 / 600);
  const calls = { reference: 0, ifc: 0, selected: [] as Array<PickResult | null>, toggled: [] as number[], options: [] as PickOptions[] };
  let referencePick: () => Promise<ReferenceImageHit | null> = async () => ({ referenceId: 'drawing:one', point: [0, 0, 0], distance: 1 });
  let ifcPick: PickResult | null = { expressId: 19, modelIndex: modelCount > 1 ? 1 : undefined };
  const renderer = {
    getCamera: () => camera, requestRender() {},
    getScene: () => ({ getMeshes: () => [], getBatchedMeshes: () => [], getInstancedEntityCount: () => 0 }),
    raycastScene: () => null,
    getReferenceImages: () => ({ pick: async (_x: number, _y: number, options: PickOptions) => {
      calls.reference++; calls.options.push(options); return referencePick();
    } }),
    pick: async (_x: number, _y: number, options: PickOptions) => { calls.ifc++; calls.options.push(options); return ifcPick; },
  } as unknown as Renderer;
  const tool = ref('select'), options = { isStreaming: false, hiddenIds: new Set([99]), isolatedIds: null as Set<number> | null };
  const handlePickForSelection = (pick: PickResult | null) => { calls.selected.push(pick); useViewerStore.setState({ selectedEntityId: pick?.expressId ?? null }); };
  const ctx = { canvas, renderer, camera, activeToolRef: tool,
    mouseState: { didDrag: false }, getPickOptions: () => options,
    handlePickForSelection, toggleSelection: (id: number) => calls.toggled.push(id),
    lastClickTimeRef: ref(0), lastClickPosRef: ref(null),
  } as unknown as MouseHandlerContext;
  const state = useViewerStore.getState();
  const touch: UseTouchControlsParams = { canvasRef: ref(canvas), rendererRef: ref(renderer), isInitialized: true,
    activeToolRef: tool, hiddenEntitiesRef: ref(options.hiddenIds), isolatedEntitiesRef: ref(options.isolatedIds),
    selectedEntityIdRef: ref(null), selectedModelIndexRef: ref(undefined), clearColorRef: ref([0, 0, 0, 1]),
    sectionPlaneRef: ref(state.sectionPlane), sectionRangeRef: ref(null), geometryRef: ref(null), isInteractingRef: ref(false),
    getPickOptions: () => options, handlePickForSelection,
    touchStateRef: ref({ touches: [], lastDistance: 0, lastCenter: { x: 0, y: 0 }, tapStartTime: 0,
      tapStartPos: { x: 0, y: 0 }, didMove: false, multiTouch: false, twoFingerGesture: 'none', gestureDistanceAccum: 0, gesturePanAccum: 0 }),
  };
  function Probe() { useTouchControls(touch); return null; }
  return { canvas, camera, ctx, calls, tool, options, Probe,
    setReferencePick(value: typeof referencePick) { referencePick = value; }, setIfcPick(value: PickResult | null) { ifcPick = value; } };
}
function clickEvent() { return new window.MouseEvent('click', { clientX: 40, clientY: 30, bubbles: true }); }

for (const count of [1, 2]) test(`desktop Select uses reference strings without IFC callbacks with ${count} model(s) (#4308)`, async () => {
  const f = await fixture(count);
  await handleSelectionClick(f.ctx, clickEvent());
  assert.equal(useViewerStore.getState().selectedAppearanceReferenceId, 'drawing:one');
  assert.equal(f.calls.selected.length, 0); assert.equal(f.calls.ifc, 0);
  assert.equal(f.calls.options[0], f.options, 'existing visibility filters reach reference occlusion');
  f.setReferencePick(async () => null);
  await handleSelectionClick(f.ctx, clickEvent());
  assert.equal(useViewerStore.getState().selectedAppearanceReferenceId, null);
  assert.equal(f.calls.selected.at(-1)?.expressId, 19);
  assert.equal(f.calls.selected.at(-1)?.modelIndex, count > 1 ? 1 : undefined);
  f.ctx.lastClickTimeRef.current = 0;
  useViewerStore.getState().selectAppearanceReference('drawing:one'); f.setIfcPick(null);
  await handleSelectionClick(f.ctx, clickEvent());
  assert.equal(useViewerStore.getState().selectedAppearanceReferenceId, null);
  assert.equal(f.calls.selected.at(-1), null);
});

test('camera, model, reference and newer input invalidate delayed Select results (#4308)', async () => {
  for (const change of ['camera', 'model', 'reference', 'input', 'tool']) {
    const f = await fixture(); let resolve!: (hit: ReferenceImageHit) => void;
    f.setReferencePick(() => new Promise(yes => { resolve = yes; }));
    const job = handleSelectionClick(f.ctx, clickEvent());
    if (change === 'camera') f.camera.orbit(0.1, 0);
    if (change === 'model') useViewerStore.setState({ models: new Map() });
    if (change === 'reference') useViewerStore.getState().updateAppearanceReference('drawing:one', { locked: true });
    if (change === 'input') invalidateSelectionPick(f.canvas);
    if (change === 'tool') f.tool.current = 'pan';
    resolve({ referenceId: 'drawing:one', point: [0, 0, 0], distance: 1 }); await job;
    assert.equal(useViewerStore.getState().selectedAppearanceReferenceId, null, change);
    assert.deepEqual(f.calls.selected, [], change);
    useViewerStore.setState({ appearanceReferences: new Map(), referenceUndo: [], referenceRedo: [] });
  }
});

test('ordinary touch tap selects once and its compatibility click cannot select IFC (#4308)', async () => {
  const f = await fixture(2); render(<f.Probe />);
  const finger = { identifier: 1, target: f.canvas, clientX: 40, clientY: 30 } as unknown as Touch;
  function touchEvent(kind: string, touches: Touch[]) {
    const event = new window.Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: touches }); return event;
  }
  await act(async () => {
    f.canvas.dispatchEvent(touchEvent('touchstart', [finger]));
    f.canvas.dispatchEvent(touchEvent('touchend', []));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(useViewerStore.getState().selectedAppearanceReferenceId, 'drawing:one');
  assert.equal(f.calls.reference, 1);
  f.setReferencePick(async () => null);
  await handleSelectionClick(f.ctx, clickEvent());
  assert.equal(f.calls.reference, 1, 'compatibility click is not processed again');
  assert.deepEqual(f.calls.selected, []);
});


test('locked references and non-Select tools cannot intercept ordinary IFC selection (#4308)', async () => {
  const f = await fixture();
  useViewerStore.getState().updateAppearanceReference('drawing:one', { locked: true });
  await handleSelectionClick(f.ctx, clickEvent());
  assert.equal(f.calls.reference, 0);
  assert.equal(f.calls.selected.at(-1)?.expressId, 19);
  f.tool.current = 'pan';
  await handleSelectionClick(f.ctx, clickEvent());
  assert.equal(f.calls.reference, 0);
  assert.equal(f.calls.ifc, 1);
});


test('RTC-only frame changes retain normal reference picking (#4308)', async () => {
  const f = await fixture();
  const base = { crs: { name: 'EPSG:2056' }, conversion: { eastings: 2600000 }, lengthUnitScale: 1, rotation: 0 };
  const original = JSON.stringify({ ...base, originShift: [10, 0, 0], rtc: [1, 0, 0] });
  useViewerStore.setState(state => ({ modelPlacement: { ...state.modelPlacement, frameKey: original } }));
  useViewerStore.getState().updateAppearanceReference('drawing:one', { frameKey: original });
  useViewerStore.setState(state => ({ modelPlacement: { ...state.modelPlacement,
    frameKey: JSON.stringify({ ...base, originShift: [20, 0, 0], rtc: [2, 0, 0] }) } }));
  await handleSelectionClick(f.ctx, clickEvent());
  assert.equal(useViewerStore.getState().selectedAppearanceReferenceId, 'drawing:one');
  assert.equal(f.calls.reference, 1);
  assert.equal(f.calls.ifc, 0);
});
