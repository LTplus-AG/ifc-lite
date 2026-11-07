/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9042: a finger, and since #9000 an Apple Pencil, gets what a mouse gets in
 * the tools that act on a tap or a drag: Section face-pick, the `command`
 * tool's tap, an Annotate pin (#9123), and Pan / Walk drags. Touch reaches the
 * mouse side's helpers rather than copies of them.
 *
 * Mounts the real `useMouseControls` and `useTouchControls` on one canvas.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Camera } from '@ifc-lite/renderer';
import { cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import {
  mountViewportControls, touchEvent, tap, pointer, pointerDrag, click, pencilTap, pencilDrag, fingerDrag,
} from '@/test/touch-controls-fixture.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import { BOX, authoredSpaces, ensureRoomWasm, setWallMeshes, spaceQuantity } from '@/test/room-walls-fixture';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import { clearStoreyRoomsCache } from '@/lib/rooms/storey-rooms';
import { runRoomAction } from './tools/command/RoomPlaceBar';
import { getCommandRuntime, updateCommandGesture } from '@/lib/commands/modeling/runtime';
import { getModelingCommand, registerModelingCommand } from '@/lib/commands/modeling/registry';
import type { CommandId } from '@/lib/commands/modeling/types';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import type { WallPlaceGesture } from '@/lib/commands/modeling/commands/wall-place-geometry';
import type { RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';
import '@/lib/commands/modeling/builtin';

afterEach(() => {
  cleanup();
  for (const canvas of document.querySelectorAll('canvas')) canvas.remove();
});

const pose = (camera: Camera) => JSON.stringify({ position: camera.getPosition(), target: camera.getTarget() });
const viewDirection = (camera: Camera) => {
  const p = camera.getPosition(), t = camera.getTarget();
  const d = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
  return [(t.x - p.x) / d, (t.y - p.y) / d, (t.z - p.z) / d].map((v) => v.toFixed(9)).join(',');
};

/** A wall face at z = -2 whose stored normal points away from the camera at z = 10. */
const FACE_HIT = {
  intersection: { point: { x: 1, y: 2, z: -2 }, normal: { x: 0, y: 0, z: -1 }, expressId: 7, meshIndex: 0, triangleIndex: 0 },
};

function sectionRig(hit: unknown = FACE_HIT) {
  const planes: string[] = [];
  const armed: boolean[] = [];
  const sectionPickModeRef = { current: true };
  const rig = mountViewportControls('section', 42, {
    renderer: { raycastScene: () => hit },
    mouse: {
      sectionPickModeRef,
      setSectionPlaneFromFace: (normal, point) => { planes.push(JSON.stringify({ normal, point })); },
      setSectionPickMode: (enabled) => { armed.push(enabled); sectionPickModeRef.current = enabled; },
    },
  });
  return { ...rig, planes, armed, sectionPickModeRef };
}

// The camera-facing normal: the cut keeps the side the user looks at (#243).
const EXPECTED_PLANE = JSON.stringify({ normal: [-0, -0, 1], point: [1, 2, -2] });

describe('Section face-pick by tap (#9042)', () => {
  it('a finger tap with face-pick armed places the cut through the face, once, and selects nothing', async () => {
    const { canvas, planes, selectionCount } = sectionRig();
    await tap(canvas, 300, 200);
    // An engine whose compatibility click is no PointerEvent: the tap owns it (#4555).
    await act(async () => { canvas.dispatchEvent(click(300, 200, null)); });
    assert.deepEqual(planes, [EXPECTED_PLANE], 'BUG: the tap did not reach the Section face-pick, or reached it twice');
    assert.equal(selectionCount(), 0, 'a face-pick tap must not change the selection');
  });

  it('a Pencil tap places the cut once', async () => {
    const { canvas, planes, selectionCount } = sectionRig();
    await pencilTap(canvas, 300, 200);
    assert.deepEqual(planes, [EXPECTED_PLANE]);
    assert.equal(selectionCount(), 0);
  });

  it('a careful 400 ms tap places the cut, as a click has no time limit (#9092)', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const { canvas, planes } = sectionRig();
    act(() => { canvas.dispatchEvent(touchEvent('touchstart', canvas, [[300, 200]])); });
    now += 400;
    await act(async () => { canvas.dispatchEvent(touchEvent('touchend', canvas, [])); });
    assert.deepEqual(planes, [EXPECTED_PLANE], 'BUG: a 400 ms tap placed no cut');
  });

  it('a tap with nothing under the finger disarms the pick, as a click on the background does', async () => {
    const { canvas, planes, armed, selectionCount } = sectionRig(null);
    await tap(canvas, 300, 200);
    assert.deepEqual(planes, []);
    assert.deepEqual(armed, [false], 'a missed tap must not leave the user stuck in pick mode');
    assert.equal(selectionCount(), 0);
  });

  it('with face-pick not armed, a Section tap still selects (control)', async () => {
    const { canvas, planes, sectionPickModeRef, selectionCount } = sectionRig();
    sectionPickModeRef.current = false;
    await tap(canvas, 300, 200);
    assert.deepEqual(planes, []);
    assert.equal(selectionCount(), 1);
  });

  it('a drag with face-pick armed orbits and places nothing', () => {
    const { canvas, camera, planes } = sectionRig();
    const before = pose(camera);
    fingerDrag(canvas);
    assert.notEqual(pose(camera), before);
    assert.deepEqual(planes, []);
  });
});

describe('an Annotate pin by tap (#9123)', () => {
  afterEach(() => { useViewerStore.getState().cancelDraft(); });
  const annotateRig = (hit: unknown = FACE_HIT) => mountViewportControls('annotate', 42, { renderer: { raycastScene: () => hit } });
  const draft = () => useViewerStore.getState().draft;

  it('a finger tap drops a pin at the tapped surface point, selects nothing, and its compatibility click drops no second', async () => {
    const { canvas, selectionCount } = annotateRig();
    await tap(canvas, 300, 200);
    assert.deepEqual(draft()?.position, { x: 1, y: 2, z: -2 }, 'BUG: a tap in Annotate dropped no pin');
    const first = draft()?.draftId;
    await act(async () => { canvas.dispatchEvent(click(300, 200, null)); });
    assert.equal(draft()?.draftId, first, 'the compatibility click dropped a second pin');
    assert.equal(selectionCount(), 0, 'a pin tap must not select');
  });

  it('a Pencil tap drops one pin', async () => {
    const { canvas, selectionCount } = annotateRig();
    await pencilTap(canvas, 300, 200);
    assert.deepEqual(draft()?.position, { x: 1, y: 2, z: -2 });
    assert.equal(selectionCount(), 0);
  });

  it('a careful 400 ms tap drops the pin (#9092)', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const { canvas } = annotateRig();
    act(() => { canvas.dispatchEvent(touchEvent('touchstart', canvas, [[300, 200]])); });
    now += 400;
    await act(async () => { canvas.dispatchEvent(touchEvent('touchend', canvas, [])); });
    assert.deepEqual(draft()?.position, { x: 1, y: 2, z: -2 }, 'BUG: a 400 ms tap dropped no pin');
  });

  it('a tap on empty background drops nothing and selects nothing, as a click there', async () => {
    const { canvas, selectionCount } = annotateRig(null);
    await tap(canvas, 300, 200);
    assert.equal(draft(), null);
    assert.equal(selectionCount(), 0);
  });

  it('a mouse click still drops the pin (control)', async () => {
    const { canvas, selectionCount } = annotateRig();
    await act(async () => { canvas.dispatchEvent(click(300, 200, 'mouse')); });
    assert.deepEqual(draft()?.position, { x: 1, y: 2, z: -2 });
    assert.equal(selectionCount(), 0);
  });

  it('a drag in Annotate orbits and drops nothing', () => {
    const { canvas, camera } = annotateRig();
    const before = pose(camera);
    fingerDrag(canvas);
    assert.notEqual(pose(camera), before);
    assert.equal(draft(), null);
  });
});

