/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `room.place` (charter #6232 M4): rooms from the storey's walls through the
 * REAL wasm DCEL (`SpacePlateHandle.fromWallRects`), written as IfcSpace by
 * the in-store builder. A picked face becomes an IfcSpace whose profile is
 * the face's outline; Auto makes every enclosed face a room in ONE undo
 * step; Update rooms (decision D5) re-derives a room after its wall moved.
 *
 * The walls are rendered wall meshes, the input the tool reads (D4):
 * an 8 × 5 m box with a partition at x = 4, walls 0.2 m thick, axes on the
 * grid lines, on storey #40 (elevation 0).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { initSync } from '@ifc-lite/wasm';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, click as clickEl, press, render } from '@/test/render.js';
import { authoredBodies } from '@/test/authored-body';
import { DEFAULT_ROOM_CREATION } from '@/lib/rooms/room-creation-options';
import { RoomPlaceBar } from '@/components/viewer/tools/command/RoomPlaceBar';
import { commandKind } from '../authored-kinds.js';
import { ROOM_PLACE } from './room-place.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import { clearStoreyRoomsCache, roomCandidatesFromRects, storeyWallRects } from '@/lib/rooms/storey-rooms';
import { runRoomAction } from '@/components/viewer/tools/command/RoomPlaceBar';
import '../builtin.js';
import { commandDoubleClick, commandPointerDown, commandPointerMove, getCommandRuntime, updateCommandGesture } from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import type { CommandContext } from '../types.js';
import type { RoomPlaceGesture } from './room-place-gesture.js';

const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', '..', 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm');
let wasmReady = false;
function ensureWasm(t: TestContext): boolean {
  if (!existsSync(wasmPath)) {
    t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first');
    return false;
  }
  if (!wasmReady) {
    initSync({ module: readFileSync(wasmPath) });
    wasmReady = true;
  }
  return true;
}

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false, modifiers: { shift: false, alt: false } });
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const gesture = () => getCommandRuntime().gesture as RoomPlaceGesture;
const ctx = () => getCommandRuntime().ctx as CommandContext;
const undoDepth = () => {
  const state = useViewerStore.getState();
  return new Set((state.undoStacks.get(MODEL_ID) ?? []).map(mutation => state.mutationBatchTags.get(mutation.id) ?? mutation.id)).size;
};
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A wall's box mesh from `a` to `b` (storey-local plan, metres), 0.2 m thick, 3 m tall. */
function wallMesh(expressId: number, a: Vec2, b: Vec2): MeshData {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nx = -(b[1] - a[1]) / len * 0.1, ny = (b[0] - a[0]) / len * 0.1;
  const plan: Vec2[] = [[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]];
  // Render frame: Y up, render z = −IFC y.
  const positions = new Float32Array([0, 3].flatMap((h) => plan.flatMap(([x, y]) => [x, h, -y])));
  return {
    expressId, ifcType: 'IfcWall', positions, normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]), color: [0.8, 0.8, 0.8, 1],
  } as MeshData;
}

const BOX: Array<[Vec2, Vec2]> = [[[0, 0], [8, 0]], [[8, 0], [8, 5]], [[8, 5], [0, 5]], [[0, 5], [0, 0]]];

/**
 * A file IfcSpace's rendered body over the plan rectangle `min`–`max`, 0–3 m,
 * as a triangle soup — the shape AC20's spaces have, whose IFC footprint
 * reads back as an unordered vertex cloud.
 */
function spaceMesh(expressId: number, min: Vec2, max: Vec2): MeshData {
  const plan: Vec2[] = [[min[0], min[1]], [max[0], min[1]], [max[0], max[1]], [min[0], max[1]]];
  const positions = new Float32Array([0, 3].flatMap((h) => plan.flatMap(([x, y]) => [x, h, -y])));
  return {
    expressId, ifcType: 'IfcSpace', positions, normals: new Float32Array(positions.length),
    // Floor, ceiling and one side.
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4]), color: [0.5, 0.5, 1, 0.3],
  } as MeshData;
}

