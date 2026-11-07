/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Aiming through to the workplane (#9201). A real session, command pointer,
 * solver and runtime over a fake renderer: the cursor ray drops straight onto
 * the storey floor at (x/100, −y/100) m, and `surface` is what stands in front
 * of it, as an angled camera sees it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, render } from '@/test/render.js';
import '@/lib/commands/modeling/builtin';
import { aimHint } from '@/lib/commands/modeling/aim-hint';
import { forgetCommandPointer, replayCommandPointer } from '@/lib/commands/modeling/pointer-replay';
import { getModelingCommand } from '@/lib/commands/modeling/registry';
import { getCommandRuntime, useCommandRuntime } from '@/lib/commands/modeling/runtime';
import { pointerAim } from '@/lib/commands/modeling/snap-solve';
import { resolve as translate } from '@/i18n/registry';
import { routeCommandPointer } from './commandPointer.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { createPlanCutSource } from './plan/plan-cut-source';
import { routePlanPointer } from './plan/PlanPointer';
import { useAimKey } from './tools/command/useAimKey.js';

const PICKS_AN_ELEMENT = ['door.place', 'window.place', 'opening.place', 'hosted.slide', 'element.align', 'element.split', 'element.trimExtend'];
const PLACES_A_POINT = ['wall.place', 'column.place', 'beam.place', 'slab.place', 'grid.place', 'stair.place', 'railing.place', 'curtainwall.place', 'split.multi', 'element.move', 'element.rotate'];

const NO_LOCK = { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: false, isCorner: false, cornerValence: 0 };

/** Render space: floor (x, y) is render (x, 0, −y). */
type Surface = (x: number, y: number) => { x: number; y: number; z: number };

/** By default a slab top: 0.3 m up and 0.5 m off the floor point the ray reaches. */
const SLAB_TOP: Surface = (x, y) => ({ x: x / 100 + 0.5, y: 0.3, z: y / 100 });

function pointer(surface: Surface = SLAB_TOP, snapEnabled = true, up = false) {
  const canvas = { width: 1000, height: 1000, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) };
  const intersection = (x: number, y: number) => ({ point: surface(x, y), expressId: 1 });
  return {
    renderer: {
      // `up`: the ray climbs away from the plane, as past the horizon.
      getCamera: () => ({ unprojectToRay: (sx: number, sy: number) => ({ origin: { x: sx / 100, y: 20, z: sy / 100 }, direction: { x: 0, y: up ? 1 : -1, z: 0 } }) }),
      getCanvas: () => canvas,
      raycastScene: (x: number, y: number) => ({ intersection: intersection(x, y) }),
      raycastSceneMagnetic: (x: number, y: number) => ({ snapTarget: null, intersection: intersection(x, y), edgeLock: NO_LOCK }),
    },
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null }),
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, lockStrength: 0 } },
    snapEnabledRef: { current: snapEnabled },
    setSnapTarget: () => {}, setEdgeLock: () => {}, clearEdgeLock: () => {},
    measureRaycastPendingRef: { current: false },
    measureRaycastFrameRef: { current: null },
  } as unknown as MouseHandlerContext;
}

const click = (ctx: MouseHandlerContext, x: number, y: number, altKey = false, shiftKey = false) =>
  routeCommandPointer(ctx, 'down', x, y, { shiftKey, altKey });
const landed = () => {
  const snap = getCommandRuntime().snap;
  assert.ok(snap, 'the pointer resolved');
  return { local: snap.local.map((v) => +v.toFixed(6)), winner: snap.winner?.kind ?? null };
};
const nextFrame = () => new Promise((done) => requestAnimationFrame(done));

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.getState().startCommand('wall.place');
});
afterEach(() => {
  cleanup();
  forgetCommandPointer();
  useViewerStore.setState({ snapEnabled: true });
  useViewerStore.getState().exitModelWorkspace();
});

