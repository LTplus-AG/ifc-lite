/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9092: the command tool by touch does what the mouse does there, through
 * the mouse's command-pointer path: a double-tap is a double-click, a press
 * that outlived its command or tool places nothing, an iPad keyboard's Shift
 * and Alt reach a tap, a command that follows the press gets a press-drag, a
 * careful slow tap still places, and the snap marker a tap leaves goes with
 * the next press.
 *
 * Mounts the real `useMouseControls` and `useTouchControls` on one canvas.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Camera } from '@ifc-lite/renderer';
import { cleanup, press as pressKey } from '@/test/render.js';
import { useViewerStore } from '@/store';
import {
  mountViewportControls, touchEvent, tap, click, fingerDrag, pencilTap, pencilDrag, type ViewportControlsOptions,
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

const pose = (camera: Camera) => JSON.stringify({ position: camera.getPosition(), target: camera.getTarget() });

let restoreRemesh = () => {};
beforeEach(async () => {
  await seedModelingSession({ roomGeometry: true });
  useViewerStore.setState({ navigationPreset: 'default', interactionMode: 'all' });
  useViewerStore.getState().setAuthoringDefaults({ wallAlign: 'centre', chain: true });
  clearStoreyRoomsCache();
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
  for (const canvas of document.querySelectorAll('canvas')) canvas.remove();
});

// As useTouchControls.tools.test.tsx: one canvas pixel is .01 storey metres on the real workplane.
const commandRig = (tool = 'command', options: ViewportControlsOptions = {}) => mountViewportControls(tool, 42, {
  ...options,
  setup: (camera) => {
    camera.unprojectToRay = (x, y) => ({ origin: { x: x / 100, y: 20, z: y / 100 }, direction: { x: 0, y: -1, z: 0 } });
  },
});
const at = (x: number, y: number) => [x * 100, -y * 100] as const;
const wallGesture = () => getCommandRuntime().gesture as WallPlaceGesture;
const newOf = (type: string) => useViewerStore.getState().mutationViews.get(MODEL_ID)?.getNewEntities()
  .filter((e) => e.type.toUpperCase() === type) ?? [];
const wallEnd = (index: number) => useViewerStore.getState().readWallEndpoints(MODEL_ID, newOf('IFCWALL')[index].expressId)?.end;

/** `Date.now` under the test's hand, for a tap's duration and the double-tap window: still unless advanced. */
function clock(t: TestContext) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  return { advance: (ms: number) => { now += ms; } };
}

function press(canvas: HTMLCanvasElement, x: number, y: number) {
  act(() => { canvas.dispatchEvent(touchEvent('touchstart', canvas, [[x, y]])); });
}
async function lift(canvas: HTMLCanvasElement) {
  await act(async () => { canvas.dispatchEvent(touchEvent('touchend', canvas, [])); });
}

