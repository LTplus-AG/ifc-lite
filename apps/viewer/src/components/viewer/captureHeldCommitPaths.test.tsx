/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Camera, type Renderer } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { captureViewportFrame, registerViewportCapture, noteLiveFrameSubmitted } from '@/lib/viewport-capture';
import { targetLandmark } from '@/lib/appearance/scan/landmarks';
import type { ScanSession } from '@/lib/appearance/scan/session';
import { useRepositionPicking } from './reposition/useRepositionPicking';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { createCommandPressController } from './commandPress';
import type { MouseHandlerContext } from './mouseHandlerTypes';
import { registerModelingCommand, getModelingCommand } from '@/lib/commands/modeling/registry';
import type { CommandId } from '@/lib/commands/modeling/types';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.getState().exitModelWorkspace(); cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(initial, true); });
function rig() {
  const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
  Object.assign(canvas, { hasPointerCapture: () => false });
  const camera = new Camera();
  camera.unprojectToRay = (x, y) => ({ origin: { x: x / 100, y: 20, z: y / 100 }, direction: { x: 0, y: -1, z: 0 } });
  let picks = 0, renders = 0, clipReads = 0;
  const renderer = {
    getCanvas: () => canvas, getCamera: () => camera,
    getScene: () => ({ getInstancedEntityIds: () => [] }),
    renderWithResult: () => true, getGPUDevice: () => null,
    requestRender: () => { renders++; },
    hasActiveClipping: () => { clipReads++; return true; },
    raycastSceneMagnetic: () => { picks++; return { intersection: { expressId: 7, point: { x: 1, y: 2, z: 3 } }, snapTarget: null,
      edgeLock: { shouldRelease: false, shouldLock: false } }; },
  } as unknown as Renderer;
  const unregister = registerViewportCapture(renderer, canvas, () => ({}));
  return { canvas, renderer, unregister, counts: () => ({ picks, renders, clipReads }),
    capture: () => captureViewportFrame(renderer, { read: () => 'pixels' }), live: () => noteLiveFrameSubmitted(renderer) };
}
function event(kind: string) { return new PointerEvent(kind, { pointerId: 1, button: 0, clientX: 20, clientY: 30, bubbles: true }); }

test('#9232 reposition refuses the capture-phase press before picking or setting an anchor', async () => {
  const h = rig();
  useViewerStore.setState(fixtureModels(fixtureModel('m', { entities: [{ expressId: 7, type: 'IfcWall' }] })));
  useViewerStore.getState().openReposition(['m']);
  setGlobalRendererRef({ current: h.renderer });
  const finished: unknown[] = [], errors: string[] = [];
  const finish = (role: unknown) => { finished.push(role); }, error = (text: string) => { errors.push(text); };
  function Probe() { useRepositionPicking('source', finish, error); return null; }
  render(<Probe />);
  try {
    await h.capture();
    act(() => { h.canvas.dispatchEvent(event('pointermove')); h.canvas.dispatchEvent(event('pointerdown')); h.canvas.dispatchEvent(new MouseEvent('click', { button: 0 })); });
    assert.equal(h.counts().picks, 0, 'neither hover nor press may pick the capture');
    assert.equal(useViewerStore.getState().modelPlacement.preview?.source, null);
    assert.deepEqual(finished, []); assert.deepEqual(errors, []);
    h.live();
    act(() => { h.canvas.dispatchEvent(event('pointerdown')); h.canvas.dispatchEvent(new MouseEvent('click', { button: 0 })); });
    assert.deepEqual(useViewerStore.getState().modelPlacement.preview?.source?.point, [1, -3, 2]);
    assert.deepEqual(finished, ['target']);
  } finally { h.unregister(); }
});

test('#9232 scan landmark refuses before reading the capture-mirrored clipping state', async () => {
  const h = rig();
  const session = { validate() {} } as unknown as ScanSession;
  try {
    await h.capture(); const renders = h.counts().renders;
    assert.equal(targetLandmark(session, h.renderer, 20, 30), null);
    assert.equal(h.counts().clipReads, 0);
    assert.ok(h.counts().renders > renders);
    h.live();
    assert.throws(() => targetLandmark(session, h.renderer, 20, 30), /Turn off section/);
  } finally { h.unregister(); }
});

for (const phase of ['begin', 'end'] as const) test(`#9232 command ${phase} refuses capture-held input and leaves no placement press`, async () => {
  await seedModelingSession();
  const h = rig(), calls: string[] = [];
  const id = 'test.capture-press' as CommandId;
  const unregisterCommand = registerModelingCommand({ ...getModelingCommand('column.place')!, id,
    pointerDownOnPress: () => true,
    pointerDown: g => { calls.push('down'); return g; },
    pointerUp: g => { calls.push('up'); return g; },
    pointerCancel: g => { calls.push('cancel'); return g; },
  });
  useViewerStore.getState().startCommand(id);
  const ctx = { canvas: h.canvas, renderer: h.renderer, mouseState: { didDrag: false, isDragging: false },
    measureRaycastPendingRef: { current: false }, measureRaycastFrameRef: { current: null },
    snapEnabledRef: { current: false }, setSnapTarget() {},
    getPickOptions: () => ({ hiddenIds: new Set(), isolatedIds: null, isStreaming: false }),
  } as unknown as MouseHandlerContext;
  const controller = createCommandPressController(ctx);
  try {
    if (phase === 'end') { controller.begin(event('pointerdown')); assert.deepEqual(calls, ['down']); }
    await h.capture();
    // handleMouseDown marks the press dragging before the controller sees it
    ctx.mouseState.isDragging = true;
    if (phase === 'begin') controller.begin(event('pointerdown')); else controller.end(event('pointerup'));
    // A release with both set reports an orbit to the camera listeners (tours), for a click that moved nothing
    assert.equal(ctx.mouseState.isDragging, false, 'BUG: a refused command press stays dragging, so its release reports an orbit');
    assert.deepEqual(calls, phase === 'begin' ? [] : ['down', 'cancel']);
    assert.equal(controller.hasPress(), false);
    assert.equal(ctx.mouseState.didDrag, true);
    h.live();
    controller.begin(event('pointerdown')); controller.end(event('pointerup'));
    assert.deepEqual(calls.slice(-2), ['down', 'up']);
  } finally { controller.dispose(); h.unregister(); unregisterCommand(); }
});

test('#9232 a capture whose session unregisters mid-capture asks the gone renderer for no frame', async () => {
  const h = rig();
  let rendersAtUnregister = -1;
  // Unregistering aborts the capture, so it returns no pixels; what matters is the frame request
  await captureViewportFrame(h.renderer, {
    read: () => { h.unregister(); rendersAtUnregister = h.counts().renders; return 'pixels'; },
  });
  assert.ok(rendersAtUnregister >= 0, 'the capture reached its read');
  assert.equal(h.counts().renders, rendersAtUnregister, 'BUG: the unmounted viewport was asked for a live frame');
});
