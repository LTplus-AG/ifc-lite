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
import type { SlabPlaceGesture } from '@/lib/commands/modeling/commands/slab-place-geometry';
import '@/lib/commands/modeling/builtin';

let restoreRemesh = () => {};
beforeEach(async () => {
  await seedModelingSession({ roomGeometry: true });
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
    const beforeShift = pose(camera);
    for (const [kind, x] of [['pointerdown', 1000], ['pointermove', 1100], ['pointerup', 1100]] as const) {
      act(() => { canvas.dispatchEvent(mousePointer(kind, 0, x, -1000, { shiftKey: true })); });
    }
    assert.notDeepEqual(pose(camera), beforeShift, 'Shift + left still pans while modelling');
    assert.equal((getCommandRuntime().gesture as SlabPlaceGesture).points.length, 0, 'navigation creates no polygon points');
    click(canvas, 10, 10); click(canvas, 13, 10); click(canvas, 13, 13); click(canvas, 13, 13, 2);
    const slabs = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCSLAB');
    assert.equal(slabs.length, 1, 'the browser second click closes exactly one slab');
  });

  for (const finish of ['pointerup', 'pointercancel', 'lostpointercapture', 'captured-leave', 'capture-refused', 'foreign-cancel', 'window-blur', 'buttons-lost', 'unmount'] as const) it(`room corner press-drag ${finish} uses actual layout/history`, async (t) => {
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
    if (finish === 'capture-refused' || finish === 'foreign-cancel') canvas.setPointerCapture = () => { throw new DOMException('No active pointer', 'NotFoundError'); };
    event(canvas, 'pointerdown', 4, 5);
    assert.ok(roomGesture().edit.drag, 'real press grabs the room corner');
    event(canvas, 'pointermove', 3, 5);
    await advance(30);
    if (finish === 'captured-leave') {
      act(() => { canvas.dispatchEvent(new MouseEvent('mouseleave')); });
      assert.ok(roomGesture().edit.drag, 'captured departure retains the owned drag');
      event(canvas, 'pointerup', 3, 5);
    } else if (finish === 'foreign-cancel') {
      for (const pointerType of ['touch', 'pen']) {
        act(() => { canvas.dispatchEvent(mousePointer('pointercancel', 0, 300, -500, { pointerId: 2, pointerType })); });
        assert.ok(roomGesture().edit.drag, 'a foreign cancellation cannot abandon the uncaptured owned mouse press');
        assert.equal(depth(), history, 'foreign cancellation writes no IFC');
      }
      event(canvas, 'pointerup', 3, 5);
    } else if (finish === 'capture-refused') {
      act(() => { canvas.dispatchEvent(new MouseEvent('mouseleave')); });
    } else if (finish === 'window-blur') {
      act(() => { window.dispatchEvent(new Event('blur')); });
    } else if (finish === 'buttons-lost') {
      act(() => { canvas.dispatchEvent(mousePointer('pointermove', 0, 300, -500, { buttons: 0 })); });
    } else if (finish === 'unmount') cleanupMouseControls();
    else event(canvas, finish, 3, 5);
    assert.deepEqual(pose(camera), before);
    assert.equal(roomGesture().edit.drag, null, 'release/loss ends the press');
    if (finish === 'pointerup' || finish === 'captured-leave' || finish === 'foreign-cancel') {
      assert.equal(spaceQuantity(left.id, 'GrossFloorArea'), 17.5);
      const committedDepth = depth();
      const state = useViewerStore.getState();
      const writes = state.undoStacks.get(MODEL_ID)!.slice(history);
      assert.ok(writes.length > 0);
      const tags = new Set(writes.map((write) => state.mutationBatchTags.get(write.id)));
      assert.equal(tags.size, 1, 'all shape/quantity writes form one undo batch');
      assert.ok(!tags.has(undefined));
      act(() => { canvas.dispatchEvent(new MouseEvent('click', { clientX: 300, clientY: -500, detail: 1, bubbles: true })); });
      assert.equal(depth(), committedDepth, 'the trailing browser click does not edit again');
      assert.equal(roomGesture().edit.drag, null, 'the click does not grab a second corner');
      act(() => { useViewerStore.getState().undo(MODEL_ID); });
      assert.equal(depth(), history, 'one Undo removes the complete room edit');
      assert.equal(spaceQuantity(left.id, 'GrossFloorArea'), 20);
      act(() => { useViewerStore.getState().redo(MODEL_ID); });
      assert.equal(depth(), committedDepth);
      assert.equal(spaceQuantity(left.id, 'GrossFloorArea'), 17.5);
    } else {
      assert.equal(depth(), history, 'lost press writes no IFC');
      assert.deepEqual(authoredSpaces(), spaces);
    }
  });

  for (const mode of ['polyline', 'radius'] as const) it(`keeps the mounted ${mode} measurement double-click finish`, () => {
    const state = useViewerStore.getState();
    state.setMeasureMode(mode);
    const points = [[10, 20], [13, 20], [13, 24]].map(([x, y]) => ({ x, y, z: 5, screenX: x * 30, screenY: y * 30 }));
    if (mode === 'polyline') {
      state.startPolyline(points[0]); points.slice(1).forEach(state.addPolylinePoint);
      state.addPolylinePoint(points[2]); // The second browser click duplicates the final point.
    } else {
      state.startRadius(points[0]); points.slice(1).forEach(state.addRadiusPoint);
      state.addRadiusPoint(points[2]);
    }
    const { canvas } = mountMouseControls({ activeToolRef: { current: 'measure' } });
    const before = mode === 'polyline' ? state.polylineMeasurements.length : state.radiusMeasurements.length;
    act(() => { canvas.dispatchEvent(new MouseEvent('dblclick', { detail: 2, bubbles: true, cancelable: true })); });
    const after = useViewerStore.getState();
    const recorded = mode === 'polyline' ? after.polylineMeasurements : after.radiusMeasurements;
    assert.equal(recorded.length, before + 1);
    assert.deepEqual(recorded.at(-1)!.points, points, 'only the duplicate browser point is dropped');
    assert.equal(mode === 'polyline' ? after.activePolyline : after.activeRadius, null);
  });

  it('does not feed a queued wall preview to a newly started slab command', async () => {
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = canvasProbe();
    event(canvas, 'pointermove', 12, 12);
    act(() => { useViewerStore.getState().startCommand('slab.place'); });
    await advance(30);
    assert.equal((getCommandRuntime().gesture as SlabPlaceGesture).cursor, null, 'new command has received no pointer input');
  });

  it('drops a room press when the command changes, without clicking into its successor', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await ensureSpaceWasm(); setWallMeshes([...BOX, [[4, 0], [4, 5]]]);
    useViewerStore.getState().startCommand('room.place');
    await act(async () => { await runRoomAction('auto'); });
    const spaces = authoredSpaces(), history = depth();
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), mode: 'edit', edit: { tool: 'shape', hover: null, drag: null, cut: null, op: null } })); });
    const { canvas } = canvasProbe(); event(canvas, 'pointerdown', 4, 5);
    assert.ok(roomGesture().edit.drag);
    event(canvas, 'pointermove', 3, 5);
    act(() => { useViewerStore.getState().startCommand('wall.place'); });
    event(canvas, 'pointerup', 3, 5);
    act(() => { canvas.dispatchEvent(new MouseEvent('click', { clientX: 300, clientY: -500, detail: 1, bubbles: true })); });
    await advance(30);
    assert.deepEqual(wallGesture().chain, [], 'the old press/release is not a new placement');
    assert.equal(depth(), history); assert.deepEqual(authoredSpaces(), spaces);
  });
});
