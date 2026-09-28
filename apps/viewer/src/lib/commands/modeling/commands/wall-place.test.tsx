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
import { cleanup, press, render, type } from '@/test/render.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
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
