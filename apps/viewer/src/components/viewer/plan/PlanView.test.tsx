/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's plan (charter #6232 M2.4), mounted: a wall drawn in
 * the plan lands at the plan's local coordinates as one undo step, the plan
 * cut draws it, a plan click selects it on BOTH selection channels, a 3D
 * selection highlights it in the plan, Shift toggles, an empty click clears.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, click, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import '@/lib/commands/modeling/builtin';
import { sX, sY, type Fit } from '@/lib/rooms/plate-geometry';
import type { Vec2 } from '@/lib/snap/types';
import { fitPlan, screenToLocal } from './plan-fit';
import { PLAN_CUT_DEBOUNCE_MS } from './usePlanCut';
import { Drawing2DGenerator } from '@ifc-lite/drawing-2d';
import { PlanView } from './PlanView';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import { ensureRoomWasm, setWallMeshes, BOX } from '@/test/room-walls-fixture';
import { getCommandRuntime, updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { RoomPlaceGesture } from '@/lib/commands/modeling/commands/room-place-gesture';
import { ModelWorkspaceSplit } from '../model/ModelWorkspaceSplit';
import { ModelToolRail } from '../model/ModelToolRail';

/**
 * The frame the plan fits itself to on entry: `installLayout` reports every
 * element as 1280×800 at the origin, the fixture has no meshes (no cut), and
 * its storey carries one imported wall (#130), whose axis is framed.
 */
function entryFit(): Fit {
  const s = useViewerStore.getState();
  const axes = storeyWallAxes(s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID)!, STOREY);
  return fitPlan([], [], axes, 1280, 800);
}
let FIT: Fit;

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
/** Long enough for the debounced cut and its async generation. */
const settle = () => wait(PLAN_CUT_DEBOUNCE_MS + 250);

function pointer(target: Element, type: string, x: number, y: number, init: PointerEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, ...init }));
  });
}

/** A click as the plan receives it: down then up without moving. */
function planClick(svg: Element, p: Vec2, init: PointerEventInit = {}): void {
  const [x, y] = [sX(FIT, p[0]), sY(FIT, p[1])];
  pointer(svg, 'pointerdown', x, y, init);
  pointer(svg, 'pointerup', x, y, init);
}

function walls(): { id: number; start: Vec2; end: Vec2 }[] {
  const s = useViewerStore.getState();
  const view = s.mutationViews.get(MODEL_ID)!;
  return view.getNewEntities()
    .filter((e) => e.type.toUpperCase() === 'IFCWALL' && !view.isDeleted(e.expressId))
    .map((e) => {
      const w = s.readWallEndpoints(MODEL_ID, e.expressId)!;
      return { id: e.expressId, start: [w.start[0], w.start[1]], end: [w.end[0], w.end[1]] };
    });
}

const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

