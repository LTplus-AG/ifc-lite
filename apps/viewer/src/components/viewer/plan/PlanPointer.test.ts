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
import { commandPointerDown, getCommandRuntime, writeCommandField } from '@/lib/commands/modeling/runtime';
import { solveCommandSnap } from '@/lib/commands/modeling/snap-solve';
import type { Vec2 } from '@/lib/snap/types';
import { createPlanCutSource } from './plan-cut-source';
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