describe('the command tool by tap (#9042)', () => {
  let restoreRemesh = () => {};
  beforeEach(async () => {
    await seedModelingSession({ roomGeometry: true });
    useViewerStore.setState({ navigationPreset: 'default', interactionMode: 'all' });
    clearStoreyRoomsCache();
    restoreRemesh = setRequestRemesh(() => {});
  });
  afterEach(() => { restoreRemesh(); useViewerStore.getState().exitModelWorkspace(); });

  // As useMouseControls.command.test.tsx: one canvas pixel is .01 storey metres on the real workplane.
  const commandRig = () => mountViewportControls('command', 42, {
    setup: (camera) => {
      camera.unprojectToRay = (x, y) => ({ origin: { x: x / 100, y: 20, z: y / 100 }, direction: { x: 0, y: -1, z: 0 } });
    },
  });
  const at = (x: number, y: number) => [x * 100, -y * 100] as const;
  const wallGesture = () => getCommandRuntime().gesture as WallPlaceGesture;
  const newWalls = () => useViewerStore.getState().mutationViews.get(MODEL_ID)?.getNewEntities()
    .filter((e) => e.type.toUpperCase() === 'IFCWALL') ?? [];

  it('two finger taps place a wall from the first to the second, and select nothing', async () => {
    useViewerStore.getState().startCommand('wall.place');
    const { canvas, selectionCount } = commandRig();
    await tap(canvas, ...at(10, 10));
    assert.equal(wallGesture().chain.length, 1, 'BUG: a tap in the command tool never reached the command');
    await act(async () => { canvas.dispatchEvent(click(...at(10, 10), null)); });
    assert.equal(wallGesture().chain.length, 1, 'the compatibility click placed the point a second time');
    await tap(canvas, ...at(15, 10));
    const walls = newWalls();
    assert.equal(walls.length, 1);
    assert.deepEqual(useViewerStore.getState().readWallEndpoints(MODEL_ID, walls[0].expressId)?.end, [15, 10, 0]);
    assert.equal(selectionCount(), 0, 'a command tap must not select');
  });

  it('a column tap places one column, and its compatibility click does not stack a second', async () => {
    useViewerStore.getState().startCommand('column.place');
    const { canvas } = commandRig();
    const columns = () => useViewerStore.getState().mutationViews.get(MODEL_ID)?.getNewEntities()
      .filter((e) => e.type.toUpperCase() === 'IFCCOLUMN').length ?? 0;
    await tap(canvas, ...at(10, 10));
    assert.equal(columns(), 1, 'BUG: the tap placed no column');
    await act(async () => { canvas.dispatchEvent(click(...at(10, 10), null)); });
    assert.equal(columns(), 1, 'the compatibility click placed a second column');
  });

  it('a command that follows the press gets the press and then the release from one tap, as a mouse press and release', async (t) => {
    // A stub, so this needs no room WASM: room.place edit mode is the real such command.
    const calls: string[] = [];
    const id = 'test.press-driven' as CommandId;
    t.after(registerModelingCommand({
      ...getModelingCommand('column.place')!,
      id,
      pointerDownOnPress: () => true,
      pointerDown: (g) => { calls.push('down'); return g; },
      pointerUp: (g) => { calls.push('up'); return g; },
    }));
    useViewerStore.getState().startCommand(id);
    const { canvas } = commandRig();
    await tap(canvas, ...at(10, 10));
    assert.deepEqual(calls, ['down', 'up']);
  });

  it('a Pencil tap places one point', async () => {
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    await pencilTap(canvas, ...at(10, 10));
    assert.equal(wallGesture().chain.length, 1);
  });

  it('a one-finger drag still orbits and places nothing; a two-finger pinch places nothing', () => {
    useViewerStore.getState().startCommand('wall.place');
    const { canvas, camera } = commandRig();
    const before = pose(camera);
    fingerDrag(canvas);
    assert.notEqual(pose(camera), before, 'touch has no other one-finger orbit');
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300], [440, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, [[400, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.equal(wallGesture().chain.length, 0);
  });

  it('a tap with no command running selects nothing and throws nothing', async () => {
    const { canvas, selectionCount } = commandRig();
    await tap(canvas, ...at(10, 10));
    assert.equal(selectionCount(), 0);
  });

  it('a tap grabs a room corner in edit mode and a second tap drops it there, as two clicks do', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await ensureSpaceWasm();
    setWallMeshes([...BOX, [[4, 0], [4, 5]]]);
    useViewerStore.getState().startCommand('room.place');
    await act(async () => { await runRoomAction('auto'); });
    const left = authoredSpaces().find((space) => space.footprint.every(([x]) => x < 4.1));
    assert.ok(left);
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), mode: 'edit', edit: { tool: 'shape', hover: null, drag: null, cut: null, op: null } })); });
    const { canvas } = commandRig();
    await tap(canvas, ...at(4, 5));
    assert.deepEqual((getCommandRuntime().gesture as RoomPlaceGesture).edit.drag?.from, [4, 5], 'the tap did not grab the corner');
    await tap(canvas, ...at(3, 5));
    assert.equal((getCommandRuntime().gesture as RoomPlaceGesture).edit.drag, null, 'the second tap left the corner grabbed');
    assert.equal(spaceQuantity(left.id, 'GrossFloorArea'), 17.5, 'the corner did not move to the second tap');
  });
});

