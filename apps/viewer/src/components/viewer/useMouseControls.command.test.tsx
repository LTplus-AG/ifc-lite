/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: actual mounted 3D pointer handlers must arbitrate modelling and navigation. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import { mousePointer, mountMouseControls, cleanupMouseControls } from '@/test/mouse-controls-fixture';
import { advance } from '@/test/render';
import { BOX, authoredSpaces, ensureRoomWasm, setWallMeshes, spaceQuantity } from '@/test/room-walls-fixture';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import { clearStoreyRoomsCache } from '@/lib/rooms/storey-rooms';
import { runRoomAction } from './tools/command/RoomPlaceBar';
import { getCommandRuntime, updateCommandGesture } from '@/lib/commands/modeling/runtime';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import type { WallPlaceGesture } from '@/lib/commands/modeling/commands/wall-place-geometry';
import type { RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';
import '@/lib/commands/modeling/builtin';

let restoreRemesh = () => {};
beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ navigationPreset: 'default', interactionMode: 'all' });
  clearStoreyRoomsCache();
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => { cleanupMouseControls(); restoreRemesh(); useViewerStore.getState().exitModelWorkspace(); });

function canvasProbe() {
  return mountMouseControls({ activeToolRef: { current: 'command' } }, (camera, canvas) => {
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    // Stated projection invariant: one canvas pixel is .01 storey metres;
    // the ray meets the real command workplane. Camera navigation stays real.
    camera.unprojectToRay = (x, y) => ({ origin: { x: x / 100, y: 20, z: y / 100 }, direction: { x: 0, y: -1, z: 0 } });
  });
}
const event = (canvas: HTMLCanvasElement, kind: string, x: number, y: number, button = 0) =>
  act(() => { canvas.dispatchEvent(mousePointer(kind, button, x * 100, -y * 100)); });
const click = (canvas: HTMLCanvasElement, x: number, y: number, detail = 1) => {
  event(canvas, 'pointerdown', x, y); event(canvas, 'pointerup', x, y);
  act(() => { canvas.dispatchEvent(new MouseEvent('click', { clientX: x * 100, clientY: -y * 100, detail, bubbles: true })); });
};
const pose = (camera: ReturnType<typeof canvasProbe>['camera']) => ({ position: camera.getPosition(), target: camera.getTarget() });
const wallGesture = () => getCommandRuntime().gesture as WallPlaceGesture;
const roomGesture = () => getCommandRuntime().gesture as RoomPlaceGesture;
const depth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;

describe('mounted 3D modelling gesture ownership (#6232)', () => {
  for (const count of [1, 2]) it(`left press keeps a wall preview live, leaves the camera fixed, and commits once across ${count} models`, async () => {
    const state = useViewerStore.getState(), primary = state.models.get(MODEL_ID)!;
    const peer = { ...fixtureModel('peer', { idOffset: 1_000_000 }), ifcDataStore: primary.ifcDataStore };
    if (count === 2) useViewerStore.setState({ models: new Map([[MODEL_ID, primary], ['peer', peer]]) });
    useViewerStore.getState().startCommand('wall.place');
    const { canvas, camera } = canvasProbe();
    click(canvas, 10, 10);
    assert.equal(wallGesture().chain.length, 1);
    const before = pose(camera), history = depth();
    event(canvas, 'pointerdown', 10, 10);
    event(canvas, 'pointermove', 15, 10);
    await advance(30);
    assert.deepEqual(pose(camera), before, 'modelling drag does not orbit or pan');
    assert.deepEqual(wallGesture().cursor, [15, 10], 'pressed movement reaches the real snap/runtime preview');
    assert.equal(depth(), history, 'preview movement writes no IFC/history');
    event(canvas, 'pointerup', 15, 10);
    act(() => { canvas.dispatchEvent(new MouseEvent('click', { clientX: 1500, clientY: -1000, detail: 1, bubbles: true })); });
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    const wall = view.getNewEntities().find((e) => e.type.toUpperCase() === 'IFCWALL');
    assert.ok(wall);
    assert.deepEqual(useViewerStore.getState().readWallEndpoints(MODEL_ID, wall.expressId)?.end, [15, 10, 0]);
    assert.equal(depth(), history + 1);
    act(() => { useViewerStore.getState().undo(MODEL_ID); });
    assert.equal(depth(), history); assert.ok(view.isDeleted(wall.expressId));
    act(() => { useViewerStore.getState().redo(MODEL_ID); });
    assert.ok(!view.isDeleted(wall.expressId));
    if (count === 2) assert.equal(useViewerStore.getState().models.get('peer'), peer);
  });

  it('keeps middle-button navigation and browser detail=2 polygon closure', () => {
    useViewerStore.getState().setAuthoringDefaults({ slabMode: 'polygon' });
    useViewerStore.getState().startCommand('slab.place');
    const { canvas, camera } = canvasProbe(), before = pose(camera);
    event(canvas, 'pointerdown', 10, 10, 1); event(canvas, 'pointermove', 11, 10, 1); event(canvas, 'pointerup', 11, 10, 1);
    assert.notDeepEqual(pose(camera), before, 'middle still pans');
    click(canvas, 10, 10); click(canvas, 13, 10); click(canvas, 13, 13); click(canvas, 13, 13, 2);
    const slabs = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCSLAB');
    assert.equal(slabs.length, 1, 'the browser second click closes exactly one slab');
  });

  for (const finish of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) it(`room corner press-drag ${finish} uses actual layout/history`, async (t) => {
    if (!ensureRoomWasm(t)) return;
    await ensureSpaceWasm();
    setWallMeshes([...BOX, [[4, 0], [4, 5]]]);
    useViewerStore.getState().startCommand('room.place');
    await act(async () => { await runRoomAction('auto'); });
    const spaces = authoredSpaces(), history = depth();
    const left = spaces.find((space) => space.footprint.every(([x]) => x < 4.1))!;
    assert.ok(left);
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), mode: 'edit', edit: { tool: 'shape', hover: null, drag: null, cut: null, op: null } })); });
    const { canvas, camera } = canvasProbe(), before = pose(camera);
    event(canvas, 'pointerdown', 4, 5);
    assert.ok(roomGesture().edit.drag, 'real press grabs the room corner');
    event(canvas, 'pointermove', 3, 5);
    await advance(30);
    event(canvas, finish, 3, 5);
    assert.deepEqual(pose(camera), before);
    assert.equal(roomGesture().edit.drag, null, 'release/loss ends the press');
    if (finish === 'pointerup') {
      assert.equal(spaceQuantity(left.id, 'GrossFloorArea'), 17.5);
      assert.equal(depth(), history + 1, 'release commits once');
      act(() => { canvas.dispatchEvent(new MouseEvent('click', { clientX: 300, clientY: -500, detail: 1, bubbles: true })); });
      assert.equal(depth(), history + 1, 'the trailing browser click does not edit again');
      assert.equal(roomGesture().edit.drag, null, 'the click does not grab a second corner');
      act(() => { useViewerStore.getState().undo(MODEL_ID); });
      assert.equal(spaceQuantity(left.id, 'GrossFloorArea'), 20);
      act(() => { useViewerStore.getState().redo(MODEL_ID); });
      assert.equal(spaceQuantity(left.id, 'GrossFloorArea'), 17.5);
    } else {
      assert.equal(depth(), history, 'lost press writes no IFC');
      assert.deepEqual(authoredSpaces(), spaces);
    }
  });
});
