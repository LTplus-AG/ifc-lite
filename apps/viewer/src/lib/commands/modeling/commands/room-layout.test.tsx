/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Room tool's Space Sketch parity (charter #6232 M4, lane A4b), through
 * the REAL wasm DCEL and the in-store builders:
 *
 *   - Edit: drag a corner (both rooms follow), cut a room in two, merge two
 *     rooms, clean up the layout, each ONE undo step that undo reverses and
 *     after which the layout is the one filed under that step;
 *   - Footprint: one room over the storey's outline (an L, not its hull);
 *   - Auto on every storey, in one undo step;
 *   - the manual corner weld closing a gap the default leaves open;
 *   - leak diagnostics marking that gap;
 *   - a millimetre model, where the rooms the tool wrote must still read back
 *     as rooms (the footprint helper's scale).
 *
 * Walls: an 8 × 5 m box with a partition at x = 4, 0.2 m thick, axes on the
 * grid lines, on storey #40.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { blur, cleanup, render, type as typeInto } from '@/test/render.js';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { BOX, authoredSpaces, corners, ensureRoomWasm, r3, setWallMeshes, spaceQuantity, type Wall } from '@/test/room-walls-fixture';
import type { SnapResult } from '@/lib/snap/types';
import { ensureSpaceWasm } from '@/lib/space-plate-session';
import { clearStoreyRoomsCache, sessionRooms } from '@/lib/rooms/storey-rooms';
import { runRoomAction } from '@/components/viewer/tools/command/RoomPlaceBar';
import { RoomPlacePlan } from '@/components/viewer/tools/command/RoomPlaceLayers';
import { RoomMoreMenu } from '@/components/viewer/tools/command/RoomLayoutBar';
import { clearModelLayouts } from '@/lib/rooms/room-layout';
import '../builtin.js';
import * as runtime from '../runtime.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime, updateCommandGesture } from '../runtime.js';
import { setRequestRemesh } from '../transaction.js';
import type { CommandContext } from '../types.js';
import type { RoomEditTool, RoomPlaceGesture } from './room-place-gesture.js';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false, metresPerPixel: 0.02 });
const move = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); });
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const gesture = () => getCommandRuntime().gesture as RoomPlaceGesture;
const ctx = () => getCommandRuntime().ctx as CommandContext;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const undo = () => act(() => { useViewerStore.getState().undo(MODEL_ID); });
const redo = () => act(() => { useViewerStore.getState().redo(MODEL_ID); });
const set = (update: Partial<RoomPlaceGesture>) => act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), ...update })); });
const editWith = (tool: RoomEditTool) => set({ mode: 'edit', edit: { tool, hover: null, drag: null, cut: null, op: null } });
const layoutFaces = () => {
  const rooms = sessionRooms(ctx(), gesture().weld ?? undefined);
  return rooms?.status === 'ready' ? rooms.rooms : [];
};
const byLeft = () => authoredSpaces().sort((a, b) => Math.min(...a.footprint.map((p) => p[0])) - Math.min(...b.footprint.map((p) => p[0])));
const box = (x0: number, y0: number, x1: number, y1: number) => corners([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);

const PARTITIONED: Wall[] = [...BOX, [[4, 0], [4, 5]]];

beforeEach(async () => {
  await seedModelingSession();
  clearStoreyRoomsCache();
});
let restoreRemesh: () => void = () => {};
beforeEach(() => { restoreRemesh = setRequestRemesh(() => {}); });
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

async function start(t: TestContext, walls: Wall[] = PARTITIONED, upper: Wall[] = []): Promise<boolean> {
  if (!ensureRoomWasm(t)) return false;
  await ensureSpaceWasm();
  setWallMeshes(walls, upper);
  useViewerStore.getState().startCommand('room.place');
  assert.equal(getCommandRuntime().command?.id, 'room.place');
  return true;
}

const auto = () => act(async () => { await runRoomAction('auto'); });

describe('room.place Edit: drag a room corner (#6232 A4b)', () => {
  it('moves the shared corner: both rooms follow in ONE undo step, and undo / redo bring the layouts back', async (t) => {
    if (!(await start(t))) return;
    await auto();
    const [left, right] = byLeft();
    editWith('shape');
    const before = undoDepth();
    // Click the partition's foot to grab it, move, click to drop (the 3D gesture).
    click(4, 0);
    assert.ok(gesture().edit.drag, 'the corner is grabbed');
    move(5, 0);
    click(5, 0);
    assert.ok(undoDepth() > before, 'written');
    // The partition now runs from (5, 0) to (4, 5): the left room's axis area is 4.5 × 5.
    assert.equal(r3(spaceQuantity(left.id, 'GrossFloorArea')!), 22.5);
    assert.equal(r3(spaceQuantity(right.id, 'GrossFloorArea')!), 17.5);
    const leftNow = authoredSpaces().find((s) => s.id === left.id)!;
    assert.ok(leftNow.footprint.some(([x, y]) => x > 4.5 && y < 0.2), 'the left room reaches under the moved corner');
    assert.ok(layoutFaces().some((f) => f.centre.some(([x, y]) => r3(x) === 5 && r3(y) === 0)), 'the layout has the corner where it was dropped');

    undo();
    assert.equal(undoDepth(), before, 'one undo step');
    assert.deepEqual(corners(authoredSpaces().find((s) => s.id === left.id)!.footprint), corners(left.footprint), 'undo restores the left room');
    assert.deepEqual(corners(authoredSpaces().find((s) => s.id === right.id)!.footprint), corners(right.footprint), 'and the right one');
    assert.ok(layoutFaces().some((f) => f.centre.some(([x, y]) => r3(x) === 4 && r3(y) === 0)), 'and the layout as it was');
    redo();
    assert.ok(layoutFaces().some((f) => f.centre.some(([x, y]) => r3(x) === 5 && r3(y) === 0)), 'redo brings the edited layout back');
  });

  it('in the plan, a press-drag-release drops the corner on release', async (t) => {
    if (!(await start(t))) return;
    await auto();
    editWith('shape');
    click(4, 5);
    move(3, 5);
    // Namespace access: the oracle's revert of this branch must still load the file.
    act(() => { (runtime as { commandPointerUp?: (s: SnapResult) => void }).commandPointerUp?.(at(3, 5)); });
    assert.equal(gesture().edit.drag, null, 'the release dropped it');
    const [left] = byLeft();
    assert.equal(r3(spaceQuantity(left.id, 'GrossFloorArea')!), 17.5);
  });
});

describe('room.place Edit: split and merge (#6232 A4b)', () => {
  it('cuts a room between two points on its outline: the source keeps a piece, a new room takes the other, one undo step', async (t) => {
    if (!(await start(t))) return;
    await auto();
    const [left] = byLeft();
    editWith('shape');
    const before = undoDepth();
    click(2, 0);
    assert.deepEqual(gesture().edit.cut, [2, 0], 'the cut starts on the bottom wall');
    click(2, 5);
    assert.ok(undoDepth() > before, 'written');
    const rooms = byLeft();
    assert.equal(rooms.length, 3, 'one room became two');
    const pieces = rooms.filter((r) => r.footprint.every(([x]) => x <= 4));
    assert.deepEqual(pieces.map((r) => corners(r.footprint)).sort(), [box(0.1, 0.1, 2, 4.9), box(2, 0.1, 3.9, 4.9)].sort(), 'the new partition has no thickness');
    assert.ok(pieces.some((r) => r.id === left.id), 'the source is one of the pieces');
    const added = pieces.find((r) => r.id !== left.id)!;
    assert.equal(added.name, left.name, "the new piece carries the source's name");
    assert.notEqual(added.guid, left.guid, 'with its own GlobalId');
    assert.equal(layoutFaces().length, 3, 'the layout has the cut');

    undo();
    assert.equal(undoDepth(), before, 'one undo step');
    assert.equal(authoredSpaces().length, 2, 'undo takes the new room away');
    assert.deepEqual(corners(authoredSpaces().find((s) => s.id === left.id)!.footprint), corners(left.footprint));
    assert.equal(layoutFaces().length, 2, 'and the cut out of the layout');
  });

  it('merges two rooms across the wall between them: the larger keeps its identity, the other goes, one undo step', async (t) => {
    if (!(await start(t, [...BOX, [[3, 0], [3, 5]]]))) return;
    await auto();
    const [small, large] = byLeft();
    editWith('remove');
    const before = undoDepth();
    move(3, 2.5);
    assert.equal(gesture().edit.hover?.kind, 'edge');
    click(3, 2.5);
    assert.ok(undoDepth() > before, 'written');
    const [merged, ...rest] = authoredSpaces();
    assert.deepEqual(rest, [], 'one room left');
    assert.equal(merged.id, large.id, 'the larger room keeps its identity');
    assert.deepEqual(corners(merged.footprint), box(0.1, 0.1, 7.9, 4.9), 'over both');
    undo();
    assert.equal(undoDepth(), before, 'one undo step');
    assert.deepEqual(authoredSpaces().map((r) => r.id).sort(), [small.id, large.id].sort(), 'undo brings the other back');
  });

  it('cuts a face that is no room yet: the layout changes, nothing is written', async (t) => {
    if (!(await start(t))) return;
    editWith('shape');
    const before = undoDepth();
    click(2, 0);
    click(2, 5);
    assert.equal(undoDepth(), before, 'no transaction wrote anything');
    assert.deepEqual(authoredSpaces(), []);
    assert.equal(layoutFaces().length, 3, 'the layout has the cut: Pick and Auto now see two faces there');
    await auto();
    assert.equal(authoredSpaces().length, 3, 'and Auto makes them rooms');
  });
});

describe('room.place Edit: Clean up (#6232 A4b)', () => {
  it('prunes a dangling wall out of the layout and reshapes the room it poked into', async (t) => {
    if (!(await start(t, [...PARTITIONED, [[2, 0], [2, 2]]]))) return;
    await auto();
    const [left] = byLeft();
    assert.ok(left.footprint.length > 4, 'the stub notches the room');
    editWith('shape');
    await act(async () => { await runRoomAction('edit', { kind: 'prune' }); });
    const cleaned = authoredSpaces().find((s) => s.id === left.id)!;
    assert.ok(cleaned.footprint.length < left.footprint.length, 'the notch is gone');
  });
});

describe('room.place Footprint (#6232 A4b)', () => {
  const L: Wall[] = [
    [[0, 0], [8, 0]], [[8, 0], [8, 3]], [[8, 3], [4, 3]], [[4, 3], [4, 6]], [[4, 6], [0, 6]], [[0, 6], [0, 0]],
    [[0, 3], [4, 3]],
  ];

  it("makes one room over the storey's whole outline, an L rather than its hull, in one undo step", async (t) => {
    if (!(await start(t, L))) return;
    set({ boundary: 'center' });
    const before = undoDepth();
    await act(async () => { await runRoomAction('footprint'); });
    const [room, ...rest] = authoredSpaces();
    assert.deepEqual(rest, [], 'one room');
    assert.deepEqual(corners(room.footprint), corners([[0, 0], [8, 0], [8, 3], [4, 3], [4, 6], [0, 6]]), 'on the wall axes, around the L');
    await act(async () => { await runRoomAction('footprint'); });
    assert.equal(authoredSpaces().length, 1, 'a storey that has rooms refuses a second footprint');
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one undo step');
  });
});

describe('room.place Auto on every storey (#6232 A4b)', () => {
  it('fills both storeys in ONE undo step', async (t) => {
    if (!(await start(t, PARTITIONED, BOX))) return;
    const before = undoDepth();
    await act(async () => { await runRoomAction('autoAll'); });
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    const storeyOf = (id: number) => view.getNewEntities()
      .find((e) => e.type.toUpperCase() === 'IFCRELAGGREGATES' && (e.attributes[5] as string[]).includes(`#${id}`))?.attributes[4];
    const spaces = authoredSpaces();
    assert.equal(spaces.length, 3, 'two rooms below, one above');
    assert.deepEqual(spaces.map((s) => storeyOf(s.id)).sort(), [`#${STOREY}`, `#${STOREY}`, `#${UPPER_STOREY}`].sort());
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one undo step');
    assert.deepEqual(authoredSpaces(), []);
  });
});

describe('room.place corner weld and leak diagnostics (#6232 A4b)', () => {
  // The right wall stops 0.2 m short of the top wall: the right half leaks.
  const GAPPED: Wall[] = [[[0, 0], [8, 0]], [[8, 0], [8, 4.7]], [[8, 5], [0, 5]], [[0, 5], [0, 0]], [[4, 0], [4, 5]]];

  it('the default weld leaves the gap open; a 0.3 m weld closes it', async (t) => {
    if (!(await start(t, GAPPED))) return;
    assert.equal(layoutFaces().length, 1, 'only the left room closes');
    set({ weld: 0.3 });
    assert.equal(layoutFaces().length, 2, 'the weld closes the right one');
  });

  it('marks the walls that close nothing and the open wall ends, in the plan', async (t) => {
    if (!(await start(t, GAPPED))) return;
    set({ leaks: true });
    const toScreen = (p: readonly [number, number]) => [p[0] * 10, -p[1] * 10] as const;
    const ui = render(<svg><RoomPlacePlan gesture={gesture()} ctx={ctx()} toScreen={toScreen} /></svg>);
    const ends = [...ui.querySelectorAll('[data-room-open-end]')].map((c) => `${r3(Number(c.getAttribute('cx')) / 10)},${r3(-Number(c.getAttribute('cy')) / 10)}`).sort();
    assert.deepEqual(ends, ['8,4.7', '8,5'], 'the two ends either side of the gap');
    assert.ok(ui.querySelectorAll('[data-room-leak-wall]').length >= 1, 'the right wall encloses no room');
    set({ leaks: false });
  });
});

describe('room.place in a millimetre model (#6232 A4b, footprint helper scale)', () => {
  it('the rooms Auto wrote read back where they are: a second Auto makes none, and a drag reshapes them', async (t) => {
    await seedModelingSession({ unit: 'millimetre' });
    clearStoreyRoomsCache();
    if (!(await start(t))) return;
    await auto();
    assert.equal(authoredSpaces().length, 2);
    assert.ok(layoutFaces().every((f) => f.room !== null), 'each face is linked to the room written over it');
    await auto();
    assert.equal(authoredSpaces().length, 2, 'every face is taken');
    editWith('shape');
    click(4, 0);
    move(5, 0);
    click(5, 0);
    const [left] = byLeft();
    assert.equal(r3(spaceQuantity(left.id, 'GrossFloorArea')!), 22.5);
  });
});

describe('room.place review fixes (#6232 A4b)', () => {
  it('the weld field keeps "0" and "0." while typing and commits 0.3 on blur', async (t) => {
    if (!(await start(t))) return;
    const ui = render(<RoomMoreMenu gesture={gesture()} ctx={ctx()} rooms={2} />);
    act(() => { (ui.querySelector('[data-room-more]') as HTMLElement).click(); });
    const field = document.querySelector('input[type=number]') as HTMLInputElement;
    assert.ok(field, 'the weld field is in the More menu');
    act(() => { typeInto(field, '0'); });
    assert.equal(field.value, '0', 'a lone 0 stays typed');
    act(() => { typeInto(field, '0.'); });
    assert.equal(field.value, '0.', 'and so does "0."');
    act(() => { typeInto(field, '0.3'); });
    assert.equal(gesture().weld, null, 'nothing is committed while typing');
    act(() => { blur(field); });
    assert.equal(gesture().weld, 0.3, 'blur commits it');
  });

  it("a removed model's filed layouts are freed: the next read builds from the walls again", async (t) => {
    if (!(await start(t))) return;
    editWith('shape');
    click(2, 0);
    click(2, 5);
    assert.equal(layoutFaces().length, 3, 'the cut is in the filed layout');
    clearModelLayouts(MODEL_ID);
    assert.equal(layoutFaces().length, 2, 'freed: rebuilt from the walls');
  });
});