beforeEach(async () => {
  await seedModelingSession({ roomGeometry: true });
  useViewerStore.setState({ snapEnabled: false, selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null });
  assert.ok(useViewerStore.getState().enterModelWorkspace());
  FIT = entryFit();
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('PlanView (#6232 M2.4)', () => {
  it('a wall drawn in the plan lands at the plan coordinates, one undo step, and is cut into the plan', async () => {
    const ui = render(<PlanView layout="split" />);
    await settle();
    const svg = ui.querySelector('[data-plan-canvas]')!;
    act(() => useViewerStore.getState().startCommand('wall.place'));
    const before = undoDepth();
    const a: Vec2 = [-2, 1], b: Vec2 = [3, 1];
    planClick(svg, a);
    assert.equal(walls().length, 0, 'the first click only anchors');
    assert.ok(ui.querySelector('[data-plan-command="wall.place"]'), 'the command draws its plan layer');
    planClick(svg, b);

    const [wall] = walls();
    assert.ok(wall, 'the second click placed a wall');
    assert.ok(near(wall.start, screenToLocal(FIT, sX(FIT, a[0]), sY(FIT, a[1]))), `start ${wall.start}`);
    assert.ok(near(wall.start, a) && near(wall.end, b), `wall ${wall.start} → ${wall.end}`);
    assert.equal(undoDepth(), before + 1, 'one undo step');

    await settle();
    assert.ok(ui.querySelector(`[data-plan-axis="${wall.id}"]`), 'the wall axis is drawn');
    const global = toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, wall.id);
    assert.ok(ui.querySelector(`[data-plan-entity="${global}"]`), 'the plan cut draws the new wall');
  });

  it('a double-click in the plan closes a polygon slab, like a 3D double-click (#6396 doubleClick)', async () => {
    const ui = render(<PlanView layout="split" />);
    await settle();
    const svg = ui.querySelector('[data-plan-canvas]')!;
    act(() => useViewerStore.getState().setAuthoringDefaults({ slabMode: 'polygon' }));
    act(() => useViewerStore.getState().startCommand('slab.place'));
    const before = undoDepth();
    planClick(svg, [0, 0]);
    planClick(svg, [3, 0]);
    planClick(svg, [3, 2]);
    assert.equal(undoDepth(), before, 'three vertices, nothing committed yet');
    planClick(svg, [3, 2]); // the second press of a double-click on the last vertex
    assert.equal(undoDepth(), before + 1, 'the double-click committed the slab as one undo step');
  });

  it('a cut that throws says "Cut failed" instead of reading as an empty storey, and Retry re-runs it (#6394 review)', async () => {
    const real = Drawing2DGenerator.prototype.generate;
    let fail = true;
    Drawing2DGenerator.prototype.generate = function (...args: Parameters<typeof real>) {
      if (fail) return Promise.reject(new Error('cutter exploded'));
      return real.apply(this, args);
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const ui = render(<PlanView layout="split" />);
      await settle();
      const svg = ui.querySelector('[data-plan-canvas]')!;
      act(() => useViewerStore.getState().startCommand('wall.place'));
      planClick(svg, [-2, 1]);
      planClick(svg, [3, 1]);
      await settle();
      const status = ui.querySelector('[data-plan-status="failed"]');
      assert.ok(status, 'the failure is shown');
      assert.equal(ui.querySelectorAll('[data-plan-entity]').length, 0);

      fail = false;
      act(() => (status!.querySelector('button') as HTMLButtonElement).click());
      await settle();
      assert.equal(ui.querySelector('[data-plan-status="failed"]'), null, 'retry cleared it');
      assert.ok(ui.querySelectorAll('[data-plan-entity]').length > 0, 'and the cut is drawn');
    } finally {
      Drawing2DGenerator.prototype.generate = real;
      console.warn = warn;
    }
  });

  it('a press released outside the plan never turns hover into a pan (#6394 review)', async () => {
    const ui = render(<PlanView layout="split" />);
    await settle();
    const svg = ui.querySelector('[data-plan-canvas]')!;
    const gridX = () => ui.querySelector('[data-plan-layer="grid"] line')?.getAttribute('x1');
    const before = gridX();
    pointer(svg, 'pointerdown', 100, 100, { buttons: 1 });
    // The button came up outside the plan: no pointerup here, the next move has no button held.
    pointer(svg, 'pointermove', 400, 300, { buttons: 0 });
    pointer(svg, 'pointermove', 500, 350, { buttons: 0 });
    assert.equal(gridX(), before, 'the plan did not move');
  });

  it('selection syncs both ways: plan click → both channels, 3D selection → plan highlight', async () => {
    const ui = render(<PlanView layout="split" />);
    await settle();
    const svg = ui.querySelector('[data-plan-canvas]')!;
    act(() => useViewerStore.getState().startCommand('wall.place'));
    planClick(svg, [-2, 1]);
    planClick(svg, [3, 1]);
    act(() => useViewerStore.getState().endCommand('cancel'));
    await settle();
    const [wall] = walls();
    const global = toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, wall.id);

    planClick(svg, [0.5, 1]);
    let s = useViewerStore.getState();
    assert.equal(s.selectedEntityId, global, 'the renderer channel');
    assert.deepEqual(s.selectedEntity, { modelId: MODEL_ID, expressId: wall.id }, 'the property channel');
    assert.ok(ui.querySelector(`[data-plan-selected="${global}"]`), 'highlighted in the plan');

    planClick(svg, [0.5, -3]);
    s = useViewerStore.getState();
    assert.equal(s.selectedEntityId, null, 'an empty click clears');
    assert.equal(ui.querySelector('[data-plan-selected]'), null);

    act(() => useViewerStore.getState().setSelectedEntityId(global));
    assert.ok(ui.querySelector(`[data-plan-selected="${global}"]`), 'a 3D selection highlights in the plan');

    planClick(svg, [0.5, 1], { shiftKey: true });
    assert.equal(useViewerStore.getState().selectedEntityIds.has(global), false, 'Shift toggles it off');
  });
});

