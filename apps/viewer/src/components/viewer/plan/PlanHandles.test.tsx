/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan's direct-edit handles (#6232 B3), mounted: the selected wall's end
 * handles drag its end with the same command, and so the same mutation, as
 * the 3D end handle; the selected window's slide handle drags it along its
 * wall, clamped inside the wall; the move handle moves it; each drag is one
 * undo step. Handles show only for the selected element, keep their size on
 * screen at any zoom, and a click on one still selects.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { readHostedFill } from '@ifc-lite/create';
import type { Mutation } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { commandPointerMove, getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { beginWallEndpointDrag } from '@/lib/commands/modeling/commands/wall-move-endpoint';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { sX, sY, type Fit } from '@/lib/space-sketch-geometry';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import { PLAN_CUT_DEBOUNCE_MS } from './usePlanCut';
import { PlanView } from './PlanView';

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const settle = () => wait(PLAN_CUT_DEBOUNCE_MS + 250);
const undoStack = () => useViewerStore.getState().undoStacks.get(MODEL_ID) ?? [];
const round = (v: number) => +v.toFixed(6);

let wallId = 0;
let restoreRemesh: () => void = () => {};

let FIT: Fit;

/**
 * The plan's screen frame, read back from where it drew the test wall's end
 * handles ([0,0] and [4,0]): whatever the cut framed, the drag lands where
 * the plan says those points are.
 */
function readFit(ui: Element): Fit {
  const at = (which: string) => {
    const c = ui.querySelector(`[data-plan-handle="wall-${which}"] circle`)!;
    return [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))];
  };
  const [x0, y0] = at('start');
  const [x1] = at('end');
  return { scale: (x1 - x0) / 4, offX: x0, offY: y0 };
}

function pointer(target: EventTarget, type: string, fit: Fit, p: Vec2, init: PointerEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new window.PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: sX(fit, p[0]), clientY: sY(fit, p[1]), button: 0, buttons: 1, pointerId: 1, ...init,
    }));
  });
}

/** A press on the plan at `from`, a drag through `to`, a release there: as a user drags a handle. The last solved point. */
function planDrag(svg: Element, from: Vec2, to: Vec2): SnapResult | null {
  const fit = FIT;
  pointer(svg, 'pointerdown', fit, from);
  pointer(svg, 'pointermove', fit, [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]);
  pointer(svg, 'pointermove', fit, to);
  const solved = getCommandRuntime().snap;
  pointer(svg, 'pointerup', fit, to, { buttons: 0 });
  return solved;
}

function select(expressId: number): void {
  const s = useViewerStore.getState();
  act(() => s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, expressId)));
}

/** What a mutation writes, without its identity (id, time). */
function effect(m: Mutation): unknown {
  const { id: _id, timestamp: _t, ...rest } = m as Mutation & { timestamp?: unknown };
  return rest;
}

async function mountPlan() {
  const ui = render(<PlanView layout="split" />);
  await settle();
  select(wallId);
  FIT = readFit(ui);
  act(() => useViewerStore.getState().setSelectedEntityId(null));
  return { ui, svg: ui.querySelector('[data-plan-canvas]')! };
}

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ snapEnabled: false, selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null });
  assert.ok(useViewerStore.getState().enterModelWorkspace());
  restoreRemesh = setRequestRemesh(() => {});
  const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in wall);
  wallId = wall.expressId;
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('plan wall end handles (#6232 B3)', () => {
  it('show only for the selected wall', async () => {
    const { ui } = await mountPlan();
    assert.equal(ui.querySelector('[data-plan-handle]'), null, 'nothing selected, no handles');
    select(wallId);
    assert.ok(ui.querySelector('[data-plan-handle="wall-start"]'));
    assert.ok(ui.querySelector('[data-plan-handle="wall-end"]'));
    act(() => useViewerStore.getState().setSelectedEntityId(null));
    assert.equal(ui.querySelector('[data-plan-handle]'), null, 'cleared with the selection');
  });

  it('a plan end drag writes the same mutation as the 3D end drag, one undo step each', async () => {
    const { svg } = await mountPlan();
    select(wallId);
    const before = undoStack().length;
    const solved = planDrag(svg, [4, 0], [6, 1]);
    assert.ok(solved?.render, 'the plan solved the cursor into render space');
    const plan = undoStack().slice(before);
    assert.ok(plan.length > 0, 'the plan drag wrote the wall');
    const ends = useViewerStore.getState().readWallEndpoints(MODEL_ID, wallId)!;
    assert.deepEqual(ends.end.map(round), [6, 1, 0], 'the end followed the plan cursor');
    assert.equal(getCommandRuntime().command, null, 'the command ended with the release');
    assert.equal(useViewerStore.getState().activeTool, 'select');
    const tags = new Set(plan.map((m) => useViewerStore.getState().mutationBatchTags.get(m.id)));
    assert.equal(tags.size, 1, 'one batch: one undo step');
    act(() => useViewerStore.getState().undo(MODEL_ID));
    assert.deepEqual(useViewerStore.getState().readWallEndpoints(MODEL_ID, wallId)!.end.map(round), [4, 0, 0], 'one undo restores it');
    assert.equal(undoStack().length, before);

    // The 3D handle: the same command, its cursor at the same render-space point.
    select(wallId);
    act(() => beginWallEndpointDrag('end'));
    act(() => commandPointerMove({ local: [6, 1], render: solved!.render, winner: null, guides: [], locked: false }));
    act(() => { window.dispatchEvent(new window.PointerEvent('pointerup')); });
    const viewport = undoStack().slice(before);
    assert.deepEqual(viewport.map(effect), plan.map(effect), 'identical mutations from the plan and from 3D');
  });

  it('keep their screen size at any zoom and are still grabbed there', async () => {
    const { ui, svg } = await mountPlan();
    select(wallId);
    const radius = () => ui.querySelector('[data-plan-handle="wall-end"] circle')!.getAttribute('r');
    const drawn = radius();
    const before = FIT.scale;
    for (let i = 0; i < 4; i++) {
      const wheel = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 });
      // happy-dom's WheelEvent drops the pointer position from its init.
      Object.defineProperties(wheel, { clientX: { value: 600 }, clientY: { value: 400 } });
      act(() => { svg.dispatchEvent(wheel); });
    }
    FIT = readFit(ui);
    assert.ok(FIT.scale > before * 1.2, 'the plan zoomed in');
    assert.equal(radius(), drawn, 'same radius on screen');
    planDrag(svg, [4, 0], [5, 0]);
    assert.deepEqual(useViewerStore.getState().readWallEndpoints(MODEL_ID, wallId)!.end.map(round), [5, 0, 0]);
  });

  it('a press on a handle without a drag writes nothing; a drag elsewhere pans, not edits', async () => {
    const { svg } = await mountPlan();
    select(wallId);
    const before = undoStack().length;
    const fit = FIT;
    pointer(svg, 'pointerdown', fit, [4, 0]);
    pointer(svg, 'pointerup', fit, [4, 0], { buttons: 0 });
    planDrag(svg, [2, 3], [3, 4]);
    assert.equal(undoStack().length, before);
    assert.deepEqual(useViewerStore.getState().readWallEndpoints(MODEL_ID, wallId)!.end.map(round), [4, 0, 0]);
  });
});

