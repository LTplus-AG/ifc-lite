/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `wall.place` (charter #6232, WP2): chained two-click walls on the session
 * workplane — each wall ONE undo step, typed length / angle through the
 * command's fields (keyboard: a digit opens Length, Tab moves to Angle, Enter
 * places), Backspace drops a point, Escape stops chaining then leaves.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { blur, cleanup, click as clickEl, press, render, type } from '@/test/render.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import { act } from 'react';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import { WallPlaceBar } from '@/components/viewer/tools/command/PlacementBars';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import '../builtin.js';
import { commandDoubleClick, commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import type { CommandContext } from '../types.js';
import { WALL_PLACE } from './wall-place.js';
import type { WallPlaceGesture } from './wall-place-geometry.js';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const gesture = () => getCommandRuntime().gesture as WallPlaceGesture;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const click = (x: number, y: number) => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); };

/** Every wall in the model's overlay, as [start, end] plan points (rounded). */
function walls(): [Vec2, Vec2][] {
  const s = useViewerStore.getState();
  const view = s.mutationViews.get(MODEL_ID)!;
  return view.getNewEntities()
    .filter((e) => e.type.toUpperCase() === 'IFCWALL' && !view.isDeleted(e.expressId))
    .map((e) => s.readWallEndpoints(MODEL_ID, e.expressId)!)
    .map((w) => [[+w.start[0].toFixed(6), +w.start[1].toFixed(6)], [+w.end[0].toFixed(6), +w.end[1].toFixed(6)]]);
}

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.getState().setAuthoringDefaults({ wallAlign: 'centre', chain: true });
  useViewerStore.getState().startCommand('wall.place');
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('wall.place (#6232 WP2)', () => {
  it('runs on the session storey workplane', () => {
    const ctx = getCommandRuntime().ctx;
    assert.equal(getCommandRuntime().command?.id, 'wall.place');
    assert.ok(ctx?.workplane, 'the session resolved a workplane');
  });

  it('chains: each click after the first commits one wall and continues from its end', () => {
    const before = undoDepth();
    click(0, 0);
    assert.deepEqual(walls(), [], 'the first click only anchors');
    click(4, 0);
    click(4, 3);
    assert.deepEqual(walls(), [[[0, 0], [4, 0]], [[4, 0], [4, 3]]]);
    assert.deepEqual(gesture().chain.at(-1), [4, 3], 'the chain continues from the last end');

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(walls(), [[[0, 0], [4, 0]]], 'one undo removes exactly the last wall');
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(walls(), []);
    assert.equal(undoDepth(), before);
  });

  it('typing 3.5 then Enter places a 3.5 m wall towards the cursor', () => {
    const ui = render(<CommandFieldsBar />);
    click(1, 1);
    commandPointerMove(at(1, 9)); // aim straight up +y
    press(document.body, '3');
    const input = ui.querySelector('input') as HTMLInputElement;
    assert.ok(input, 'a digit opens the Length field');
    assert.equal(input.value, '3');
    type(input, '3.5');
    press(input, 'Enter');
    assert.deepEqual(walls(), [[[1, 1], [1, 4.5]]]);
    assert.equal(gesture().length, null, 'typed locks are per segment');
  });

  it('Tab moves from Length to Angle; both lock the segment', () => {
    const ui = render(<CommandFieldsBar />);
    click(0, 0);
    commandPointerMove(at(3, 0.2));
    press(document.body, 'Tab');
    type(ui.querySelector('input') as HTMLInputElement, '2');
    press(ui.querySelector('input') as HTMLInputElement, 'Tab');
    const angle = ui.querySelector('input') as HTMLInputElement;
    assert.equal(angle.getAttribute('aria-label'), 'Angle');
    type(angle, '90');
    press(angle, 'Enter');
    assert.deepEqual(walls(), [[[0, 0], [0, 2]]]);
  });

  it('a value typed then Tabbed past leaves the untouched Length unlocked when the plan is clicked (#6232 F1)', () => {
    const ui = render(<CommandFieldsBar />);
    press(document.body, 'Tab');
    press(ui.querySelector('input') as HTMLInputElement, 'Tab', { shiftKey: true }); // wraps to Height
    type(ui.querySelector('input') as HTMLInputElement, '3');
    press(ui.querySelector('input') as HTMLInputElement, 'Tab'); // wraps to Length, showing 0
    const length = ui.querySelector('input') as HTMLInputElement;
    assert.equal(length.getAttribute('aria-label'), 'Length');
    // A click in the plan: the pointer-down lands first, then the open field blurs.
    act(() => click(0, 0)); // re-render, as a real pointer-down does, before the blur
    blur(length);
    assert.equal(gesture().length, null, 'the untouched Length did not lock its 0');
    act(() => click(4, 0));
    assert.deepEqual(walls(), [[[0, 0], [4, 0]]]);
  });

  it('Backspace drops the last point; Escape stops chaining, a second Escape leaves', () => {
    click(0, 0);
    click(2, 0);
    press(document.body, 'Backspace');
    assert.deepEqual(gesture().chain, [[0, 0]]);
    press(document.body, 'Escape');
    assert.deepEqual(gesture().chain, [], 'first Escape resets the chain');
    assert.equal(useViewerStore.getState().activeTool, 'command');
    press(document.body, 'Escape');
    assert.equal(useViewerStore.getState().activeTool, 'select');
    assert.deepEqual(walls(), [[[0, 0], [2, 0]]], 'walls already placed stay');
  });

  it('previews the next wall as a ghost box on the workplane', () => {
    const ctx = getCommandRuntime().ctx as CommandContext;
    assert.deepEqual(WALL_PLACE.ghost!(gesture(), ctx), [], 'nothing before the first click');
    click(0, 0);
    commandPointerMove(at(4, 0));
    const [ghost] = WALL_PLACE.ghost!(gesture(), ctx);
    assert.ok(ghost);
    assert.equal(ghost.positions.length, 12 * 9, 'a box: twelve triangles');
    const xs = [...ghost.positions].filter((_, i) => i % 3 === 0);
    assert.ok(Math.abs(Math.min(...xs)) < 1e-6 && Math.abs(Math.max(...xs) - 4) < 1e-6, 'spans the segment');
  });
});

