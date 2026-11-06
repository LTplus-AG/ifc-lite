/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan's pointer on the ONE shared solver (charter #6232 M2.4,
 * `snap-solve.ts`): the plan's cut linework is a snap source only through
 * the plan's profile, Alt suspends snapping, a typed length holds the end on
 * its circle exactly as in 3D, and the solved point is lifted onto the
 * workplane in render space.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { commandPointerDown, commandPointerMove, getCommandRuntime, writeCommandField } from '@/lib/commands/modeling/runtime';
import { solveCommandSnap } from '@/lib/commands/modeling/snap-solve';
import { createIfcGridSource, type GridAxisLine } from '@/lib/snap/sources/ifc-grid';
import type { Vec2 } from '@/lib/snap/types';
import { createPlanCutSource, planCutLinework } from './plan-cut-source';
import { resolvePlanSnap, type PlanPointerInput } from './PlanPointer';

/** A cut outline corner at (2, 2): 10 px/m, so the 12 px radius is 1.2 m. */
const cut = createPlanCutSource(() => ({ segments: [[[2, 2], [6, 2]]], midpoints: true }));
const input = (local: Vec2, over: Partial<PlanPointerInput> = {}): PlanPointerInput => ({
  local, metresPerPixel: 0.1, mods: { shiftKey: false, altKey: false }, snapping: true, planSources: [cut], ...over,
});

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.getState().startCommand('wall.place');
});
afterEach(() => useViewerStore.getState().exitModelWorkspace());

describe('PlanPointer on the shared solver (#6232 M2.4)', () => {
  it('snaps to the plan cut, which the command profile alone does not consult', () => {
    const snap = resolvePlanSnap(input([2.3, 2.2]));
    assert.deepEqual(snap?.local, [2, 2]);
    assert.equal(snap?.winner?.kind, 'endpoint');

    const runtime = getCommandRuntime();
    const bare = solveCommandSnap(runtime, runtime.ctx!.workplane!, { cursor: [2.3, 2.2], metresPerPixel: 0.1, sources: [cut], mods: { shiftKey: false, altKey: false } });
    assert.deepEqual(bare?.local, [2.3, 2.2], 'the modelling profile has no plancut source');
  });

  it('Alt and the snap toggle both suspend snapping', () => {
    assert.deepEqual(resolvePlanSnap(input([2.3, 2.2], { mods: { shiftKey: false, altKey: true } }))?.local, [2.3, 2.2]);
    assert.deepEqual(resolvePlanSnap(input([2.3, 2.2], { snapping: false }))?.local, [2.3, 2.2]);
  });

  it('a typed length holds the end on its circle, and the result is on the workplane in render space', () => {
    commandPointerDown({ local: [0, 0], winner: null, guides: [], locked: false });
    writeCommandField(0, 3);
    const snap = resolvePlanSnap(input([0, 7], { snapping: false }))!;
    assert.ok(Math.abs(snap.local[0]) < 1e-9 && Math.abs(snap.local[1] - 3) < 1e-9, `${snap.local}`);
    // Against the EXPECTED point (0, 3), not the solved one: a wrong solve moves `render` too.
    const plane = getCommandRuntime().ctx!.workplane!;
    const expected = plane.localToRender([0, 3, 0]);
    snap.render!.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `render[${i}] ${v} vs ${expected[i]}`));
    // …and it is ON the workplane: back in local it has no height above it.
    assert.ok(Math.abs(plane.renderToLocal(snap.render!)[2]) < 1e-9);
  });

  it('does nothing without a running command', () => {
    useViewerStore.getState().endCommand('cancel');
    assert.equal(resolvePlanSnap(input([1, 1])), null);
  });
});

/**
 * #9026 item 23. Two real axes cross at (6, 6) under a 0.3 m column, whose cut
 * outline is what the plan offers as corners, midpoints and edges. A corner is
 * 0.21 m from the crossing and outranks it, inside the 12 px radius at any
 * zoom below about 57 px/m.
 */
describe('a column on a grid crossing (#9026 item 23)', () => {
  const AXES: GridAxisLine[] = [
    { gridId: 7, axisId: 71, AxisTag: '2', family: 'U', a: [6, -2], b: [6, 14] },
    { gridId: 7, axisId: 72, AxisTag: 'B', family: 'V', a: [-2, 6], b: [14, 6] },
  ];
  const grid = createIfcGridSource({ modelId: 'grid', version: () => 0, storeyId: () => 40, loadAxes: () => AXES });
  const column = createPlanCutSource(() => planCutLinework(
    [{ entityId: 1, ifcType: 'IfcColumn', outer: [[5.85, 5.85], [6.15, 5.85], [6.15, 6.15], [5.85, 6.15]], holes: [] }], [],
  ));
  const at = (local: Vec2, pxPerMetre: number) => input(local, { metresPerPixel: 1 / pxPerMetre, planSources: [grid, column] });

  for (const zoom of [100, 30, 12]) {
    it(`a click on the crossing lands on it at ${zoom} px/m, and names both axes`, () => {
      const snap = resolvePlanSnap(at([6, 6], zoom))!;
      assert.deepEqual(snap.local, [6, 6]);
      assert.equal(snap.winner?.kind, 'gridIntersection');
      assert.deepEqual(snap.winner?.gridIntersection?.IntersectingAxes, [71, 72]);
    });

    it(`at ${zoom} px/m the crossing wins even after the pointer came past a corner`, () => {
      const past = resolvePlanSnap(at([6.15, 6.15], zoom))!;
      assert.deepEqual(past.local, [6.15, 6.15], 'on the way in, the corner holds');
      commandPointerMove(past);
      assert.deepEqual(resolvePlanSnap(at([6, 6], zoom))!.local, [6, 6]);
    });
  }

  it('a pointer on the column corner still lands on the corner', () => {
    const snap = resolvePlanSnap(at([6.14, 6.15], 30))!;
    assert.deepEqual(snap.local, [6.15, 6.15]);
    assert.equal(snap.winner?.kind, 'endpoint');
  });

  it('a pointer a few pixels off the crossing still ranks the corner first', () => {
    const snap = resolvePlanSnap(at([6.05, 6.05], 30))!;
    assert.deepEqual(snap.local, [6.15, 6.15]);
  });
});
