/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A plan click gives the Model inspector (M2.5, `useInspectorTarget`) a
 * selection target (#6232 M2.4 review: the plan's selection must reach the
 * inspector). The plan writes the same selection channels as a 3D click.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import '@/lib/commands/modeling/builtin';
import { sX, sY } from '@/lib/rooms/plate-geometry';
import type { Vec2 } from '@/lib/snap/types';
import { fitPlan } from './plan-fit';
import { PLAN_CUT_DEBOUNCE_MS } from './usePlanCut';
import { PlanView } from './PlanView';
import { useInspectorTarget, type InspectorTarget } from '../model-inspector/useInspectorTarget';

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, PLAN_CUT_DEBOUNCE_MS + 250)));
/** The plan's entry frame: 1280×800 (installLayout), no cut yet, the fixture storey's wall axes. */
function entryFit() {
  const s = useViewerStore.getState();
  return fitPlan([], [], storeyWallAxes(s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID)!, STOREY), 1280, 800);
}
function click(svg: Element, p: Vec2, fit = entryFit()) {
  const [x, y] = [sX(fit, p[0]), sY(fit, p[1])];
  for (const type of ['pointerdown', 'pointerup']) act(() => { svg.dispatchEvent(new window.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 })); });
}

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ snapEnabled: false });
  useViewerStore.getState().enterModelWorkspace();
});
afterEach(() => { useViewerStore.getState().exitModelWorkspace(); cleanup(); });

it('a plan click gives the inspector a selection target', async () => {
  const fit = entryFit();
  // Written by the probe on every render (an object, so TypeScript keeps the type across the closure).
  const seen: { target: InspectorTarget | null } = { target: null };
  function Probe() { seen.target = useInspectorTarget(); return null; }
  // Read through a call: an assert on one read must not narrow the next one.
  const target = (): InspectorTarget => seen.target!;
  const ui = render(<><PlanView layout="split" /><Probe /></>);
  await settle();
  const svg = ui.querySelector('[data-plan-canvas]')!;
  act(() => useViewerStore.getState().startCommand('wall.place'));
  click(svg, [-2, 1], fit); click(svg, [3, 1], fit);
  act(() => useViewerStore.getState().endCommand('cancel'));
  act(() => useViewerStore.getState().setSelectedEntityId(null));
  await settle();
  assert.equal(target().selection, null);
  click(svg, [0.5, 1], fit);
  const wall = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities().find((e) => e.type.toUpperCase() === 'IFCWALL')!;
  assert.equal(target().selection?.expressId, wall.expressId);
  assert.equal(target().mode, 'selection');
});