/** Put these walls (and spaces) in the model's rendered geometry (a fresh mesh array, as a re-mesh makes). */
function setWalls(partitionX: number, extra: MeshData[] = []): void {
  const meshes = [...[...BOX, [[partitionX, 0], [partitionX, 5]] as [Vec2, Vec2]].map(([a, b], i) => wallMesh(9000 + i, a, b)), ...extra];
  const s = useViewerStore.getState();
  const model = s.models.get(MODEL_ID)!;
  const geometryResult = { ...model.geometryResult, meshes } as GeometryResult;
  useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, geometryResult }]]), geometryResult });
}

/** Every live IfcSpace the tool wrote, with its storey-local footprint. */
function spaces(): { id: number; name: string; footprint: Vec2[] }[] {
  const s = useViewerStore.getState();
  const view = s.mutationViews.get(MODEL_ID)!;
  return view.getNewEntities()
    .filter((e) => e.type.toUpperCase() === 'IFCSPACE' && !view.isDeleted(e.expressId))
    .map((e) => ({
      id: e.expressId,
      name: String(e.attributes[2]),
      footprint: s.readSlabFootprint(MODEL_ID, e.expressId)!.footprint.map(([x, y]) => [r3(x), r3(y)] as Vec2),
    }));
}

/** A ring as a start- and direction-independent sorted corner list. */
const corners = (ring: readonly Vec2[]) => ring.map(([x, y]) => `${r3(x)},${r3(y)}`).sort();

const select = (id: number) => useViewerStore.getState().setSelectedEntityId(toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, id));

let remeshed: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.getState().setAuthoringDefaults({ roomCreation: DEFAULT_ROOM_CREATION });
  clearStoreyRoomsCache();
  remeshed = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshed.push(request); });
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

async function startRooms(t: TestContext, partitionX = 4): Promise<boolean> {
  if (!ensureWasm(t)) return false;
  await ensureSpaceWasm();
  setWalls(partitionX);
  useViewerStore.getState().startCommand('room.place');
  assert.equal(getCommandRuntime().command?.id, 'room.place');
  return true;
}

describe('room.place: pick a face (#6232 M4)', () => {
  it('a DCEL face becomes an IfcSpace whose polygon is the face outline', async (t) => {
    if (!(await startRooms(t))) return;
    const s = useViewerStore.getState();
    // The same face, straight off the DCEL.
    const face = roomCandidatesFromRects(storeyWallRects(s, MODEL_ID, STOREY, ctx().workplane!))
      .find((r) => r.centre.some(([x]) => r3(x) === 0))!;
    assert.deepEqual(corners(face.inner), corners([[0.1, 0.1], [3.9, 0.1], [3.9, 4.9], [0.1, 4.9]]), 'the inner face of the left room');

    const before = undoDepth();
    act(() => { commandPointerMove(at(2, 2.5)); });
    assert.equal(gesture().hover?.face, face.face, 'hovering shows the face under the cursor');
    click(2, 2.5);
    const [room] = spaces();
    assert.ok(room, 'the click made one IfcSpace');
    assert.deepEqual(corners(room.footprint), corners(face.inner), 'its profile is the face outline');
    assert.equal(room.name, 'Room 1');
    assert.equal(remeshed.at(-1)?.cause, 'created', 'the commit asks the wasm re-mesh service for its mesh');
    assert.ok(useViewerStore.getState().typeVisibility.spaces, 'IfcSpace is revealed so the room shows');

    // The face now has a room: a second click on it is refused.
    click(2, 2.5);
    assert.equal(spaces().length, 1, 'a taken face makes no second room');

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(spaces(), [], 'one undo removes the room');
    assert.equal(undoDepth(), before);
  });

  it('Axis follows the wall centrelines', async (t) => {
    if (!(await startRooms(t))) return;
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), boundary: 'center' })); });
    click(6, 1);
    assert.deepEqual(corners(spaces()[0].footprint), corners([[4, 0], [8, 0], [8, 5], [4, 5]]));
  });

});

