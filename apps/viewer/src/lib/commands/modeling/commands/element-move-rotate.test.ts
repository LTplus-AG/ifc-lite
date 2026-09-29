/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.move` / `element.rotate` (#6232 C2): each commit is ONE undo step,
 * a multi-selection moves together, typed distance / direction / angle drive
 * the commit, the ring snaps to 15°, and a hosted window goes with its wall —
 * carried by its placement chain when it hangs from the wall, written with
 * the wall when it hangs from the storey — and is re-meshed either way.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addHostedWindowToStore, resolveHostAnchor } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, commitCommand, getCommandRuntime, writeCommandField } from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';

const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const near = (a: readonly number[], b: readonly number[], msg: string) =>
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-6), `${msg}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

/** A snapped cursor at session-workplane local (x, y). */
function at(x: number, y: number): SnapResult {
  const plane = getCommandRuntime().ctx?.workplane;
  assert.ok(plane, 'the session has a workplane');
  return { local: [x, y], render: plane.localToRender([x, y, 0]), winner: null, guides: [], locked: false };
}

function click(x: number, y: number): void {
  commandPointerMove(at(x, y));
  commandPointerDown(at(x, y));
}

function select(...ids: number[]): void {
  const s = useViewerStore.getState();
  // Both channels, as a click or Ctrl-clicks leave them (`viewport-selection.ts`).
  s.setSelectedEntityIds(ids.map((id) => toGlobalIdFromModels(s.models, MODEL_ID, id)));
}

function addWall(start: [number, number], end: [number, number]): number {
  const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, {
    Start: [start[0], start[1], 0], End: [end[0], end[1], 0], Thickness: 0.2, Height: 3,
  });
  assert.ok('expressId' in wall);
  return wall.expressId;
}

function addColumn(x: number, y: number): number {
  const column = useViewerStore.getState().addColumn(MODEL_ID, STOREY, { Position: [x, y, 0], Width: 0.3, Depth: 0.3, Height: 3 });
  assert.ok('expressId' in column);
  return column.expressId;
}

const wallStart = (id: number) => useViewerStore.getState().readWallEndpoints(MODEL_ID, id)!.start.slice(0, 2);
const position = (id: number) => useViewerStore.getState().readEntityPosition(MODEL_ID, id)!.slice(0, 2);
const yawDeg = (id: number) => (useViewerStore.getState().readEntityRotation(MODEL_ID, id)!.yawZ * 180) / Math.PI;

let remeshed: RemeshRequest[];
let restoreRemesh: () => void;

beforeEach(async () => {
  await seedModelingSession();
  remeshed = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshed.push(request); });
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
});

