/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Copy, paste and array in the Model workspace (#6232 C3): every paste and
 * every array is ONE undo step and one re-mesh request (#6391) of what it
 * created; copies get fresh GlobalIds; a wall is copied with the window in
 * it, its opening and the void and fill relationships (decision D7).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { addHostedWindowToStore, resolveHostAnchor } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { cleanup, press, render } from '@/test/render.js';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { selectPickedGlobalId } from '@/components/viewer/viewport-selection';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { clearCopyClipboard, readCopyClipboard } from '../copy-clipboard.js';
import { commandPointerDown, commandPointerMove, commitCommand, getCommandRuntime, updateCommandGesture } from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import type { ArrayGesture } from './element-array.js';
import { ArrayBar } from '@/components/viewer/tools/command/ArrayBar';
import { buildStoreyWorkplane, isWorkplane } from '../workplane.js';

function Keys() { useKeyboardShortcuts(); return null; }

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const round = (v: number) => +v.toFixed(6) || 0;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const view = () => useViewerStore.getState().mutationViews.get(MODEL_ID)!;
const live = (type: string) => view().getNewEntities().filter((e) => e.type.toUpperCase() === type && !view().isDeleted(e.expressId));
/** A plain click on the element. */
const select = (expressId: number) => act(() => {
  selectPickedGlobalId(toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, expressId));
});
const ctrl = (key: string, shiftKey = false) => press(document.body, key, { ctrlKey: true, shiftKey });

/** Every live column's storey-local base point, sorted. */
function columns(): number[][] {
  const s = useViewerStore.getState();
  return live('IFCCOLUMN').map((e) => s.readEntityPosition(MODEL_ID, e.expressId)!.map(round))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function addColumn(x: number, y: number): number {
  const s = useViewerStore.getState();
  const column = s.addColumn(MODEL_ID, STOREY, { Position: [x, y, 0], Width: 0.3, Depth: 0.3, Height: 2.5 });
  assert.ok('expressId' in column);
  return column.expressId;
}

let remeshes: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  clearCopyClipboard();
  remeshes = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshes.push(request); });
  render(<Keys />);
  useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('element.array (#6232 C3)', () => {
  it('a linear array of 5 columns: two clicks give the spacing, one undo takes it back', () => {
    const column = addColumn(1, 1);
    select(column);
    const before = undoDepth();
    press(document.body, 'A', { shiftKey: true });
    assert.equal(getCommandRuntime().command?.id, 'element.array');
    click(1, 1);
    click(3, 1);
    assert.deepEqual(columns(), [[1, 1, 0], [3, 1, 0], [5, 1, 0], [7, 1, 0], [9, 1, 0]]);
    assert.equal(undoDepth() - before > 0, true);

    // One re-mesh request for the whole array, of the four copies.
    assert.equal(remeshes.length, 1);
    assert.equal(remeshes[0].cause, 'created');
    assert.equal(remeshes[0].expressIds.length, 4);
    // The copies are selected.
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 4);

    // Fresh GlobalIds (D7).
    const guids = live('IFCCOLUMN').map((e) => e.attributes[0]);
    assert.equal(new Set(guids).size, 5);

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(columns(), [[1, 1, 0]], 'one undo takes the whole array back');
    assert.equal(undoDepth(), before);
    useViewerStore.getState().redo(MODEL_ID);
    assert.equal(columns().length, 5, 'and one redo brings it back');
  });

  it('Fit spreads the count over the clicked distance; a typed Count and Spacing win', () => {
    select(addColumn(0, 0));
    useViewerStore.getState().startCommand('element.array');
    act(() => updateCommandGesture((g) => ({ ...(g as ArrayGesture), fit: true, count: 3 })));
    click(0, 0);
    click(0, 8);
    assert.deepEqual(columns(), [[0, 0, 0], [0, 4, 0], [0, 8, 0]]);

    select(live('IFCCOLUMN')[0].expressId);
    useViewerStore.getState().startCommand('element.array');
    act(() => updateCommandGesture((g) => ({ ...(g as ArrayGesture), count: 2, distance: 1.5 })));
    click(0, 0);
    click(10, 0);
    assert.ok(columns().some(([x, y]) => x === 1.5 && y === 0), 'typed spacing 1.5 m along the clicked direction');
  });

  it('switching Spacing to Fit drops a typed spacing: it would read as the total (review)', () => {
    select(addColumn(0, 0));
    useViewerStore.getState().startCommand('element.array');
    const ui = render(<ArrayBar gesture={getCommandRuntime().gesture as ArrayGesture} ctx={getCommandRuntime().ctx!} />);
    act(() => updateCommandGesture((g) => ({ ...(g as ArrayGesture), distance: 2 })));
    act(() => { ([...ui.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Fit') as HTMLButtonElement).click(); });
    const g = getCommandRuntime().gesture as ArrayGesture;
    assert.equal(g.fit, true);
    assert.equal(g.distance, null);
  });

  it('a polar array turns the copies about the centre, one undo step', () => {
    const column = addColumn(2, 0);
    select(column);
    const before = undoDepth();
    useViewerStore.getState().startCommand('element.array');
    act(() => updateCommandGesture((g) => ({ ...(g as ArrayGesture), mode: 'polar', count: 4, angle: 360 })));
    click(0, 0);
    act(() => { commitCommand(); });
    assert.deepEqual(columns(), [[-2, 0, 0], [0, -2, 0], [0, 2, 0], [2, 0, 0]]);
    // Each copy is turned with the array: a quarter turn per step.
    const s = useViewerStore.getState();
    const yaws = live('IFCCOLUMN').map((e) => round(((s.readEntityRotation(MODEL_ID, e.expressId)!.yawZ * 180) / Math.PI + 360) % 360)).sort((a, b) => a - b);
    assert.deepEqual(yaws, [0, 90, 180, 270]);
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(columns(), [[2, 0, 0]]);
    assert.equal(undoDepth(), before);
  });

  it('nothing selected: a click places nothing', () => {
    act(() => { selectPickedGlobalId(null); });
    useViewerStore.getState().startCommand('element.array');
    click(0, 0);
    assert.equal((getCommandRuntime().gesture as ArrayGesture).anchor, null);
    assert.deepEqual(columns(), []);
  });
});

describe('array preview (#6232 C3)', () => {
  it("shows the element's own mesh at every copy, where the commit puts it", () => {
    const column = addColumn(1, 1);
    const s = useViewerStore.getState();
    const plane = buildStoreyWorkplane(s, MODEL_ID, STOREY, 0);
    assert.ok(isWorkplane(plane));
    const corner = plane.localToRender([1, 1, 0]);
    // A re-meshed element comes in its own local frame: world = origin + positions (#6391).
    const mesh = {
      expressId: toGlobalIdFromModels(s.models, MODEL_ID, column), origin: [corner[0] - 0.5, corner[1], corner[2]] as [number, number, number],
      positions: new Float32Array([0.5, 0, 0]), normals: new Float32Array([0, 1, 0]), indices: new Uint32Array([0, 0, 0]), color: [1, 1, 1, 1] as [number, number, number, number],
    };
    act(() => useViewerStore.setState({ geometryResult: { ...s.geometryResult!, meshes: [mesh] }, models: new Map([[MODEL_ID, { ...s.models.get(MODEL_ID)!, geometryResult: { ...s.geometryResult!, meshes: [mesh] } }]]) }));
    select(column);
    useViewerStore.getState().startCommand('element.array');
    act(() => updateCommandGesture((g) => ({ ...(g as ArrayGesture), count: 3 })));
    click(1, 1);
    act(() => { commandPointerMove(at(1, 3)); });
    const runtime = getCommandRuntime();
    const ghosts = runtime.command!.ghost!(runtime.gesture, runtime.ctx!);
    assert.equal(ghosts.length, 2, 'one ghost per copy');
    for (const [i, ghost] of ghosts.entries()) {
      const expected = plane.localToRender([1, 1 + 2 * (i + 1), 0]);
      const world = [0, 1, 2].map((k) => ghost.origin![k] + ghost.positions[k]);
      assert.deepEqual(world.map((v) => +v.toFixed(4)), expected.map((v) => +v.toFixed(4)));
    }
  });
});

describe('copy and paste (#6232 C3)', () => {
  /** A wall on the ground storey with a window in it (its opening, void and fill). */
  function wallWithWindow(): { wall: number; window: number } {
    const s = useViewerStore.getState();
    const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2.5 });
    assert.ok('expressId' in wall);
    const target = modelEditTarget(useViewerStore.getState(), MODEL_ID)!;
    const built = addHostedWindowToStore(target.editor, resolveHostAnchor(target.dataStore, wall.expressId, target.view), {
      Offset: 2, Sill: 0.9, Width: 1.2, Height: 1.2,
    });
    return { wall: wall.expressId, window: built.fillingId };
  }

  it('copies a wall with its window to the upper storey: Ctrl+C, PageUp, Ctrl+Shift+V; one undo', () => {
    const { wall, window } = wallWithWindow();
    select(wall);
    ctrl('c');
    assert.deepEqual(readCopyClipboard()?.ids, [wall]);
    const before = undoDepth();
    const overlayBefore = view().getNewEntities().length;
    press(document.body, 'PageUp');
    assert.equal(useViewerStore.getState().session?.storeyId, UPPER_STOREY);
    ctrl('V', true);

    const walls = live('IFCWALL');
    assert.equal(walls.length, 2);
    const copy = walls.find((e) => e.expressId !== wall)!;
    const windows = live('IFCWINDOW');
    assert.equal(windows.length, 2);
    const windowCopy = windows.find((e) => e.expressId !== window)!;
    const openings = live('IFCOPENINGELEMENT');
    assert.equal(openings.length, 2);
    const openingCopy = openings.find((o) => live('IFCRELVOIDSELEMENT').some((r) => r.attributes[4] === `#${copy.expressId}` && r.attributes[5] === `#${o.expressId}`));
    assert.ok(openingCopy, 'a new IfcRelVoidsElement cuts a new opening into the copy');
    assert.ok(live('IFCRELFILLSELEMENT').some((r) => r.attributes[4] === `#${openingCopy!.expressId}` && r.attributes[5] === `#${windowCopy.expressId}`),
      'a new IfcRelFillsElement puts the window copy in it');
    // On the upper storey: contained there, the window too.
    const containedIn = (id: number) => live('IFCRELCONTAINEDINSPATIALSTRUCTURE').find((r) => (r.attributes[4] as string[]).includes(`#${id}`))?.attributes[5];
    assert.equal(containedIn(copy.expressId), `#${UPPER_STOREY}`);
    assert.equal(containedIn(windowCopy.expressId), `#${UPPER_STOREY}`);
    // Fresh GlobalIds.
    assert.notEqual(copy.attributes[0], walls.find((e) => e.expressId === wall)!.attributes[0]);
    assert.notEqual(windowCopy.attributes[0], windows.find((e) => e.expressId === window)!.attributes[0]);
    // One re-mesh of the wall copy and its window.
    assert.deepEqual([...remeshes.at(-1)!.expressIds].sort(), [copy.expressId, windowCopy.expressId].sort());
    assert.equal(useViewerStore.getState().selectedEntityId, toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, copy.expressId));

    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one undo step');
    assert.equal(live('IFCWALL').length, 1);
    assert.equal(live('IFCWINDOW').length, 1);
    assert.equal(live('IFCOPENINGELEMENT').length, 1);
    assert.equal(view().getNewEntities().filter((e) => !view().isDeleted(e.expressId)).length, overlayBefore, 'every record of the paste is gone');
  });

  it('Ctrl+V pastes at the clicked point, gripped at the copied element\'s placement', () => {
    select(addColumn(1, 1));
    ctrl('c');
    ctrl('v');
    assert.equal(getCommandRuntime().command?.id, 'element.paste');
    click(4, 6);
    assert.deepEqual(columns(), [[1, 1, 0], [4, 6, 0]]);
    assert.equal(getCommandRuntime().command, null, 'a paste ends the command');
  });

  it('a window alone is refused: it is copied with its wall', () => {
    const { window } = wallWithWindow();
    select(window);
    ctrl('c');
    assert.equal(readCopyClipboard(), null);
  });

  it('an assembly is copied with its parts and their aggregation, and a part alone is refused (C3 follow-up); one undo', () => {
    const state = useViewerStore.getState();
    const { editor } = modelEditTarget(state, MODEL_ID)!;
    const point = editor.addEntity('IfcCartesianPoint', [[1, 1, 0]]);
    const axis = editor.addEntity('IfcAxis2Placement3D', [`#${point.expressId}`, null, null]);
    const placement = editor.addEntity('IfcLocalPlacement', ['#41', `#${axis.expressId}`]);
    const assembly = editor.addEntity('IfcElementAssembly', ['0$abcdefghijklmnopqrstu', null, 'Assembly', null, null, `#${placement.expressId}`, null, null, null, null]);
    editor.addEntity('IfcRelContainedInSpatialStructure', ['1$abcdefghijklmnopqrstu', null, null, null, [`#${assembly.expressId}`], `#${STOREY}`]);
    const parts = [addColumn(1, 1), addColumn(2, 1)];
    editor.addEntity('IfcRelAggregates', ['2$abcdefghijklmnopqrstu', null, null, null, `#${assembly.expressId}`, parts.map((id) => `#${id}`)]);

    select(parts[0]);
    ctrl('c');
    assert.equal(readCopyClipboard(), null, 'a part alone is refused');
    select(assembly.expressId);
    ctrl('c');
    assert.deepEqual(readCopyClipboard()?.ids, [assembly.expressId]);
    ctrl('v');
    click(6, 6);
    assert.equal(live('IFCELEMENTASSEMBLY').length, 2);
    assert.equal(live('IFCCOLUMN').length, 4, 'two parts, two part copies');
    const rels = live('IFCRELAGGREGATES');
    assert.equal(rels.length, 2, 'the aggregation is re-created');
    const copyRel = rels.find((r) => !parts.map((id) => `#${id}`).includes((r.attributes[5] as string[])[0]))!;
    assert.equal((copyRel.attributes[5] as string[]).length, 2);
    assert.notEqual(copyRel.attributes[0], '2$abcdefghijklmnopqrstu');
    const hierarchy = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!.spatialHierarchy!;
    const partCopies = live('IFCCOLUMN').map((e) => e.expressId).filter((id) => !parts.includes(id));
    assert.equal(partCopies.length, 2);
    for (const id of partCopies) assert.equal(hierarchy.elementToStorey.get(id), STOREY, 'a part copy is listed under its storey, as the source parts are');
    const lastRemesh = remeshes.at(-1)!;
    assert.equal(lastRemesh.expressIds.length, 3, 'the assembly copy and its two parts are re-meshed');
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(live('IFCELEMENTASSEMBLY').length, 1);
    assert.equal(live('IFCCOLUMN').length, 2);
    assert.equal(live('IFCRELAGGREGATES').length, 1);
  });
});