describe('wall.place Align and Chain (#6232 M2.2)', () => {
  // Walking a→b, Left means the drawn line is the wall's left face, so the
  // axis sits half the thickness (0.2 m default) to the right of it.
  for (const [align, y] of [['left', -0.1], ['centre', 0], ['right', 0.1]] as const) {
    it(`Align ${align}: the drawn line is the wall's ${align === 'centre' ? 'axis' : `${align} face`}`, () => {
      const ui = render(<WallPlaceBar />);
      const label = { left: 'Left', centre: 'Centre', right: 'Right' }[align];
      clickEl([...ui.querySelectorAll('button')].find((b) => b.textContent === label)!);
      assert.equal(useViewerStore.getState().authoringDefaults.wallAlign, align);
      click(0, 0);
      click(4, 0);
      assert.deepEqual(walls(), [[[0, y], [4, y]]]);
    });
  }

  it('Align offsets the ghost the same way the commit does', () => {
    useViewerStore.getState().setAuthoringDefaults({ wallAlign: 'left' });
    const ctx = getCommandRuntime().ctx as CommandContext;
    click(0, 0);
    commandPointerMove(at(4, 0));
    const [ghost] = WALL_PLACE.ghost!(gesture(), ctx);
    const ys: number[] = [];
    for (let i = 0; i < ghost.positions.length; i += 3) {
      ys.push(ctx.workplane!.renderToLocal([ghost.positions[i], ghost.positions[i + 1], ghost.positions[i + 2]])[1]);
    }
    assert.deepEqual([Math.min(...ys), Math.max(...ys)].map((v) => +v.toFixed(6)), [-0.2, 0], 'the wall body lies right of the drawn line');
  });

  it('a chained, aligned run keeps chaining from the drawn line, not the offset axis', () => {
    useViewerStore.getState().setAuthoringDefaults({ wallAlign: 'right' });
    click(0, 0);
    click(4, 0);
    click(4, 3);
    assert.deepEqual(gesture().chain.at(-1), [4, 3], 'the chain follows the clicks');
    assert.deepEqual(walls(), [[[0, 0.1], [4, 0.1]], [[3.9, 0], [3.9, 3]]]);
  });

  it('Chain off: each wall is its own two clicks', () => {
    const ui = render(<WallPlaceBar />);
    clickEl([...ui.querySelectorAll('button')].find((b) => b.textContent === 'Chain')!);
    assert.equal(useViewerStore.getState().authoringDefaults.chain, false);
    click(0, 0);
    click(2, 0);
    assert.deepEqual(gesture().chain, [], 'a fresh start after the wall');
    click(5, 5);
    assert.deepEqual(walls(), [[[0, 0], [2, 0]]], 'the next click only anchors');
  });

  it('a double-click ends the chain at the double-clicked point', () => {
    click(0, 0);
    click(3, 0);
    act(() => { commandDoubleClick(at(3, 0)); });
    assert.deepEqual(gesture().chain, []);
    assert.deepEqual(walls(), [[[0, 0], [3, 0]]], 'exactly one wall, no zero-length second one');
  });
});
