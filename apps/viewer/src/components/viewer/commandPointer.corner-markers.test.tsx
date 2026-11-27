/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/lib/renderer-ref';
import '@/lib/commands/modeling/builtin';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { routeCommandPointer } from './commandPointer';
import type { MouseHandlerContext } from './mouseHandlerTypes';
import { SnapCornerMarkers } from './tools/SnapCornerMarkers';
import { useAimKey } from './tools/command/useAimKey';

function Overlay() {
  useAimKey(getCommandRuntime().command);
  return <SnapCornerMarkers />;
}

async function scene(t: TestContext, elevation: number) {
  const view = await seedModelingSession();
  const restoreRemesh = setRequestRemesh(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = 800; canvas.height = 600;
  t.mock.method(canvas, 'getBoundingClientRect', () => ({ width: 800, height: 600 }));
  const renderer = new Renderer(canvas);
  const camera = renderer.getCamera();
  camera.setAspect(800 / 600); camera.setProjectionMode('orthographic'); camera.setOrthoSize(6);
  camera.setPosition(4, 10, 8); camera.setTarget(4, 0, -3);
  const corner = { x: 4, y: elevation, z: -3 };
  const mesh = { expressId: 42, positions: Float32Array.of(4,elevation,-3, 7,elevation,-3, 4,elevation,-6),
    indices: Uint32Array.of(0,1,2), normals: Float32Array.of(0,1,0, 0,1,0, 0,1,0), color: [1,1,1,1] };
  // Supply the CPU mesh inventory without uploading GPU buffers. Raycast, grid,
  // command solver, IFC placement and SVG overlay all run their production paths.
  const handles = [{ expressId: mesh.expressId }];
  t.mock.method(renderer.getScene(), 'getMeshes', () => handles);
  t.mock.method(renderer.getScene(), 'getMeshDataPieces', () => [mesh]);
  const hiddenIds = new Set<number>();
  const ctx = {
    renderer, getPickOptions: () => ({ hiddenIds, isolatedIds: null, isStreaming: false }),
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, lockStrength: 0 } },
    snapEnabledRef: { current: true }, measureRaycastPendingRef: { current: false },
    measureRaycastFrameRef: { current: null }, setSnapTarget() {}, setEdgeLock() {}, clearEdgeLock() {},
  } as unknown as MouseHandlerContext;
  setGlobalRendererRef({ current: renderer });
  useViewerStore.setState({ snapEnabled: true });
  useViewerStore.getState().startCommand('column.place');
  const ui = render(<Overlay />);
  t.after(() => { cleanup(); setGlobalRendererRef(null); restoreRemesh(); useViewerStore.getState().exitModelWorkspace(); });
  const cursor = camera.projectToScreen({ x: 4.01, y: elevation, z: -3.01 }, 800, 600)!;
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  async function move() {
    await act(async () => { routeCommandPointer(ctx, 'move', cursor.x, cursor.y); await frame(); });
  }
  for (let i = 0; i < 60 && !ui.querySelector('[data-snap-corner-marker]'); i++) { await move(); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(ui.querySelector('[data-snap-corner-marker]'), 'the settled corner grid supplied the mounted overlay');
  return { ui, camera, corner, renderer, view, hiddenIds, move,
    click: () => act(() => { routeCommandPointer(ctx, 'down', cursor.x, cursor.y); }),
    key: (type: 'keydown' | 'keyup') => act(async () => {
      window.dispatchEvent(new window.KeyboardEvent(type, { key: 'Alt', altKey: type === 'keydown' })); await frame();
    }),
  };
}

it('#11517 an elevated vertex may guide placement without highlighting its off-plane projection', async t => {
  const { ui, camera, corner, renderer, view, click } = await scene(t, 1);
  const floor = { ...corner, y: 0 };
  const screen = (p: typeof floor) => camera.projectToScreen(p, 800, 600)!;
  assert.ok(Math.abs(screen(corner).y - screen(floor).y) > 20, 'oblique view separates the two glyph positions');
  assert.ok(renderer.cornerMarkers.get()?.candidates.some(c => c.position.y === 1));
  assert.deepEqual(getCommandRuntime().snap?.render, [4, 0, -3]);
  const activeBeforePlacement = !!ui.querySelector('[data-snap-corner-marker="active"]');
  click();
  const column = view.getNewEntities().find(e => e.type.toUpperCase() === 'IFCCOLUMN');
  assert.ok(column);
  assert.deepEqual(useViewerStore.getState().readEntityPosition(MODEL_ID, column.expressId), [4, 3, 0]);
  assert.equal(activeBeforePlacement, false);
});

