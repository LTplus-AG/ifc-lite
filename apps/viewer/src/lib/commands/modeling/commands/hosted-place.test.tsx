/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `opening.place` / `door.place` / `window.place` (#6232 A1): point at a wall
 * and click. The element lands in the wall under the cursor, its centre on
 * the cursor's spot along the wall; a click away from any wall places nothing
 * (D3, hosted only). Each placement is ONE undo step for the whole graph, it
 * exports with IfcRelVoidsElement and IfcRelFillsElement, and it survives a
 * split and a resize of its host.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { readHostedFill } from '@ifc-lite/create';
import { useViewerStore } from '@/store';
import { cleanup, press, render, type } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { CommandFieldsBar } from '@/components/viewer/tools/command/CommandFieldsBar';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime, writeCommandField } from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import type { CommandContext } from '../types.js';
import { OPENING_PLACE, WINDOW_PLACE, type HostedPlaceGesture } from './hosted-place.js';
import { typeOf } from '../authored-kinds.js';
import { createElementType } from '@/components/viewer/model-inspector/inspector-edits';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const gesture = () => getCommandRuntime().gesture as HostedPlaceGesture;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const live = () => {
  const s = useViewerStore.getState();
  return { dataStore: s.models.get(MODEL_ID)!.ifcDataStore!, view: s.mutationViews.get(MODEL_ID)! };
};
/** Live overlay records of an IFC class. */
function created(ifcClass: string): number[] {
  const { view } = live();
  return view.getNewEntities().filter((e) => e.type.toUpperCase() === ifcClass && !view.isDeleted(e.expressId)).map((e) => e.expressId);
}
const round = (v: number) => +v.toFixed(6);

let remeshed: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};
let wall = 0;

/** A 6 m × 0.2 m × 3 m wall along storey +x from the origin. */
function addWall(): number {
  const added = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in added);
  return added.expressId;
}