describe('element.move / element.rotate (#6232 C2)', () => {
  it('moves the selected wall base → target as one undo step, and ends', () => {
    const wall = addWall([0, 0], [4, 0]);
    select(wall);
    const before = undoDepth();
    useViewerStore.getState().startCommand('element.move');
    click(0, 0);
    click(1, 2);

    near(wallStart(wall), [1, 2], 'the wall moved by the picked vector');
    assert.equal(getCommandRuntime().command, null, 'the command ends after the move');
    assert.equal(useViewerStore.getState().selectedEntityId, toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, wall));
    assert.deepEqual(remeshed.map((r) => [...r.expressIds]), [[wall]], 'the moved wall is re-meshed through the transaction');

    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one undo step');
    near(wallStart(wall), [0, 0], 'undo puts it back');
  });

  it('moves a multi-selection together, in one undo step', () => {
    const wall = addWall([0, 0], [4, 0]);
    const column = addColumn(2, 3);
    select(wall, column);
    const before = undoDepth();
    useViewerStore.getState().startCommand('element.move');
    click(2, 3);
    click(5, 3);

    near(wallStart(wall), [3, 0], 'the wall moved');
    near(position(column), [5, 3], 'the column moved');
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one undo reverts both');
    near(wallStart(wall), [0, 0], 'wall back');
    near(position(column), [2, 3], 'column back');
  });

  it('commits a typed distance and direction with Enter', () => {
    const column = addColumn(1, 1);
    select(column);
    useViewerStore.getState().startCommand('element.move');
    click(1, 1);
    commandPointerMove(at(4, 4));
    writeCommandField(0, 2.5); // Distance
    writeCommandField(1, 90); // Direction: +y
    assert.ok(commitCommand());
    near(position(column), [1, 3.5], 'typed 2.5 m at 90°');
  });

  it('carries a hosted window placed on its wall, and writes one placed on the storey', () => {
    const wall = addWall([0, 0], [4, 0]);
    const s = useViewerStore.getState();
    const dataStore = s.models.get(MODEL_ID)!.ifcDataStore!;
    const view = s.mutationViews.get(MODEL_ID)!;
    const editor = s.storeEditors.get(MODEL_ID)!;
    const onWall = addHostedWindowToStore(editor, resolveHostAnchor(dataStore, wall, view), { Offset: 1, Sill: 0.9, Width: 1, Height: 1.2 });
    const onStorey = addHostedWindowToStore(editor, resolveHostAnchor(dataStore, wall, view), { Offset: 3, Sill: 0.9, Width: 1, Height: 1.2 });
    // Re-hang the second window from the storey, where the wall's frame put it
    // (some exporters place fillings so): now it must be written, not carried.
    const wallPlacement = String(view.getNewEntity(wall)!.attributes[5]);
    const storeyPlacement = view.getNewEntity(Number(wallPlacement.slice(1)))!.attributes[0];
    view.getNewEntity(onStorey.placementId)!.attributes[0] = storeyPlacement;
    const storeyBefore = position(onStorey.fillingId);
    const wallBefore = position(onWall.fillingId);

    select(wall);
    const before = undoDepth();
    useViewerStore.getState().startCommand('element.move');
    click(0, 0);
    click(0, 1.5);

    near(wallStart(wall), [0, 1.5], 'the wall moved');
    near(position(onWall.fillingId), wallBefore, 'the wall-hung window keeps its wall-relative placement (moved once, by its wall)');
    near(position(onStorey.fillingId), [storeyBefore[0], storeyBefore[1] + 1.5], 'the storey-hung window is written with the wall');
    const ids = new Set(remeshed.flatMap((r) => [...r.expressIds]));
    for (const id of [wall, onWall.fillingId, onWall.opening.openingId, onStorey.fillingId]) {
      assert.ok(ids.has(id), `#${id} is re-meshed with the move`);
    }
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one undo step');
    near(position(onStorey.fillingId), storeyBefore, 'undo puts the storey-hung window back');
  });

  it('turns a column by a typed angle about a picked pivot, as one undo step', () => {
    const column = addColumn(2, 1);
    select(column);
    const before = undoDepth();
    useViewerStore.getState().startCommand('element.rotate');
    click(0, 0); // no mesh, so no centre: the first click is the pivot
    writeCommandField(0, 90);
    assert.ok(commitCommand());

    near(position(column), [-1, 2], 'the column swung 90° about the pivot');
    assert.ok(Math.abs(yawDeg(column) - 90) < 1e-6, 'and turned 90°');
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one undo step');
    near(position(column), [2, 1], 'undo puts it back');
    assert.ok(Math.abs(yawDeg(column)) < 1e-6, 'unturned');
  });

  it('snaps the ring to 15° steps: a 32° sweep turns 30°', () => {
    const column = addColumn(0, 0);
    select(column);
    useViewerStore.getState().startCommand('element.rotate');
    click(0, 0); // pivot
    click(1, 0); // start ray along +x
    const r = (32 * Math.PI) / 180;
    commandPointerMove(at(Math.cos(r), Math.sin(r)));
    commandPointerDown(at(Math.cos(r), Math.sin(r)));
    assert.ok(Math.abs(yawDeg(column) - 30) < 1e-6, `turned ${yawDeg(column)}°`);
    near(position(column), [0, 0], 'turned in place about its own origin');
  });

  it('turns a multi-selection about one pivot', () => {
    const a = addColumn(1, 0);
    const b = addColumn(0, 2);
    select(a, b);
    useViewerStore.getState().startCommand('element.rotate');
    click(0, 0);
    writeCommandField(0, 180);
    assert.ok(commitCommand());
    near(position(a), [-1, 0], 'a swung');
    near(position(b), [0, -2], 'b swung');
  });
});