it('#11517 Alt clears the corner glyphs at a still pointer and release restores the on-plane vertex', async t => {
  const { ui, camera, corner, renderer, key } = await scene(t, 0);
  const active = () => ui.querySelector('[data-snap-corner-marker="active"]')?.getAttribute('transform');
  const at = camera.projectToScreen(corner, 800, 600)!;
  const transform = `translate(${at.x} ${at.y})`;
  assert.equal(active(), transform);
  const stamp = renderer.readbackRaycastViewKey();
  await key('keydown');
  assert.equal(getCommandRuntime().snap?.winner?.kind, 'workplane');
  assert.ok(!ui.querySelector('[data-snap-corner-marker]'));
  await key('keyup');
  assert.equal(active(), transform);
  assert.deepEqual(getCommandRuntime().snap?.render, [4, 0, -3]);
  assert.equal(renderer.readbackRaycastViewKey(), stamp);
});

it('#11746 replaces the hidden command pick when a host swaps IDs in place', async t => {
  const { ui, hiddenIds, move } = await scene(t, 0);
  hiddenIds.add(101);
  for (let i = 0; i < 60; i++) {
    await move();
    if (ui.querySelector('[data-snap-corner-marker="active"]')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(ui.querySelector('[data-snap-corner-marker="active"]'));
  hiddenIds.delete(101);
  hiddenIds.add(42);
  await move();
  assert.ok(!ui.querySelector('[data-snap-corner-marker]'));
});

it('#11746 reopening a Reposition pick at a fixed camera starts without old glyphs', async t => {
  const { ui, renderer, camera, corner } = await scene(t, 0);
  const setPicking = (on: boolean) => act(() => {
    useViewerStore.setState({ activeTool: 'select', repositionPicking: on });
  });
  setPicking(true);
  const at = camera.projectToScreen(corner, 800, 600)!;
  const isolatedIds = new Set([42]);
  for (let i = 0; i < 60 && !ui.querySelector('[data-snap-corner-marker="active"]'); i++) {
    act(() => {
      renderer.raycastSceneMagnetic(at.x, at.y, { edge: null, meshExpressId: null, lockStrength: 0 },
        { isolatedIds, snapOptions: { snapToVertices: true, screenCornerSnap: { markers: true } } });
    });
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(ui.querySelector('[data-snap-corner-marker="active"]'));
  const stamp = renderer.readbackRaycastViewKey();
  setPicking(false);
  setPicking(true);
  assert.equal(renderer.readbackRaycastViewKey(), stamp);
  assert.ok(!ui.querySelector('[data-snap-corner-marker]'));
  assert.equal(renderer.cornerMarkers.get(), null);
  setPicking(false);
});

for (const next of ['wall.place', 'column.place'] as const) {
  it(`#11746 replacing column.place with ${next} clears the stationary glyph until hover`, async t => {
    const { ui, renderer, move } = await scene(t, 0);
    const active = () => ui.querySelector('[data-snap-corner-marker="active"]')?.getAttribute('transform');
    const glyph = active();
    assert.ok(glyph);
    const previous = getCommandRuntime().ctx;
    const camera = renderer.readbackRaycastViewKey();
    act(() => { useViewerStore.getState().startCommand(next); });
    assert.equal(useViewerStore.getState().activeTool, 'command');
    assert.equal(getCommandRuntime().command?.id, next);
    assert.notEqual(getCommandRuntime().ctx, previous);
    assert.equal(renderer.readbackRaycastViewKey(), camera);
    assert.ok(!ui.querySelector('[data-snap-corner-marker]'));
    assert.equal(renderer.cornerMarkers.get(), null);
    await move();
    assert.equal(active(), glyph);
    await move();
    assert.equal(active(), glyph);
  });
}
