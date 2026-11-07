/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9097: while a grid is dragged out, the plan previews its axes and tags. It
 * must not draw the ghost mesh's footprint, one hull that fills the whole grid
 * and hides the drawing under it.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { commandPointerDown, commandPointerMove } from '@/lib/commands/modeling/runtime';
import { resetGridSettings } from '@/lib/commands/modeling/commands/grid-place-geometry';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import { sX, sY } from '@/lib/rooms/plate-geometry';
import type { SnapResult } from '@/lib/snap/types';
import { fitPlan } from './plan-fit';
import { PLAN_CUT_DEBOUNCE_MS } from './usePlanCut';
import { PlanView } from './PlanView';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false, modifiers: { shift: false, alt: false } });
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, PLAN_CUT_DEBOUNCE_MS + 250)));

beforeEach(async () => {
  await seedModelingSession({ roomGeometry: true });
  resetGridSettings();
  useViewerStore.setState({ snapEnabled: false });
  assert.ok(useViewerStore.getState().enterModelWorkspace());
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('the grid ghost in the plan (#9097)', () => {
  it('draws one tagged line per axis where the grid will go, and no filled footprint', async () => {
    const ui = render(<PlanView layout="split" />);
    await settle();
    act(() => useViewerStore.getState().startCommand('grid.place'));
    act(() => { commandPointerMove(at(0, 0)); commandPointerDown(at(0, 0)); commandPointerMove(at(12, 6)); });

    assert.equal(ui.querySelectorAll('[data-plan-layer="ghost"]').length, 0, 'no hull over the drawing');
    const layer = ui.querySelector('[data-plan-layer="grid-ghost"]');
    assert.ok(layer, 'the axes are drawn');
    const axes = [...layer.querySelectorAll('g')];
    assert.deepEqual(axes.map((axis) => axis.querySelector('text')?.textContent), ['1', '2', '3', 'A', 'B']);

    // The fit the plan uses: the fixture has no cut, and its storey frames one imported wall.
    const s = useViewerStore.getState();
    const walls = storeyWallAxes(s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID)!, STOREY);
    const fit = fitPlan([], [], walls, 1280, 800);
    const line = (i: number) => axes[i].querySelector('line')!;
    // U axis 2 is the line x = 6; V axis B is the line y = 6. Each overhangs the grid by 1 m.
    assert.equal(Number(line(1).getAttribute('x1')), sX(fit, 6));
    assert.equal(Number(line(1).getAttribute('x2')), sX(fit, 6));
    assert.equal(Number(line(1).getAttribute('y1')), sY(fit, -1));
    assert.equal(Number(line(1).getAttribute('y2')), sY(fit, 7));
    assert.equal(Number(line(4).getAttribute('y1')), sY(fit, 6));
    assert.equal(Number(line(4).getAttribute('x1')), sX(fit, -1));
    assert.equal(Number(line(4).getAttribute('x2')), sX(fit, 13));
  });

  it('other commands keep their ghost footprint', async () => {
    const ui = render(<PlanView layout="split" />);
    await settle();
    act(() => useViewerStore.getState().startCommand('slab.place'));
    act(() => { commandPointerMove(at(0, 0)); commandPointerDown(at(0, 0)); commandPointerMove(at(4, 4)); });
    assert.ok(ui.querySelector('[data-plan-layer="ghost"] path'));
  });
});
