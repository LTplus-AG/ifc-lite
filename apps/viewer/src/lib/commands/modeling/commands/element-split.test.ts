/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.split` (charter #6232, WP2; was the Split tool): a click on the
 * selected wall cuts it where the cursor projects onto its axis, a slab takes
 * two clicks, each cut is ONE undo step, the command follows the selection to
 * the new half, and the wall-split notices (#3023/#3074) survive the move.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
import { toGlobalIdFromModels } from '@/store/globalId';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { press } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import type { SnapResult } from '@/lib/snap/types';
import type { Vec3 } from '../types.js';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import type { SplitGesture } from './element-split.js';

const snapAt = (render: Vec3): SnapResult => ({ local: [0, 0], render, winner: null, guides: [], locked: false });
const gesture = () => getCommandRuntime().gesture as SplitGesture;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;

function select(expressId: number): void {
  const s = useViewerStore.getState();
  s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, expressId));
}

/** Render point of storey-local (x, y) on the target's own workplane. */
function onTarget(x: number, y: number): Vec3 {
  const plane = gesture().plane;
  assert.ok(plane, 'the target storey has a workplane');
  return plane.localToRender([x, y, 0]);
}

let successes: string[];
let infos: string[];
const original = { success: toast.success, info: toast.info };

beforeEach(async () => {
  await seedModelingSession();
  successes = [];
  infos = [];
  (toast as { success: (m: string) => void }).success = (m) => successes.push(m);
  (toast as { info: (m: string) => void }).info = (m) => infos.push(m);
});
afterEach(() => {
  useViewerStore.getState().exitModelWorkspace();
  Object.assign(toast, original);
});

describe('element.split (#6232 WP2)', () => {
  it('cuts the selected wall at the cursor, as one undo step, and follows the selection', () => {
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    select(wall.expressId);
    const before = undoDepth();

    useViewerStore.getState().startCommand('element.split');
    assert.equal(useViewerStore.getState().activeTool, 'command');
    assert.deepEqual(gesture().target, { modelId: MODEL_ID, expressId: wall.expressId });

    commandPointerMove(snapAt(onTarget(1.5, 0.3)));
    assert.ok(Math.abs((gesture().hover?.distance ?? 0) - 1.5) < 1e-6, 'the cursor projects onto the wall axis');
    commandPointerDown(snapAt(onTarget(1.5, 0.3)));

    assert.deepEqual(successes, ['Wall split — Ctrl+Z to undo']);
    const selectedId = useViewerStore.getState().selectedEntityId;
    assert.ok(selectedId !== null);
    const selected = resolveEntityRef(selectedId);
    assert.ok(selected.expressId !== wall.expressId, 'the right half is selected');
    assert.equal(gesture().target?.expressId, selected.expressId, 'the command re-targets the new selection');

    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one undo reverts the whole split');
  });

  it('cuts a slab with two clicks; Escape drops a latched anchor first', () => {
    const slab = useViewerStore.getState().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 4, Thickness: 0.2 });
    assert.ok('expressId' in slab);
    select(slab.expressId);
    const before = undoDepth();
    useViewerStore.getState().startCommand('element.split');
    assert.ok(gesture().footprint, 'a slab target carries its footprint');

    commandPointerDown(snapAt(onTarget(2, -1)));
    assert.deepEqual(gesture().anchor, [2, -1]);
    press(document.body, 'Escape');
    assert.equal(gesture().anchor, null, 'first Escape drops the anchor');
    assert.equal(useViewerStore.getState().activeTool, 'command');

    commandPointerDown(snapAt(onTarget(2, -1)));
    commandPointerDown(snapAt(onTarget(2, 5)));
    assert.deepEqual(successes, ['Slab split — Ctrl+Z to undo']);
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one undo reverts the slab split');
  });

  it('reports openings the split could not reassign (click path)', () => {
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    select(wall.expressId);
    useViewerStore.getState().startCommand('element.split');
    commandPointerMove(snapAt(onTarget(1, 0)));
    useViewerStore.setState({
      splitWallAtDistance: () => ({ ok: true, left: { expressId: 1, globalId: 1 }, right: { expressId: 2, globalId: 2 }, openings: { toLeft: 1, toRight: 0, skipped: 2 } }),
    });
    commandPointerDown(snapAt(onTarget(1, 0)));
    assert.deepEqual(successes, ['Wall split (1 opening reassigned) — Ctrl+Z to undo']);
    assert.ok(infos.some((m) => m.includes('2 openings could not be reassigned')), JSON.stringify(infos));
  });

  it('Escape with nothing latched leaves the command', () => {
    const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    select(wall.expressId);
    useViewerStore.getState().startCommand('element.split');
    commandPointerMove(snapAt(onTarget(1, 0)));
    press(document.body, 'Escape');
    assert.equal(useViewerStore.getState().activeTool, 'select');
    assert.equal(getCommandRuntime().command, null);
  });
});
