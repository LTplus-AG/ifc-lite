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
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { sX, sY, type Fit } from '@/lib/space-sketch-geometry';
import type { Vec2 } from '@/lib/snap/types';
import { fitPlan, screenToLocal } from './plan-fit';
import { PLAN_CUT_DEBOUNCE_MS } from './usePlanCut';
import { PlanView } from './PlanView';
import { ModelWorkspaceSplit } from '../model/ModelWorkspaceSplit';

/** `installLayout` reports every element as 1280×800 at the origin. */
const EMPTY_FIT: Fit = fitPlan([], [], [], 1280, 800);

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
  const [x, y] = [sX(EMPTY_FIT, p[0]), sY(EMPTY_FIT, p[1])];
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
  await seedModelingSession();
  useViewerStore.setState({ snapEnabled: false, selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null });
  assert.ok(useViewerStore.getState().enterModelWorkspace());
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('PlanView (#6232 M2.4)', () => {
  it('a wall drawn in the plan lands at the plan coordinates, one undo step, and is cut into the plan', async () => {
    const ui = render(<PlanView />);
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
    assert.ok(near(wall.start, screenToLocal(EMPTY_FIT, sX(EMPTY_FIT, a[0]), sY(EMPTY_FIT, a[1]))), `start ${wall.start}`);
    assert.ok(near(wall.start, a) && near(wall.end, b), `wall ${wall.start} → ${wall.end}`);
    assert.equal(undoDepth(), before + 1, 'one undo step');

    await settle();
    assert.ok(ui.querySelector(`[data-plan-axis="${wall.id}"]`), 'the wall axis is drawn');
    const global = toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, wall.id);
    assert.ok(ui.querySelector(`[data-plan-entity="${global}"]`), 'the plan cut draws the new wall');
  });

  it('selection syncs both ways: plan click → both channels, 3D selection → plan highlight', async () => {
    const ui = render(<PlanView />);
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

describe('ModelWorkspaceSplit layouts (#6232 M2.4)', () => {
  it('Plan | Split | 3D switch from the plan header, the strip brings the plan back, the 3D view never remounts', () => {
    act(() => useViewerStore.getState().setModelLayout('split'));
    const ui = render(<ModelWorkspaceSplit><div data-probe-3d /></ModelWorkspaceSplit>);
    const probe = ui.querySelector('[data-probe-3d]');
    assert.ok(ui.querySelector('[data-plan-view]'), 'split shows the plan');
    const radio = (name: string) => [...ui.querySelectorAll('[role="radio"]')].find((b) => b.textContent === name)!;

    click(radio('3D'));
    assert.equal(useViewerStore.getState().modelLayout, '3d');
    assert.equal(ui.querySelector('[data-plan-view]'), null, '3D alone');
    click(ui.querySelector('[data-model-show-plan]')!);
    assert.equal(useViewerStore.getState().modelLayout, 'split', 'the strip restores the split');
    click(radio('Plan'));
    assert.equal(useViewerStore.getState().modelLayout, 'plan');
    assert.ok(ui.querySelector('[data-plan-view]'));
    assert.equal(ui.querySelector('[data-probe-3d]'), probe, 'the 3D view kept its node through every switch');
  });
});