describe('plan slide handle (#6232 B3)', () => {
  let windowId = 0;
  beforeEach(() => {
    const placed = useViewerStore.getState().addHostedFill(MODEL_ID, wallId, { kind: 'window', params: { Offset: 2, Sill: 0.9, Width: 1, Height: 1.2 } });
    assert.ok(!('error' in placed), 'error' in placed ? placed.error : '');
    windowId = placed.expressId;
  });
  const offset = () => {
    const s = useViewerStore.getState();
    return readHostedFill(s.models.get(MODEL_ID)!.ifcDataStore!, windowId, s.mutationViews.get(MODEL_ID))!.offset;
  };

  it('slides the window along its wall to the cursor, one undo step', async () => {
    const { ui, svg } = await mountPlan();
    select(windowId);
    assert.ok(ui.querySelector('[data-plan-handle="slide"]'), 'the selected window shows its slide handle');
    assert.equal(ui.querySelector('[data-plan-handle="wall-end"]'), null, 'and no wall handles');
    const before = undoStack().length;
    // Grabbed at its centre on the wall axis, dragged off the axis: only the along-wall part counts.
    planDrag(svg, [2, 0], [1, 0.7]);
    assert.equal(round(offset()), 1);
    const added = undoStack().slice(before);
    assert.equal(new Set(added.map((m) => useViewerStore.getState().mutationBatchTags.get(m.id))).size, 1, 'one undo step');
    act(() => useViewerStore.getState().undo(MODEL_ID));
    assert.equal(round(offset()), 2, 'one undo puts it back');
  });

  it('is clamped inside the wall at both ends', async () => {
    const { svg } = await mountPlan();
    select(windowId);
    planDrag(svg, [2, 0], [9, 0]);
    assert.equal(round(offset()), 3.5, 'a 1 m window in a 4 m wall stops 0.5 m before the end');
    select(windowId);
    planDrag(svg, [3.5, 0], [-5, 0]);
    assert.equal(round(offset()), 0.5, 'and 0.5 m after the start');
  });
});

describe('plan move handle (#6232 B3)', () => {
  const ends = (id: number) => {
    const w = useViewerStore.getState().readWallEndpoints(MODEL_ID, id)!;
    return [w.start.map(round), w.end.map(round)];
  };

  it('moves the selected wall by its middle handle to the cursor, one undo step', async () => {
    const { ui, svg } = await mountPlan();
    select(wallId);
    assert.ok(ui.querySelector('[data-plan-handle="move"]'));
    const before = undoStack().length;
    planDrag(svg, [2, 0], [3, 2]);
    assert.deepEqual(ends(wallId), [[1, 2, 0], [5, 2, 0]]);
    const added = undoStack().slice(before);
    assert.equal(new Set(added.map((m) => useViewerStore.getState().mutationBatchTags.get(m.id))).size, 1, 'one undo step');
    act(() => useViewerStore.getState().undo(MODEL_ID));
    assert.deepEqual(ends(wallId), [[0, 0, 0], [4, 0, 0]]);
  });

  it('a turned element moves by the plan delta, not by its own axes', async () => {
    const turned = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [6, 0, 0], End: [6, 4, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in turned);
    const { svg } = await mountPlan();
    select(turned.expressId);
    planDrag(svg, [6, 2], [7, 2]);
    assert.deepEqual(ends(turned.expressId), [[7, 0, 0], [7, 4, 0]]);
  });
});