describe('a double-tap is a double-click (#9092)', () => {
  it('ends a wall chain where its first tap placed the point', async (t) => {
    clock(t);
    useViewerStore.getState().startCommand('wall.place');
    const { canvas, selectionCount } = commandRig();
    await tap(canvas, ...at(10, 10));
    await tap(canvas, ...at(15, 10));
    assert.equal(newOf('IFCWALL').length, 1);
    assert.ok(wallGesture().chain.length > 0, 'the chain goes on after the first wall');
    await tap(canvas, ...at(15, 10));
    assert.equal(wallGesture().chain.length, 0, 'BUG: a double-tap did not end the wall chain');
    assert.equal(newOf('IFCWALL').length, 1, 'the double-tap placed a second wall');
    assert.equal(selectionCount(), 0);
  });

  it('closes a slab polygon, once', async (t) => {
    clock(t);
    useViewerStore.getState().setAuthoringDefaults({ slabMode: 'polygon' });
    useViewerStore.getState().startCommand('slab.place');
    const { canvas } = commandRig();
    for (const [x, y] of [[10, 10], [13, 10], [13, 13], [13, 13]] as const) await tap(canvas, ...at(x, y));
    assert.equal(newOf('IFCSLAB').length, 1, 'BUG: a double-tap did not close the slab polygon');
  });

  it('with a Pencil, too (its compatibility clicks add nothing)', async (t) => {
    clock(t);
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    await pencilTap(canvas, ...at(10, 10));
    await pencilTap(canvas, ...at(15, 10));
    await pencilTap(canvas, ...at(15, 10));
    assert.equal(newOf('IFCWALL').length, 1);
    assert.equal(wallGesture().chain.length, 0);
  });

  it('a second tap within the tap slop (tapSlop.ts) is the double-tap; one further away is a second click', async (t) => {
    clock(t);
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    await tap(canvas, ...at(10, 10));
    await tap(canvas, ...at(15, 10));
    await tap(canvas, ...at(15.2, 10)); // 20 px on
    assert.equal(newOf('IFCWALL').length, 2, 'a tap 20 px from the last one ended the chain');
    await tap(canvas, ...at(15.28, 10.08)); // 8 px on, each way
    assert.equal(wallGesture().chain.length, 0, 'a double-tap that drifted 8 px did not end the chain');
    assert.equal(newOf('IFCWALL').length, 2);
  });

  it('two taps further apart than the double-click time are two clicks', async (t) => {
    const time = clock(t);
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    await tap(canvas, ...at(10, 10));
    time.advance(400);
    await tap(canvas, ...at(10, 10));
    assert.equal(wallGesture().chain.length, 1, 'a tap 400 ms after the last ended the chain');
  });

  it('a tap after a double-tap starts afresh: its count is the click count, as the browser keeps it', async (t) => {
    clock(t);
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    await tap(canvas, ...at(10, 10));
    await tap(canvas, ...at(10, 10)); // a double-tap on an empty chain's first point ends it
    assert.equal(wallGesture().chain.length, 0);
    await tap(canvas, ...at(20, 20));
    assert.equal(wallGesture().chain.length, 1, 'a tap far from the double-tap started no chain');
  });

  it('an orbit between two taps at one point breaks the double-tap', async (t) => {
    clock(t);
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    await tap(canvas, ...at(10, 10));
    await tap(canvas, ...at(15, 10));
    fingerDrag(canvas);
    await tap(canvas, ...at(15, 10));
    assert.ok(wallGesture().chain.length > 0, 'a tap after an orbit ended the chain as a double-tap');
  });

  it('a press held into the long press places nothing and is no tap', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    press(canvas, ...at(10, 10));
    act(() => { t.mock.timers.tick(600); });
    await lift(canvas);
    assert.equal(wallGesture().chain.length, 0);
  });
});

describe('a press that outlived its command or tool places nothing (#9092)', () => {
  it('a keyboard command switch mid-press: the release places nothing in the new command', async () => {
    useViewerStore.getState().startCommand('wall.place');
    const { canvas, selectionCount } = commandRig();
    press(canvas, ...at(10, 10));
    act(() => { useViewerStore.getState().startCommand('column.place'); });
    await lift(canvas);
    await act(async () => { canvas.dispatchEvent(click(...at(10, 10), null)); });
    assert.equal(newOf('IFCCOLUMN').length, 0, 'BUG: a tap begun in wall.place placed a column');
    assert.equal(selectionCount(), 0);
  });

  it('Esc on an untouched command mid-press: the release selects nothing in the tool Esc left for', async () => {
    useViewerStore.getState().startCommand('wall.place');
    const { canvas, activeToolRef, selectionCount } = commandRig();
    press(canvas, ...at(10, 10));
    pressKey(document.body, 'Escape');
    assert.equal(useViewerStore.getState().activeTool, 'select');
    activeToolRef.current = 'select'; // as Viewport.tsx mirrors the store
    await lift(canvas);
    await act(async () => { canvas.dispatchEvent(click(...at(10, 10), null)); });
    assert.equal(selectionCount(), 0, 'BUG: a press begun in the command tool selected after Esc');
  });

  it('a tool switch into the command tool mid-press places nothing and selects nothing', async () => {
    const { canvas, activeToolRef, selectionCount } = commandRig('select');
    press(canvas, ...at(10, 10));
    act(() => { useViewerStore.getState().startCommand('wall.place'); });
    activeToolRef.current = 'command';
    await lift(canvas);
    await act(async () => { canvas.dispatchEvent(click(...at(10, 10), null)); });
    assert.equal(wallGesture().chain.length, 0, 'BUG: a press begun in Select placed a wall point');
    assert.equal(selectionCount(), 0);
  });

  it('Esc on a progressed gesture resets it and the press still places, as the mouse click does (control)', async () => {
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    await tap(canvas, ...at(10, 10));
    press(canvas, ...at(20, 20));
    pressKey(document.body, 'Escape');
    assert.equal(wallGesture().chain.length, 0);
    await lift(canvas);
    assert.deepEqual(wallGesture().chain.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]), [[20, 20]]);
  });
});