// Draw mode supersedes lane A2's interim `space.place` (#6471); these are its cases.
describe('room.place: Draw, a free room (#6232 M4, supersedes A2 space.place)', () => {
  const bodies = () => authoredBodies(MODEL_ID, ['IFCSPACE']).map(({ expressId: _id, ...b }) => b);
  const BODY = { cls: 'IFCSPACE', identifier: 'Body', representationType: 'SweptSolid', solid: 'IFCEXTRUDEDAREASOLID', depth: 2.8 };
  const startDraw = (drawMode: 'rectangle' | 'polygon') => {
    const s = useViewerStore.getState();
    s.setAuthoringDefaults({ spaceMode: drawMode });
    s.setAuthoringDims('space', { Height: 2.8 });
    if (s.typeVisibility.spaces) s.toggleTypeVisibility('spaces');
    s.startCommand('room.place');
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), mode: 'draw' })); });
  };

  it('two corners make one IfcSpace with a rectangle body the space Height tall, aggregated under the storey, one undo step', () => {
    startDraw('rectangle');
    const before = undoDepth();
    click(1, 1);
    assert.deepEqual(bodies(), [], 'the first click only sets a corner');
    click(5, 4);
    assert.deepEqual(bodies(), [{ ...BODY, profile: 'IFCRECTANGLEPROFILEDEF' }]);
    assert.equal(undoDepth(), before + 1, 'one transaction');
    assert.equal(remeshed.length, 1, 'the commit asks the wasm re-mesh service for true geometry');
    const [space] = authoredBodies(MODEL_ID, ['IFCSPACE']);
    assert.deepEqual(useViewerStore.getState().readEntityPosition(MODEL_ID, space.expressId), [1, 1, 0], 'the min corner, storey-local');
    const aggregates = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities()
      .filter((e) => e.type.toUpperCase() === 'IFCRELAGGREGATES')
      .map((e) => [e.attributes[4], e.attributes[5]]);
    assert.deepEqual(aggregates, [[`#${STOREY}`, [`#${space.expressId}`]]], 'aggregated under the storey, not contained in it');
    assert.equal(useViewerStore.getState().typeVisibility.spaces, true, 'spaces show once one is drawn');
    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(bodies(), [], 'one undo removes the whole room');
    assert.equal(undoDepth(), before);
  });

  it('the bar switches to a polygon, which closes on Enter; the choice sticks for the next room', () => {
    startDraw('rectangle');
    const ui = render(<RoomPlaceBar gesture={gesture()} ctx={ctx()} />);
    clickEl([...ui.querySelectorAll('button')].find((b) => b.textContent === 'Polygon')!);
    assert.equal(gesture().draw.mode, 'polygon');
    assert.equal(useViewerStore.getState().authoringDefaults.spaceMode, 'polygon');
    const before = undoDepth();
    for (const [x, y] of [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]] as const) click(x, y);
    assert.deepEqual(bodies(), []);
    press(document.body, 'Enter');
    assert.deepEqual(bodies(), [{ ...BODY, profile: 'IFCARBITRARYCLOSEDPROFILEDEF' }]);
    assert.deepEqual(corners(spaces()[0].footprint), corners([[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]]));
    assert.equal(undoDepth(), before + 1);
  });

  it('a double-click closes the polygon; two corners are refused', () => {
    startDraw('polygon');
    click(0, 0);
    click(3, 0);
    press(document.body, 'Enter');
    assert.deepEqual(bodies(), [], 'two corners are refused');
    click(3, 3);
    act(() => { commandDoubleClick(at(3, 3)); });
    assert.equal(bodies().length, 1);
  });

  it('previews a prism of the space Height, and the inspector shows the space defaults', () => {
    startDraw('rectangle');
    assert.equal(commandKind('room.place', useViewerStore.getState().authoringDefaults), 'space');
    click(1, 1);
    act(() => { commandPointerMove(at(4, 3)); });
    const [ghost] = ROOM_PLACE.ghost!(gesture(), ctx());
    const plane = ctx().workplane!;
    const zs: number[] = [];
    for (let i = 0; i < ghost.positions.length; i += 3) {
      zs.push(plane.renderToLocal([ghost.positions[i], ghost.positions[i + 1], ghost.positions[i + 2]])[2]);
    }
    assert.deepEqual([Math.min(...zs), Math.max(...zs)].map((v) => +v.toFixed(6)), [0, 2.8]);
  });
});

