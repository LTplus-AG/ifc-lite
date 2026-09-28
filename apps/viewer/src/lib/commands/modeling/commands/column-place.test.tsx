/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `column.place` (charter #6232, M2.2): one click puts a column's base
 * centre on the workplane; R turns the section 15°, and the column plus its
 * turn are ONE undo step. The ghost is built in storey-local terms, so on a
 * rotated storey it follows the storey, not the screen (ledger follow-up:
 * "rotated storeys: column ghosts screen-aligned").
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, press, render, type } from '@/test/render.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandDoubleClick, commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import { setRequestRemesh } from '../transaction.js';
import type { CommandContext, Vec3 } from '../types.js';
import { composeStoreyWorkplane } from '../workplane.js';
import { COLUMN_PLACE, type ColumnPlaceGesture } from './column-place.js';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const gesture = () => getCommandRuntime().gesture as ColumnPlaceGesture;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const round = (v: number) => +v.toFixed(6);
const deg = (rad: number) => round((((rad * 180) / Math.PI) % 360 + 360) % 360);

/** Every live overlay column: its storey-local base point and its yaw in degrees. */
function columns(): { at: number[]; yaw: number }[] {
  const s = useViewerStore.getState();
  const view = s.mutationViews.get(MODEL_ID)!;
  return view.getNewEntities()
    .filter((e) => e.type.toUpperCase() === 'IFCCOLUMN' && !view.isDeleted(e.expressId))
    .map((e) => ({
      at: s.readEntityPosition(MODEL_ID, e.expressId)!.map(round),
      yaw: deg(s.readEntityRotation(MODEL_ID, e.expressId)!.yawZ),
    }));
}

let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
  useViewerStore.getState().startCommand('column.place');
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('column.place (#6232 M2.2)', () => {
  it('a click places one column at the clicked point, one undo step each', () => {
    const before = undoDepth();
    click(2, 3);
    click(5, 3);
    assert.deepEqual(columns(), [{ at: [2, 3, 0], yaw: 0 }, { at: [5, 3, 0], yaw: 0 }]);
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(columns(), [{ at: [2, 3, 0], yaw: 0 }]);
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(columns(), []);
    assert.equal(undoDepth(), before);
  });

  it('R turns it 15°; the turned column is still one undo step, and the turn carries to the next', () => {
    const before = undoDepth();
    act(() => { commandPointerMove(at(1, 1)); });
    press(document.body, 'r');
    press(document.body, 'r');
    assert.equal(gesture().rotation, 30);
    click(1, 1);
    assert.deepEqual(columns(), [{ at: [1, 1, 0], yaw: 30 }]);
    assert.equal(gesture().rotation, 30, 'the next column keeps the turn');
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(columns(), [], 'one undo removes the column and its turn together');
    assert.equal(undoDepth(), before);
  });

  it('a typed Rotation and Width build the column', () => {
    const ui = render(<CommandFieldsBar />);
    act(() => { commandPointerMove(at(0, 0)); });
    press(document.body, '0'); // opens Width
    let input = ui.querySelector('input') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-label'), 'Width');
    type(input, '0.6');
    press(input, 'Tab'); // Depth
    press(ui.querySelector('input') as HTMLInputElement, 'Tab'); // Height
    press(ui.querySelector('input') as HTMLInputElement, 'Tab'); // Rotation
    input = ui.querySelector('input') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-label'), 'Rotation');
    type(input, '-90');
    press(input, 'Enter');
    assert.deepEqual(columns(), [{ at: [0, 0, 0], yaw: 270 }]);
    assert.equal(useViewerStore.getState().authoringDefaults.dims.column?.Width, 0.6, 'Width is the column default now');
  });

  it('a double-click places one column, not two stacked', () => {
    click(4, 4);
    act(() => { commandDoubleClick(at(4, 4)); });
    assert.equal(columns().length, 1);
  });

  it('Escape first straightens a turned column, then leaves', () => {
    press(document.body, 'r');
    press(document.body, 'Escape');
    assert.equal(gesture().rotation, 0);
    assert.equal(useViewerStore.getState().activeTool, 'command');
    press(document.body, 'Escape');
    assert.equal(useViewerStore.getState().activeTool, 'select');
  });
});

describe('column.place ghost (#6232 M2.2)', () => {
  const ghostPlanCorners = (ctx: CommandContext, g: ColumnPlaceGesture) => {
    const [mesh] = COLUMN_PLACE.ghost!(g, ctx);
    assert.ok(mesh);
    const pts: Vec3[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) pts.push([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
    return pts;
  };

  it('on a rotated storey the section follows the storey axes, not the screen', () => {
    useViewerStore.getState().setAuthoringDims('column', { Width: 0.8, Depth: 0.2, Height: 3 });
    const live = getCommandRuntime().ctx as CommandContext;
    // A storey turned 90°: its +x runs along world plan +y.
    const turned = composeStoreyWorkplane({
      modelId: MODEL_ID,
      spec: { kind: 'storey', storeyId: 1, offset: 0 },
      plan: { origin: [0, 0], axisX: [0, 1] },
      elevation: 0,
      coordinateInfo: undefined,
      alignment: null,
      placement: { translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] } },
    });
    const ctx: CommandContext = { ...live, workplane: turned };
    const pts = ghostPlanCorners(ctx, { cursor: [0, 0], rotation: 0 });
    // Storey-local, the ghost is exactly the axis-aligned 0.8 × 0.2 section …
    const local = pts.map((p) => turned.renderToLocal(p));
    const span = (i: 0 | 1 | 2) => round(Math.max(...local.map((p) => p[i])) - Math.min(...local.map((p) => p[i])));
    assert.deepEqual([span(0), span(1), span(2)], [0.8, 0.2, 3]);
    // … so in render space its long side runs along the storey's +x (render −z here), not render x.
    const renderSpan = (i: 0 | 2) => round(Math.max(...pts.map((p) => p[i])) - Math.min(...pts.map((p) => p[i])));
    assert.deepEqual([renderSpan(0), renderSpan(2)], [0.2, 0.8]);
  });

  it('turns with the gesture rotation', () => {
    useViewerStore.getState().setAuthoringDims('column', { Width: 0.8, Depth: 0.2, Height: 3 });
    const ctx = getCommandRuntime().ctx as CommandContext;
    const local = ghostPlanCorners(ctx, { cursor: [0, 0], rotation: 90 }).map((p) => ctx.workplane!.renderToLocal(p));
    const span = (i: 0 | 1) => round(Math.max(...local.map((p) => p[i])) - Math.min(...local.map((p) => p[i])));
    assert.deepEqual([span(0), span(1)], [0.2, 0.8]);
  });
});