beforeEach(async () => {
  await seedModelingSession();
  remeshed = [];
  // Defaults outlive a seed: start every test from the builder's window and door.
  useViewerStore.getState().setAuthoringDims('window', { Width: 1.2, Height: 1.5, SillHeight: 0.9 });
  useViewerStore.getState().setAuthoringDefaults({ typeIds: {} });
  restoreRemesh = setRequestRemesh((_get, request) => { remeshed.push(request); });
  wall = addWall();
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('window.place (#6232 A1)', () => {
  it('a click on a wall places a window there: opening, voids, fills and window in ONE undo step', () => {
    useViewerStore.getState().startCommand('window.place');
    const before = undoDepth();
    click(2, 0.08);
    const [window] = created('IFCWINDOW');
    assert.ok(window, 'a window was placed');
    const read = readHostedFill(live().dataStore, window, live().view)!;
    assert.deepEqual([read.hostId, round(read.offset), round(read.sill)], [wall, 2, 0.9], 'at the cursor along the wall, on the window sill default');
    for (const cls of ['IFCOPENINGELEMENT', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT']) assert.equal(created(cls).length, 1, cls);
    const s = useViewerStore.getState();
    assert.equal(s.selectedEntityId !== null && s.resolveGlobalIdFromModels(s.selectedEntityId)?.expressId, window, 'the window is selected');
    assert.deepEqual(remeshed.map((r) => [r.cause, [...r.expressIds].sort()]), [['created', [window, wall].sort()]],
      'the window and its host are re-meshed, so the host comes back with its void');

    useViewerStore.getState().undo(MODEL_ID);
    for (const cls of ['IFCWINDOW', 'IFCOPENINGELEMENT', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT']) assert.deepEqual(created(cls), [], `${cls} undone`);
    assert.equal(undoDepth(), before, 'one Ctrl+Z took the whole placement');
    useViewerStore.getState().redo(MODEL_ID);
    assert.equal(created('IFCWINDOW').length, 1, 'redo puts it back');
  });

  it('with no wall under the cursor nothing is placed (D3: hosted only)', () => {
    useViewerStore.getState().startCommand('window.place');
    const before = undoDepth();
    act(() => { commandPointerMove(at(3, 2)); });
    assert.equal(gesture().host, null);
    const verdict = WINDOW_PLACE.validate!(gesture(), getCommandRuntime().ctx as CommandContext);
    assert.deepEqual(verdict, { ok: false, reasonKey: 'hostedPlace.noHost' });
    click(3, 2);
    assert.deepEqual(created('IFCWINDOW'), []);
    assert.deepEqual(created('IFCOPENINGELEMENT'), []);
    assert.equal(undoDepth(), before);
  });

  it('near the wall end the window stays inside the wall; a typed Offset pins it', () => {
    useViewerStore.getState().startCommand('window.place');
    act(() => { commandPointerMove(at(0.1, 0)); });
    assert.equal(round(gesture().offset!), 0.6, 'clamped to half the 1.2 m default width');
    const ui = render(<CommandFieldsBar />);
    press(document.body, '4'); // opens Offset with a typed digit
    const input = ui.querySelector('input') as HTMLInputElement;
    assert.equal(input.getAttribute('aria-label'), 'Offset');
    type(input, '4.5');
    press(input, 'Enter');
    const [window] = created('IFCWINDOW');
    assert.equal(round(readHostedFill(live().dataStore, window, live().view)!.offset), 4.5);
  });

  it('refuses a window that does not fit in the wall', () => {
    useViewerStore.getState().setAuthoringDims('window', { Height: 2.5, SillHeight: 0.9 });
    useViewerStore.getState().startCommand('window.place');
    act(() => { commandPointerMove(at(3, 0)); });
    const verdict = WINDOW_PLACE.validate!(gesture(), getCommandRuntime().ctx as CommandContext);
    assert.deepEqual(verdict, { ok: false, reasonKey: 'hostedPlace.outsideHost' }, '0.9 m + 2.5 m pokes out of a 3 m wall');
    click(3, 0);
    assert.deepEqual(created('IFCWINDOW'), []);
  });

  it('exports with the true void: IfcRelVoidsElement and IfcRelFillsElement survive a re-parse', async () => {
    useViewerStore.getState().startCommand('window.place');
    click(3, 0);
    const [window] = created('IFCWINDOW');
    const { dataStore, view } = live();
    const bytes = editedModelBytes(dataStore, view);
    const reparsed = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
    const guidOf = (id: number) => String(view.getNewEntity(id)!.attributes[0]);
    const byGuid = (guid: string) => [...reparsed.entityIndex.byId.keys()].find((id) => reparsed.entities.getGlobalId(id) === guid);
    const reWall = byGuid(guidOf(wall));
    const reWindow = byGuid(guidOf(window));
    assert.ok(reWall && reWindow, 'wall and window are in the file');
    const read = readHostedFill(reparsed, reWindow);
    assert.ok(read, 'the re-parsed window fills an opening that voids a wall');
    assert.equal(read.hostId, reWall, 'IfcRelFillsElement → opening → IfcRelVoidsElement → the wall');
    assert.equal(round(read.offset), 3);
    assert.equal((reparsed.entityIndex.byType.get('IFCRELVOIDSELEMENT') ?? []).length, 1);
    assert.equal((reparsed.entityIndex.byType.get('IFCRELFILLSELEMENT') ?? []).length, 1);
  });
});

describe('door.place and opening.place (#6232 A1)', () => {
  it('a door stands on the floor and takes the door type default in the same undo step', () => {
    const typeId = createElementType(MODEL_ID, 'door', 'D-900');
    assert.ok(typeId !== null, 'IFC4 has IfcDoorType');
    useViewerStore.getState().setAuthoringDefaults({ typeIds: { door: { modelId: MODEL_ID, expressId: typeId } } });
    useViewerStore.getState().startCommand('door.place');
    const before = undoDepth();
    click(1.5, -0.05);
    const [door] = created('IFCDOOR');
    assert.ok(door);
    const read = readHostedFill(live().dataStore, door, live().view)!;
    assert.deepEqual([read.hostId, round(read.offset), round(read.sill)], [wall, 1.5, 0]);
    assert.equal(typeOf(live(), door), typeId, 'typed by the door default');
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(created('IFCDOOR'), []);
    assert.equal(undoDepth(), before);
  });

  it('an opening keeps its own typed size for the next one', () => {
    useViewerStore.getState().startCommand('opening.place');
    const width = OPENING_PLACE.fields!.findIndex((f) => f.id === 'width');
    act(() => { writeCommandField(width, 2); });
    click(3, 0);
    click(5, 0);
    const openings = created('IFCOPENINGELEMENT');
    assert.equal(openings.length, 2);
    assert.deepEqual(created('IFCDOOR'), []);
    assert.deepEqual(created('IFCRELFILLSELEMENT'), [], 'a bare opening fills nothing');
    assert.equal(round(readHostedFill(live().dataStore, openings[1], live().view)!.offset), 5, 'the second 2 m opening ends at the wall end');
    const { view } = live();
    const profileWidths = openings.map((id) => {
      // IfcOpeningElement.Representation → shape → body → solid → profile XDim.
      const deref = (v: unknown) => view.getNewEntity(Number(String(v).slice(1)))!;
      const shape = deref(view.getNewEntity(id)!.attributes[6]);
      const rep = deref((shape.attributes[2] as unknown[])[0]);
      const solid = deref((rep.attributes[3] as unknown[])[0]);
      return deref(solid.attributes[0]).attributes[3];
    });
    assert.deepEqual(profileWidths, [2, 2], 'both openings are 2 m wide');
  });
});

describe('the host keeps its fill (#6232 A1)', () => {
  function placeWindowAt(x: number): number {
    useViewerStore.getState().startCommand('window.place');
    click(x, 0);
    useViewerStore.getState().exitModelWorkspace();
    useViewerStore.setState({ editEnabled: true });
    const [window] = created('IFCWINDOW');
    return window;
  }

  it('a split moves the window with its half of the wall', () => {
    const window = placeWindowAt(1);
    const split = useViewerStore.getState().splitWallAtDistance(MODEL_ID, wall, 2);
    assert.ok(split.ok, split.ok ? '' : split.reason);
    // The 4 m right piece is larger and keeps the source's identity; the left 2 m piece is new.
    assert.equal(split.right.expressId, wall);
    const read = readHostedFill(live().dataStore, window, live().view)!;
    assert.deepEqual([read.hostId, round(read.offset)], [split.left.expressId, 1], 'the window went to the new piece it stands in');
    assert.equal(created('IFCRELFILLSELEMENT').length, 1, 'still filling its opening');
  });

  it('a split behind the window keeps it on the source, shifted to the new start', () => {
    const window = placeWindowAt(4.5);
    const split = useViewerStore.getState().splitWallAtDistance(MODEL_ID, wall, 2);
    assert.ok(split.ok, split.ok ? '' : split.reason);
    const read = readHostedFill(live().dataStore, window, live().view)!;
    assert.deepEqual([read.hostId, round(read.offset)], [wall, 2.5]);
  });

  it('a resize keeps the window in its wall', () => {
    const window = placeWindowAt(3);
    const resized = useViewerStore.getState().resizeWall(MODEL_ID, wall, [0, 0, 0], [8, 0, 0]);
    assert.ok(resized.ok, resized.ok ? '' : resized.reason);
    const read = readHostedFill(live().dataStore, window, live().view)!;
    assert.deepEqual([read.hostId, round(read.offset)], [wall, 3]);
    assert.equal(created('IFCRELVOIDSELEMENT').length, 1);
  });
});