describe('room.place: Auto (#6232 M4)', () => {
  it('makes every enclosed face a room in ONE undo step, and skips them the next time', async (t) => {
    if (!(await startRooms(t))) return;
    const before = undoDepth();
    await act(async () => { await runRoomAction('auto'); });
    const made = spaces();
    assert.equal(made.length, 2, 'both rooms of the storey');
    assert.deepEqual(made.map((r) => r.name).sort(), ['Room 1', 'Room 2']);
    assert.deepEqual(made.map((r) => corners(r.footprint)).sort(), [
      corners([[0.1, 0.1], [3.9, 0.1], [3.9, 4.9], [0.1, 4.9]]),
      corners([[4.1, 0.1], [7.9, 0.1], [7.9, 4.9], [4.1, 4.9]]),
    ].sort());
    assert.equal(gesture().action, 'place', 'the next click places again');

    await act(async () => { await runRoomAction('auto'); });
    assert.equal(spaces().length, 2, 'a second Auto finds every face taken');

    useViewerStore.getState().undo(MODEL_ID);
    assert.deepEqual(spaces(), [], 'one undo removes every room Auto made');
    assert.equal(undoDepth(), before);
  });
});

describe('room.place: rooms the file already has (#6232 M4)', () => {
  it('a face a file IfcSpace mesh covers is taken: Auto skips it and a click on it is refused', async (t) => {
    if (!(await startRooms(t))) return;
    setWalls(4, [spaceMesh(9100, [0.1, 0.1], [3.9, 4.9])]);
    click(2, 2.5);
    assert.deepEqual(spaces(), [], 'no second room over the file space');
    await act(async () => { await runRoomAction('auto'); });
    assert.deepEqual(spaces().map((r) => corners(r.footprint)), [corners([[4.1, 0.1], [7.9, 0.1], [7.9, 4.9], [4.1, 4.9]])], 'only the free face');
  });
});

describe('room.place: Update rooms (#6232 M4, D5)', () => {
  it("re-derives a selected room's outline after its wall moved; one undo restores it", async (t) => {
    if (!(await startRooms(t))) return;
    await act(async () => { await runRoomAction('auto'); });
    const left = spaces().find((r) => r.footprint.some(([x]) => x === 0.1))!;

    // The partition moves from x = 4 to x = 5 (its re-mesh lands): the room is a snapshot and stays.
    setWalls(5);
    assert.deepEqual(corners(spaces().find((r) => r.id === left.id)!.footprint), corners(left.footprint), 'no live link');

    select(left.id);
    const before = undoDepth();
    await act(async () => { await runRoomAction('update'); });
    const updated = spaces().find((r) => r.id === left.id)!;
    assert.deepEqual(corners(updated.footprint), corners([[0.1, 0.1], [4.9, 0.1], [4.9, 4.9], [0.1, 4.9]]), 'the room follows the wall');
    assert.equal(updated.name, left.name, 'same room, same name');
    assert.equal(remeshed.at(-1)?.cause, 'shape');
    const net = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getQuantitiesForEntity(left.id)
      .find((q) => q.name === 'Qto_SpaceBaseQuantities')?.quantities.find((q) => q.name === 'NetFloorArea')?.value;
    assert.equal(r3(Number(net)), r3(4.8 * 4.8), 'its net area follows too');

    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'the update was one undo step');
    assert.deepEqual(corners(spaces().find((r) => r.id === left.id)!.footprint), corners(left.footprint), 'undo restores the old outline');
  });
});