describe('aiming through to the workplane (#9201)', () => {
  it('a plain click lands under what you see, so drawing on top of a slab keeps working', () => {
    click(pointer(), 300, -300);
    assert.deepEqual(landed().local, [3.5, 3]);
  });

  it('Alt lands on the ray ∩ workplane past the surface, and reports the plane for the HUD to mark', () => {
    click(pointer(), 300, -300, true);
    assert.deepEqual(landed(), { local: [3, 3], winner: 'workplane' });
  });

  it('snapping off does the same with no key held', () => {
    click(pointer(SLAB_TOP, false), 300, -300);
    assert.deepEqual(landed(), { local: [3, 3], winner: 'workplane' });
  });

  it('the point the runtime commits is the one the HUD marks', () => {
    const ctx = pointer();
    click(ctx, 300, -300, true);
    assert.deepEqual((getCommandRuntime().gesture as { chain: number[][] }).chain.map((p) => p.map((v) => +v.toFixed(6))), [[3, 3]]);
    const render = getCommandRuntime().snap?.render;
    assert.deepEqual(render?.map((v) => +v.toFixed(6) + 0), [3, 0, -3]);
  });

  it('snapping off stops the guides inferred from the chain, not only the surface and its targets', () => {
    const floor: Surface = (x, y) => ({ x: x / 100, y: 0, z: y / 100 });
    // Three pixels off the axis through the first point: snapping on tracks it, off must not.
    click(pointer(floor), 300, -300);
    click(pointer(floor), 800, -303);
    assert.deepEqual(landed().local, [8, 3], 'the same aim with snapping on tracks the axis');
    useViewerStore.getState().endCommand('cancel');
    useViewerStore.getState().startCommand('wall.place');
    click(pointer(floor), 300, -300);
    click(pointer(floor, false), 800, -303);
    assert.deepEqual(landed(), { local: [8, 3.03], winner: 'workplane' });
  });

  it('a Shift lock still holds the point, which stays on the plane', () => {
    const ctx = pointer();
    click(ctx, 300, -300, true);
    click(ctx, 800, -340, true, true);
    assert.deepEqual(landed(), { local: [8, 3], winner: 'workplane' });
  });

  it('a window with snapping off still lands on the wall you aim at, not the floor behind it', () => {
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    useViewerStore.getState().startCommand('window.place');
    // The ray reaches the floor 4 m behind the wall; the surface it crosses first is the wall's face.
    const ctx = pointer(() => ({ x: 2, y: 1.2, z: -0.1 }), false);
    click(ctx, 200, -400);
    const windows = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCWINDOW');
    assert.equal(windows.length, 1);
  });

  it('commands that pick an element keep reading the surface; commands that place a point aim through', () => {
    const plane = getCommandRuntime().ctx!.workplane!;
    const aimOf = (id: string) => {
      const command = getModelingCommand(id);
      assert.ok(command, `${id} is registered`);
      return pointerAim(command, undefined as never, plane, true, true);
    };
    for (const id of PICKS_AN_ELEMENT) assert.equal(aimOf(id), 'surface', id);
    for (const id of PLACES_A_POINT) assert.equal(aimOf(id), 'through', id);
  });
});