describe('a tap reads the keyboard and has no time limit, as a click (#9092)', () => {
  it('Shift held on a keyboard steps the angle', async () => {
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    await tap(canvas, ...at(10, 10));
    await tap(canvas, ...at(15, 10.4), { shiftKey: true });
    const end = wallEnd(0);
    assert.ok(end);
    assert.ok(Math.abs(end[1] - 10) < 1e-6, `BUG: Shift on a tap did not step the angle (end y ${end[1]})`);
  });

  it('without Shift the same taps keep their angle (control)', async () => {
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    await tap(canvas, ...at(10, 10));
    await tap(canvas, ...at(15, 10.4));
    assert.ok(Math.abs((wallEnd(0)?.[1] ?? 0) - 10.4) < 1e-6);
  });

  it('a careful 400 ms tap places a point, short of the long press', async (t) => {
    const time = clock(t);
    useViewerStore.getState().startCommand('wall.place');
    const { canvas } = commandRig();
    press(canvas, ...at(10, 10));
    time.advance(400);
    await lift(canvas);
    assert.equal(wallGesture().chain.length, 1, 'BUG: a 400 ms tap placed nothing');
  });

  it('a 400 ms tap in Select still selects nothing (tap-to-select keeps its 300 ms)', async (t) => {
    const time = clock(t);
    const { canvas, selectionCount } = commandRig('select');
    press(canvas, 300, 200);
    time.advance(400);
    await lift(canvas);
    assert.equal(selectionCount(), 0);
  });

  /** Snap on, with a vertex under every point: `targets` is each snap marker shown (its type) or cleared. */
  function snapRig() {
    useViewerStore.getState().startCommand('wall.place');
    const targets: Array<string | null> = [];
    const rig = commandRig('command', {
      mouse: { snapEnabledRef: { current: true }, setSnapTarget: (target) => { targets.push(target ? target.type : null); } },
      renderer: {
        raycastSceneMagnetic: (x: number) => ({
          intersection: { point: { x: x / 100, y: 0, z: 0 }, expressId: 1 },
          snapTarget: { type: 'vertex', position: { x: x / 100, y: 0, z: 0 }, expressId: 1, confidence: 1 },
          edgeLock: { shouldRelease: false, shouldLock: false, edge: null },
        }),
      },
    });
    return { ...rig, targets };
  }

  it('Alt held on a keyboard suspends snapping for the tap', async () => {
    const { canvas, targets } = snapRig();
    await tap(canvas, ...at(10, 10), { altKey: true });
    assert.equal(wallGesture().chain.length, 1);
    assert.equal(targets.includes('vertex'), false, 'BUG: Alt on a tap did not suspend snapping');
  });

  it('the snap marker a tap leaves goes with the next press', async () => {
    const { canvas, targets } = snapRig();
    await tap(canvas, ...at(10, 10));
    assert.equal(targets.at(-1), 'vertex', 'the tap shows where it snapped');
    fingerDrag(canvas);
    assert.equal(targets.at(-1), null, 'BUG: the snap marker stayed through the next orbit');
  });
});