describe('Room options retained when deleting the panel (#6232/#6531)', () => {
  it('pluralizes the mounted summary for multiple free rooms (#6531)', async (t) => {
    if (!(await startRooms(t))) return;
    const before = undoDepth();
    const ui = render(<RoomPlaceBar gesture={gesture()} ctx={ctx()} />);
    const more = ui.querySelector('[data-room-more]')!;
    act(() => {
      more.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      clickEl(more);
    });
    const summary = document.querySelector('[data-room-preview-summary]');
    assert.ok(summary, 'read-only totals are reachable through More');
    assert.match(summary.textContent ?? '', /^2 new rooms ·/);
    assert.deepEqual(spaces(), [], 'the preview creates no spaces');
    assert.equal(undoDepth(), before, 'preview writes no undo entry');
  });

  it('previews count/area without writes, applies minimum area and names/types through Auto, and undoes one batch', async (t) => {
    if (!(await startRooms(t, 2))) return;
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), minArea: 15, namePattern: 'Suite {n}', PredefinedType: 'EXTERNAL' })); });
    const before = undoDepth();
    const ui = render(<RoomPlaceBar gesture={gesture()} ctx={ctx()} />);
    const more = ui.querySelector('[data-room-more]')!;
    act(() => {
      more.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      clickEl(more);
    });
    const summary = document.querySelector('[data-room-preview-summary]');
    assert.ok(summary, 'read-only totals are reachable through More');
    assert.match(summary.textContent ?? '', /^1 new room ·/);
    assert.doesNotMatch(summary.textContent ?? '', /1 new rooms/);
    assert.match(summary.textContent ?? '', /27[.,]84 m²/);
    assert.match(summary.textContent ?? '', /5 walls/);
    assert.match(summary.textContent ?? '', /layout vertices/);
    assert.deepEqual(spaces(), [], 'the preview creates no spaces');
    assert.equal(undoDepth(), before, 'preview writes no undo entry');
    await act(async () => { await runRoomAction('auto'); });
    const [room] = spaces();
    assert.equal(spaces().length, 1, 'the small 8.64 m² region is excluded by the actual WASM layout');
    assert.equal(room.name, 'Suite 1');
    const s = useViewerStore.getState();
    const view = s.mutationViews.get(MODEL_ID)!;
    assert.equal(view.getNewEntity(room.id)?.attributes[9], '.EXTERNAL.');
    assert.equal(view.getPropertyValue(room.id, 'Pset_SpaceCommon', 'IsExternal'), true);
    assert.equal(undoDepth(), before + 1);
    act(() => { s.undo(MODEL_ID); });
    assert.deepEqual(spaces(), []);
    assert.equal(undoDepth(), before);
  });

  it('lowering the threshold reveals the retained small candidate without replacing its topology', async (t) => {
    if (!(await startRooms(t, 2))) return;
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), minArea: 15 })); });
    act(() => { commandPointerMove(at(1, 2)); });
    assert.equal(gesture().hover, null, 'the small room is excluded');
    act(() => { updateCommandGesture((g) => ({ ...(g as RoomPlaceGesture), minArea: 1, namePattern: 'Office {n}' })); });
    click(1, 2);
    assert.equal(spaces().length, 1, 'the same model and undo head now exposes the smaller candidate');
    assert.equal(spaces()[0].name, 'Office 1');
    assert.deepEqual(corners(spaces()[0].footprint), corners([[0.1, 0.1], [1.9, 0.1], [1.9, 4.9], [0.1, 4.9]]));
  });
});