describe('the Alt key while a command runs (#9201)', () => {
  function Key() { useAimKey(true); return null; }
  const fire = (type: 'keydown' | 'keyup', key: string, repeat = false) => {
    const event = new KeyboardEvent(type, { key, repeat, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    return event;
  };

  it('moves the point the moment Alt goes down or up, with the pointer still', async () => {
    render(<Key />);
    routeCommandPointer(pointer(), 'move', 300, -300, { shiftKey: false, altKey: false });
    await nextFrame();
    assert.deepEqual(landed(), { local: [3.5, 3], winner: 'face' });
    fire('keydown', 'Alt');
    await nextFrame();
    assert.deepEqual(landed(), { local: [3, 3], winner: 'workplane' });
    fire('keyup', 'Alt');
    await nextFrame();
    assert.deepEqual(landed(), { local: [3.5, 3], winner: 'face' });
  });

  it('lets go when the window loses focus, since Alt+Tab never sends the release', async () => {
    render(<Key />);
    routeCommandPointer(pointer(), 'move', 300, -300, { shiftKey: false, altKey: true });
    await nextFrame();
    assert.equal(landed().winner, 'workplane');
    window.dispatchEvent(new Event('blur'));
    await nextFrame();
    assert.equal(landed().winner, 'face');
  });

  it('keeps Alt from reaching the browser, and leaves AltGr and other keys alone', () => {
    render(<Key />);
    assert.equal(fire('keydown', 'Alt').defaultPrevented, true);
    assert.equal(fire('keyup', 'Alt').defaultPrevented, true);
    assert.equal(fire('keydown', 'AltGraph').defaultPrevented, false);
    assert.equal(fire('keydown', 'Shift').defaultPrevented, false);
  });

  it('turning snapping off with the pointer still moves the point at once', async () => {
    const ctx = pointer();
    // The viewport writes its snap ref while it renders (`useLatestRef`); so does this stand-in.
    function Viewport() { ctx.snapEnabledRef.current = useViewerStore((st) => st.snapEnabled); useAimKey(true); return null; }
    render(<Viewport />);
    routeCommandPointer(ctx, 'move', 300, -300, { shiftKey: false, altKey: false });
    await nextFrame();
    assert.equal(landed().winner, 'face');
    // Only the store changes, as when S is pressed.
    useViewerStore.setState({ snapEnabled: false });
    await nextFrame();
    assert.deepEqual(landed(), { local: [3, 3], winner: 'workplane' });
  });

  it('in the plan, a replay reads the snap toggle as it is now, not as it was at the last move', () => {
    render(<Key />);
    // A plan-cut corner at (2, 2), 10 px/m: snapping on takes it.
    const cut = createPlanCutSource(() => ({ segments: [[[2, 2], [6, 2]]], midpoints: true }));
    const input = { local: [2.3, 2.2] as const, metresPerPixel: 0.1, mods: { shiftKey: false, altKey: false }, snapping: true, planSources: [cut] };
    routePlanPointer('move', input);
    assert.equal(landed().winner, 'endpoint');
    useViewerStore.setState({ snapEnabled: false });
    assert.deepEqual(landed(), { local: [2.3, 2.2], winner: 'workplane' });
    // Alt down and up with the pointer still: snapping stays off.
    fire('keydown', 'Alt');
    fire('keyup', 'Alt');
    assert.deepEqual(landed(), { local: [2.3, 2.2], winner: 'workplane' });
  });

  it('Alt replays Shift as it is now, not as it was at the last move', async () => {
    render(<Key />);
    routeCommandPointer(pointer(), 'move', 300, -300, { shiftKey: false, altKey: false });
    await nextFrame();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', shiftKey: true, bubbles: true, cancelable: true }));
    await nextFrame();
    assert.deepEqual(getCommandRuntime().snap?.modifiers, { shift: true, alt: true });
  });

  it('a new command forgets the last pointer, and replays from its own click', async () => {
    function Live() { useAimKey(useCommandRuntime().command); return null; }
    render(<Live />);
    routeCommandPointer(pointer(), 'move', 700, -700, { shiftKey: false, altKey: false });
    await nextFrame();
    useViewerStore.getState().startCommand('column.place');
    await nextFrame();
    fire('keydown', 'Alt');
    await nextFrame();
    assert.equal(getCommandRuntime().snap, null, 'the old command\'s pointer is not replayed into the new one');
    fire('keyup', 'Alt');
    useViewerStore.getState().startCommand('wall.place');
    await nextFrame();
    click(pointer(), 300, -300);
    fire('keydown', 'Alt');
    await nextFrame();
    assert.deepEqual(landed(), { local: [3, 3], winner: 'workplane' });
  });

  it('a ray that misses the plane clears the mark instead of leaving the last one', async () => {
    routeCommandPointer(pointer(), 'move', 300, -300, { shiftKey: false, altKey: true });
    await nextFrame();
    assert.equal(landed().winner, 'workplane');
    routeCommandPointer(pointer(SLAB_TOP, true, true), 'move', 300, -200, { shiftKey: false, altKey: true });
    await nextFrame();
    assert.equal(getCommandRuntime().snap, null);
  });

  it('after the pointer has left, Alt moves nothing', async () => {
    render(<Key />);
    routeCommandPointer(pointer(), 'move', 300, -300, { shiftKey: false, altKey: false });
    await nextFrame();
    forgetCommandPointer();
    replayCommandPointer({ altKey: true, shiftKey: false });
    await nextFrame();
    assert.equal(landed().winner, 'face');
  });
});

describe('the aim hint (#9201)', () => {
  const hint = (snapEnabled: boolean) => {
    const { command, gesture, ctx, snap } = getCommandRuntime();
    return aimHint(command!, gesture, ctx!.workplane, snapEnabled, snap);
  };

  it('offers Alt while the pointer reads what you see, and says when it is aiming through', () => {
    assert.deepEqual(hint(true), { key: 'modelingCommand.aim.holdAlt', active: false });
    click(pointer(), 300, -300, true);
    assert.deepEqual(hint(true), { key: 'modelingCommand.aim.altHeld', active: true });
    assert.deepEqual(hint(false), { key: 'modelingCommand.aim.snapOff', active: true });
  });

  it('says nothing for a command that never aims through', () => {
    useViewerStore.getState().startCommand('window.place');
    assert.equal(hint(true), null);
    assert.equal(hint(false), null);
  });

  it('every line names the key through the catalogue', () => {
    assert.match(translate('modelingCommand.aim.holdAlt', { key: 'Alt' }), /^Hold Alt to /);
    assert.match(translate('modelingCommand.aim.altHeld', { key: '⌥' }), /^⌥ held: /);
  });
});