describe('a command that follows the press gets a press-drag (#9092)', () => {
  /** A stub of room.place edit mode, which needs no room WASM: `grab` whether a press grabs (`pressDrags`). */
  function pressDriven(t: TestContext, grab: boolean) {
    const calls: string[] = [];
    const id = 'test.press-drag' as CommandId;
    const x = (s: { local: readonly number[] }) => +s.local[0].toFixed(2);
    t.after(registerModelingCommand({
      ...getModelingCommand('column.place')!,
      id,
      pointerDownOnPress: () => true,
      pressDrags: () => grab,
      pointerMove: (g, s) => ({ ...(g as object), hovered: x(s) }),
      pointerDown: (g, s) => { calls.push(`down ${x(s)}`); return g; },
      pointerUp: (g, s) => { calls.push(`up ${x(s)}`); return g; },
      pointerCancel: (g) => { calls.push('cancel'); return g; },
    }));
    useViewerStore.getState().startCommand(id);
    return calls;
  }

  it('a drag from a press that took something is the command\'s: down where it landed, up where it lifted, no orbit', (t) => {
    const calls = pressDriven(t, true);
    const { canvas, camera } = commandRig();
    const before = pose(camera);
    fingerDrag(canvas); // 400 to 500 px
    assert.deepEqual(calls, ['down 4', 'up 5'], 'BUG: a finger drag did not drag for the command');
    assert.equal(pose(camera), before, 'the command drag also orbited');
  });

  it('the release lands where the finger lifted, past its last move', (t) => {
    const calls = pressDriven(t, true);
    const { canvas } = commandRig();
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]]));
      // No finger left down, and the lifted one where it left the glass
      const end = new window.Event('touchend', { bubbles: true, cancelable: true });
      Object.defineProperty(end, 'touches', { value: [] });
      Object.defineProperty(end, 'changedTouches', { value: [{ identifier: 1, target: canvas, clientX: 500, clientY: 300 }] });
      canvas.dispatchEvent(end);
    });
    assert.deepEqual(calls, ['down 4', 'up 5'], 'the release landed at the last move (480 px), not the lift (500 px)');
  });

  it('a Pencil drag, the same', (t) => {
    const calls = pressDriven(t, true);
    const { canvas, camera } = commandRig();
    const before = pose(camera);
    pencilDrag(canvas);
    assert.deepEqual(calls, ['down 4', 'up 5']);
    assert.equal(pose(camera), before);
  });

  it('a drag from where a press grabs nothing orbits, and presses and releases nothing', (t) => {
    const calls = pressDriven(t, false);
    const { canvas, camera } = commandRig();
    const before = pose(camera);
    fingerDrag(canvas);
    assert.notEqual(pose(camera), before, 'one finger can still turn the view');
    assert.deepEqual(calls, [], 'a finger turning the view pressed the command');
    assert.equal((getCommandRuntime().gesture as { hovered?: number }).hovered, undefined,
      'the orbit left a hover behind, which Enter would commit');
  });

  it('a press that grabs has no long press: resting on it before dragging still drags', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const calls = pressDriven(t, true);
    const { canvas, camera, menus } = commandRig();
    const before = pose(camera);
    act(() => { canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]])); });
    act(() => { t.mock.timers.tick(700); });
    act(() => {
      for (let i = 1; i <= 5; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]]));
    });
    await lift(canvas);
    assert.equal(menus.length, 0, 'BUG: resting on a grab opened the context menu');
    assert.deepEqual(calls, ['down 4', 'up 5'], 'BUG: the long press took the drag from the command');
    assert.equal(pose(camera), before);
  });

  it('a touchcancel during a command drag cancels it, as a cancelled mouse press', (t) => {
    const calls = pressDriven(t, true);
    const { canvas } = commandRig();
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      for (let i = 1; i <= 2; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]]));
      canvas.dispatchEvent(touchEvent('touchcancel', canvas, []));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.deepEqual(calls, ['down 4', 'cancel']);
  });

  it('a tap is a press and a release in place, whether or not it grabs', async (t) => {
    const calls = pressDriven(t, false);
    const { canvas } = commandRig();
    await tap(canvas, 400, 300);
    assert.deepEqual(calls, ['down 4', 'up 4']);
  });

  it('a pinch that starts from a command press presses nothing', (t) => {
    const calls = pressDriven(t, true);
    const { canvas } = commandRig();
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300], [480, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 - 10 * i, 300], [480 + 10 * i, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, [[360, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[360 + 20 * i, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.deepEqual(calls, [], 'the first finger of a pinch pressed the command');
  });

  it('a second finger during a command drag cancels it, as a cancelled mouse press, and the pinch zooms', (t) => {
    const calls = pressDriven(t, true);
    const { canvas, camera } = commandRig();
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      for (let i = 1; i <= 2; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]]));
    });
    const before = pose(camera);
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[440, 300], [520, 300]]));
      for (let i = 1; i <= 4; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[440 - 10 * i, 300], [520 + 10 * i, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.deepEqual(calls, ['down 4', 'cancel']);
    assert.notEqual(pose(camera), before, 'the pinch did not zoom');
  });

  it('the command ending under a drag: the rest of the drag moves nothing, and the lift releases nothing', (t) => {
    const calls = pressDriven(t, true);
    const { canvas, camera, activeToolRef, selectionCount } = commandRig();
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[400, 300]]));
      canvas.dispatchEvent(touchEvent('touchmove', canvas, [[420, 300]]));
    });
    act(() => { useViewerStore.getState().endCommand('cancel'); });
    activeToolRef.current = 'select';
    const before = pose(camera);
    act(() => {
      for (let i = 2; i <= 5; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[400 + 20 * i, 300]]));
      canvas.dispatchEvent(touchEvent('touchend', canvas, []));
    });
    assert.deepEqual(calls, ['down 4']);
    assert.equal(pose(camera), before, 'the rest of the command drag orbited');
    assert.equal(selectionCount(), 0);
  });

  it('room.place edit mode: a finger drags a room corner, as a mouse press-drag', async (t) => {
    if (!ensureRoomWasm(t)) return;
    await ensureSpaceWasm();
    setWallMeshes([...BOX, [[4, 0], [4, 5]]]);
    useViewerStore.getState().startCommand('room.place');
    await act(async () => { await runRoomAction('auto'); });
    const left = authoredSpaces().find((space) => space.footprint.every(([x]) => x < 4.1));
    assert.ok(left);
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), mode: 'edit', edit: { tool: 'shape', hover: null, drag: null, cut: null, op: null } })); });
    const { canvas, camera } = commandRig();
    const before = pose(camera);
    const [x0, y0] = at(4, 5), [x1] = at(3, 5);
    act(() => {
      canvas.dispatchEvent(touchEvent('touchstart', canvas, [[x0, y0]]));
      for (let i = 1; i <= 5; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[x0 + ((x1 - x0) * i) / 5, y0]]));
    });
    await act(async () => { canvas.dispatchEvent(touchEvent('touchend', canvas, [])); });
    assert.equal(pose(camera), before, 'the corner drag orbited');
    assert.equal(spaceQuantity(left.id, 'GrossFloorArea'), 17.5, 'BUG: the corner did not move to where the finger lifted');
  });

  /** room.place in edit mode with `tool`, on a box split at x = 4: the left room. */
  async function roomEdit(t: TestContext, tool: 'shape' | 'remove') {
    if (!ensureRoomWasm(t)) return null;
    await ensureSpaceWasm();
    setWallMeshes([...BOX, [[4, 0], [4, 5]]]);
    useViewerStore.getState().startCommand('room.place');
    await act(async () => { await runRoomAction('auto'); });
    const left = authoredSpaces().find((space) => space.footprint.every(([x]) => x < 4.1));
    assert.ok(left);
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), mode: 'edit', edit: { tool, hover: null, drag: null, cut: null, op: null } })); });
    return left;
  }
  const roomDrag = (canvas: HTMLCanvasElement, from: readonly [number, number], dx: number) => act(() => {
    canvas.dispatchEvent(touchEvent('touchstart', canvas, [[from[0], from[1]]]));
    for (let i = 1; i <= 5; i++) canvas.dispatchEvent(touchEvent('touchmove', canvas, [[from[0] + (dx * i) / 5, from[1]]]));
    canvas.dispatchEvent(touchEvent('touchend', canvas, []));
  });

  it('room.place edit mode: with a corner grabbed by a tap, a drag elsewhere orbits and does not drop it', async (t) => {
    const left = await roomEdit(t, 'shape');
    if (!left) return;
    const area = spaceQuantity(left.id, 'GrossFloorArea');
    const { canvas, camera } = commandRig();
    await tap(canvas, ...at(4, 5));
    assert.ok((getCommandRuntime().gesture as RoomPlaceGesture).edit.drag, 'the tap did not grab the corner');
    const before = pose(camera);
    roomDrag(canvas, at(1, 1), 100);
    assert.notEqual(pose(camera), before, 'the drag did not orbit');
    const { drag } = (getCommandRuntime().gesture as RoomPlaceGesture).edit;
    assert.ok(drag, 'an orbit dropped the grabbed corner');
    assert.equal(drag.moved, false, 'an orbit moved the grabbed corner\'s preview, which Enter would commit');
    assert.equal(spaceQuantity(left.id, 'GrossFloorArea'), area, 'an orbit moved the corner');
  });

  it('room.place edit mode, Remove: a drag from a room edge orbits and removes nothing', async (t) => {
    const left = await roomEdit(t, 'remove');
    if (!left) return;
    const rooms = authoredSpaces().length;
    const { canvas, camera } = commandRig();
    const before = pose(camera);
    roomDrag(canvas, at(4, 2.5), 100);
    assert.notEqual(pose(camera), before, 'the drag did not orbit');
    assert.equal(authoredSpaces().length, rooms, 'an orbit removed a room edge');
    assert.equal((getCommandRuntime().gesture as RoomPlaceGesture).edit.hover, null, 'the orbit left the edge hovered, which Enter would remove');
  });
});