describe('Pan and Walk drags (#9042)', () => {
  /** The pose a mouse drag of the same path leaves in `tool`. */
  function mouseDragPose(tool: string): string {
    const mouse = mountViewportControls(tool);
    pointerDrag(mouse.canvas, 'mouse');
    const expected = pose(mouse.camera);
    cleanup(); mouse.canvas.remove();
    return expected;
  }

  for (const tool of ['pan', 'walk'] as const) {
    it(`a finger drag in ${tool} moves the camera exactly as a mouse drag does`, () => {
      const expected = mouseDragPose(tool);
      const { canvas, camera } = mountViewportControls(tool);
      const before = pose(camera);
      fingerDrag(canvas);
      assert.notEqual(pose(camera), before);
      assert.equal(pose(camera), expected, `BUG: a finger drag in ${tool} did not do what a mouse drag does`);
    });

    it(`a Pencil drag in ${tool} does the same, once`, () => {
      const expected = mouseDragPose(tool);
      const { canvas, camera } = mountViewportControls(tool);
      pencilDrag(canvas);
      assert.equal(pose(camera), expected);
    });
  }

  it('a Pan drag keeps the view direction and a Walk drag keeps the eye', () => {
    const pan = mountViewportControls('pan');
    const direction = viewDirection(pan.camera);
    fingerDrag(pan.canvas);
    assert.equal(viewDirection(pan.camera), direction, 'Pan turned the view (orbited)');
    cleanup(); pan.canvas.remove();
    const walk = mountViewportControls('walk');
    const eye = JSON.stringify(walk.camera.getPosition());
    fingerDrag(walk.canvas);
    assert.equal(JSON.stringify(walk.camera.getPosition()), eye, 'Walk moved the eye (orbited)');
  });

  it('Pan: a second finger pans or pinches as before, and the finger left down pans again', () => {
    const { canvas, camera } = mountViewportControls('pan');
    const direction = viewDirection(camera);
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      canvas.dispatchEvent(touchEvent('touchmove', canvas, [[420, 300]]));
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[420, 300], [500, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[420 - 10 * i, 300], [500 + 10 * i, 300]]));
    });
    const pinched = pose(camera);
    act(() => {
      canvas.dispatchEvent(touchEvent('touchend', canvas, [[380, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[380 + 20 * i, 300 + 10 * i]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.notEqual(pose(camera), pinched, 'the remaining finger did nothing');
    assert.equal(viewDirection(camera), direction, 'BUG: the finger left after a pinch orbited in Pan');
  });

  it('Pan: two fingers that land together, then lift to one, pan with the one left (not the last gesture\'s orbit)', () => {
    const { canvas, camera, activeToolRef } = mountViewportControls('select');
    fingerDrag(canvas); // the last gesture orbited
    activeToolRef.current = 'pan';
    const direction = viewDirection(camera);
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300], [480, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, [[400, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.equal(viewDirection(camera), direction, 'the drag kept the previous gesture\'s orbit');
  });

  it('Walk: a pinch zooms as the wheel does, and the finger left down looks without moving the eye', () => {
    const { canvas, camera } = mountViewportControls('walk');
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300], [480, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 - 10 * i, 300], [480 + 10 * i, 300]]));
    });
    const eye = JSON.stringify(camera.getPosition());
    assert.notEqual(eye, JSON.stringify({ x: 0, y: 0, z: 10 }), 'the pinch did not zoom');
    act(() => {
      canvas.dispatchEvent(touchEvent('touchend', canvas, [[360, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[360 + 20 * i, 300]]));
    });
    assert.equal(JSON.stringify(camera.getPosition()), eye, 'BUG: the finger left after a pinch orbited in Walk');
    act(() => canvas.dispatchEvent(touchEvent('touchend', canvas, [])));
  });

  it('a tool switch mid-drag keeps the gesture it began as, until the finger lifts', () => {
    const { canvas, camera, activeToolRef } = mountViewportControls('pan');
    const direction = viewDirection(camera);
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      canvas.dispatchEvent(touchEvent('touchmove', canvas, [[420, 300]]));
    });
    activeToolRef.current = 'select';
    act(() => {
      for (let i = 2; i <= 5; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.equal(viewDirection(camera), direction, 'the pan drag turned into an orbit mid-gesture');
    fingerDrag(canvas);
    assert.notEqual(viewDirection(camera), direction, 'the next drag, in Select, orbits');
  });

  it('a tool switch mid-drag holds when a second finger lands and lifts again', () => {
    const { canvas, camera, activeToolRef } = mountViewportControls('pan');
    const direction = viewDirection(camera);
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      canvas.dispatchEvent(touchEvent('touchmove', canvas, [[420, 300]]));
    });
    activeToolRef.current = 'select';
    const before = pose(camera);
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[420, 300], [500, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, [[420, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[420 + 20 * i, 300 + 10 * i]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.notEqual(pose(camera), before, 'the finger left did nothing');
    assert.equal(viewDirection(camera), direction, 'the second finger re-read the tool and the one left orbited');
  });

  it('after a pinch in Pan, the finger left picks no orbit pivot (no surface raycast)', () => {
    let casts = 0;
    const { canvas } = mountViewportControls('pan', null, { renderer: { raycastScene: () => { casts++; return null; } } });
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[420, 300], [500, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[420 - 10 * i, 300], [500 + 10 * i, 300]]));
    });
    casts = 0; // only what the lift to one finger casts
    act(() => {
      canvas.dispatchEvent(touchEvent('touchend', canvas, [[380, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[380 + 20 * i, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.equal(casts, 0, 'the lift to one finger raycast for an orbit pivot a pan never uses');
  });

  it('a Pan press picks no orbit pivot (no surface raycast), as a mouse Pan press does', () => {
    let casts = 0;
    const { canvas } = mountViewportControls('pan', null, { renderer: { raycastScene: () => { casts++; return null; } } });
    fingerDrag(canvas);
    assert.equal(casts, 0, 'a Pan drag raycast for an orbit pivot it never uses');
  });

  it('a tap in Pan or Walk selects nothing (control)', async () => {
    for (const tool of ['pan', 'walk']) {
      const { canvas, selectionCount } = mountViewportControls(tool, 42);
      await tap(canvas, 300, 200);
      assert.equal(selectionCount(), 0, tool);
      cleanup(); canvas.remove();
    }
  });

  it('touch-sourced pointer events still never move the camera in Pan (#5856)', () => {
    const { canvas, camera } = mountViewportControls('pan');
    const before = pose(camera);
    act(() => {
      canvas.dispatchEvent(pointer('pointerdown', 'touch', 400, 300));
      canvas.dispatchEvent(pointer('pointermove', 'touch', 480, 300));
      canvas.dispatchEvent(pointer('pointerup', 'touch', 480, 300));
    });
    assert.equal(pose(camera), before);
  });
});