describe('PlanView: a grabbed room corner (#6232 A4b review)', () => {
  async function grab(t: import('node:test').TestContext) {
    if (!ensureRoomWasm(t)) return null;
    await ensureSpaceWasm();
    setWallMeshes([...BOX, [[4, 0], [4, 5]]]);
    useViewerStore.getState().startCommand('room.place');
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), mode: 'edit' })); });
    const ui = render(<PlanView layout="split" />);
    await settle();
    const svg = ui.querySelector('[data-plan-canvas]')! as SVGSVGElement;
    const [x, y] = [sX(FIT, 4), sY(FIT, 0)];
    pointer(svg, 'pointermove', x, y);
    pointer(svg, 'pointerdown', x, y, { buttons: 1 });
    const drag = () => (getCommandRuntime().gesture as RoomPlaceGesture).edit.drag;
    return { svg, drag, x, y };
  }

  it('the press captures the pointer, so a release outside the plan still reaches the command', async (t) => {
    let captured = 0;
    const proto = window.SVGElement.prototype as unknown as { setPointerCapture?: (id: number) => void };
    const original = proto.setPointerCapture;
    proto.setPointerCapture = () => { captured++; };
    try {
      const g = await grab(t);
      if (!g) return;
      assert.ok(g.drag(), 'the corner is grabbed');
      assert.equal(captured, 1, 'the command press captured the pointer');
    } finally {
      proto.setPointerCapture = original;
    }
  });

  it('a cancelled press drops the grabbed corner instead of leaving it grabbed', async (t) => {
    const g = await grab(t);
    if (!g) return;
    assert.ok(g.drag(), 'the corner is grabbed');
    pointer(g.svg, 'pointercancel', g.x, g.y);
    assert.equal(g.drag(), null, 'the grab is dropped');
  });

  it('a move with no button held after a lost release drops the grab instead of following the cursor', async (t) => {
    const g = await grab(t);
    if (!g) return;
    pointer(g.svg, 'pointermove', g.x + 40, g.y, { buttons: 1 });
    assert.ok(g.drag(), 'still grabbed while the button is down');
    pointer(g.svg, 'pointermove', g.x + 80, g.y, { buttons: 0 });
    assert.equal(g.drag(), null, 'the lost release ended the grab');
  });

  it('a release ends the press without cancelling it: a corner grabbed by a click stays grabbed', async (t) => {
    const g = await grab(t);
    if (!g) return;
    pointer(g.svg, 'pointerup', g.x, g.y);
    pointer(g.svg, 'lostpointercapture', g.x, g.y);
    assert.ok(g.drag(), 'click, move, click: the corner waits for its second click');
  });
});

describe('ModelWorkspaceSplit layouts (#6232 M2.4)', () => {
  it('Plan | Split | 3D switch from the plan header, the rail toggle brings the plan back, the 3D view never remounts', () => {
    act(() => useViewerStore.getState().setModelLayout('split'));
    const ui = render(<><ModelToolRail /><ModelWorkspaceSplit><div data-probe-3d /></ModelWorkspaceSplit></>);
    const probe = ui.querySelector('[data-probe-3d]');
    assert.ok(ui.querySelector('[data-plan-view]'), 'split shows the plan');
    const radio = (name: string) => [...ui.querySelectorAll('[role="radio"]')].find((b) => b.textContent === name)!;

    click(radio('3D'));
    assert.equal(useViewerStore.getState().modelLayout, '3d');
    assert.equal(ui.querySelector('[data-plan-view]'), null, '3D alone');
    click(ui.querySelector('[data-rail-tool="plan"]')!);
    assert.equal(useViewerStore.getState().modelLayout, 'split', 'the rail toggle restores the split');
    click(radio('Plan'));
    assert.equal(useViewerStore.getState().modelLayout, 'plan');
    assert.ok(ui.querySelector('[data-plan-view]'));
    assert.equal(ui.querySelector('[data-probe-3d]'), probe, 'the 3D view kept its node through every switch');
  });
});
