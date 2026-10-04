/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.align` (#6232 C4). Boxes come from the rendered meshes in the
 * session workplane; the first click is the reference, later ones toggle
 * targets, and one Enter moves every target so its chosen edge sits on the
 * reference's, as ONE transaction: one undo puts all of them back, and what a
 * moved element hosts re-meshes with it. The wall tool's `wallAlign` (which
 * side of the drawn line a new wall sits on) is a different setting.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, render } from '@/test/render.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { solveSnap } from '@/lib/snap/solve';
import { AlignBar } from '@/components/viewer/tools/command/AlignBar';
import { AlignPlan, AlignScene } from '@/components/viewer/tools/command/AlignLayers';
import { alignMoves, type AlignGesture } from '../align-gesture.js';
import { modelMeshes, planBoxOf } from '../align-boxes.js';
import { ELEMENT_ALIGN } from './element-align.js';
import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import '../builtin.js';
import { commandDoubleClick, commandPointerDown, commandPointerMove, commitCommand, getCommandRuntime, updateCommandGesture } from '../runtime.js';
import { buildStoreyWorkplane, isWorkplane } from '../workplane.js';
import type { Vec3, Workplane } from '../types.js';
import type { SnapResult, SnapSource, Vec2 } from '@/lib/snap/types';

const s = () => useViewerStore.getState();
const undoStack = () => s().undoStacks.get(MODEL_ID) ?? [];
const gesture = () => getCommandRuntime().gesture as AlignGesture;
const created = (made: { expressId: number } | { error: string }): number => {
  assert.ok('expressId' in made, 'error' in made ? made.error : '');
  return made.expressId;
};
const position = (id: number) => s().readEntityPosition(MODEL_ID, id)!.map((v) => +v.toFixed(6));

let plane: Workplane;
let remeshes: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};

/** An axis-aligned box mesh for `expressId`, `min`..`max` in storey-local metres, in render space. */
function boxMesh(expressId: number, min: Vec3, max: Vec3): MeshData {
  const corners: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push(plane.localToRender([x, y, z]));
  return {
    expressId: toGlobalIdFromModels(s().models, MODEL_ID, expressId),
    positions: new Float32Array(corners.flat()),
    normals: new Float32Array(24), indices: new Uint32Array(0), color: [1, 1, 1, 1],
  } as MeshData;
}

/** Put `boxes` (express id → storey-local min / max) into the model's rendered geometry. */
function render3d(boxes: Record<number, [Vec3, Vec3]>): void {
  const model = s().models.get(MODEL_ID)!;
  const meshes = Object.entries(boxes).map(([id, [min, max]]) => boxMesh(Number(id), min, max));
  useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, geometryResult: { ...model.geometryResult, meshes } as GeometryResult }]]) });
}

/** A column `size` m square centred at `at`, 3 m tall, with its rendered box. */
function column(at: Vec2, size = 0.4): { id: number; box: [Vec3, Vec3] } {
  const id = created(s().addColumn(MODEL_ID, STOREY, { Position: [at[0], at[1], 0], Width: size, Depth: size, Height: 3 }));
  return { id, box: [[at[0] - size / 2, at[1] - size / 2, 0], [at[0] + size / 2, at[1] + size / 2, 3]] };
}

const click = (at: Vec2) => {
  const snap: SnapResult = { local: at, render: plane.localToRender([at[0], at[1], 0]), winner: null, guides: [], locked: false };
  act(() => { commandPointerMove(snap); commandPointerDown(snap); });
};
const setMode = (mode: AlignGesture['mode']) => act(() => updateCommandGesture((g) => ({ ...(g as AlignGesture), mode })));
const commit = () => act(() => { commitCommand(); });

async function start(options?: Parameters<typeof seedModelingSession>[0]) {
  await seedModelingSession(options);
  const p = buildStoreyWorkplane(s(), MODEL_ID, STOREY, 0);
  assert.ok(isWorkplane(p));
  plane = p;
}
function begin(): void {
  act(() => { s().enterModelWorkspace(); s().startCommand('element.align'); });
  assert.equal(getCommandRuntime().command?.id, 'element.align');
}

/** A commit selects what it aligned; a run that should start from nothing picked clears that. */
const clearSelection = () => act(() => useViewerStore.setState({ selectedEntityIds: new Set(), selectedEntityId: null, selectedEntity: null }));

beforeEach(() => {
  clearSelection();
  remeshes = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshes.push(request); });
});
afterEach(() => {
  restoreRemesh();
  cleanup();
  s().exitModelWorkspace();
});

describe('element.align (#6232 C4)', () => {
  let cols: { id: number; box: [Vec3, Vec3] }[] = [];
  beforeEach(async () => {
    await start();
    cols = [column([1, 1]), column([2.5, 3]), column([5, 2])];
    render3d(Object.fromEntries(cols.map((c) => [c.id, c.box])));
  });

  it('reads each element\'s footprint off its rendered meshes, in the workplane', () => {
    const box = planBoxOf([boxMesh(cols[1].id, ...cols[1].box)], toGlobalIdFromModels(s().models, MODEL_ID, cols[1].id), plane)!;
    assert.deepEqual([box.min, box.max].map((p) => p.map((v) => +v.toFixed(6))), [[2.3, 2.8], [2.7, 3.2]]);
    assert.deepEqual([box.z0, box.z1].map((v) => +v.toFixed(6)), [0, 3]);
  });

  it('aligns three columns on the reference\'s left edge in one undo step', () => {
    begin();
    const [a, b, c] = cols;
    assert.equal(gesture().boxes.size, 3, 'the storey\'s three columns are the candidates');
    click([1, 1]); // reference
    click([2.5, 3]);
    click([5, 2]);
    assert.deepEqual([gesture().reference, gesture().targets], [a.id, [b.id, c.id]]);
    const before = undoStack().length;

    commit();
    assert.deepEqual([position(a.id), position(b.id), position(c.id)], [[1, 1, 0], [1, 3, 0], [1, 2, 0]], 'x lines up, y stays');
    const written = undoStack().slice(before);
    assert.equal(written.length, 2, 'one placement write per moved column');
    assert.equal(new Set(written.map((m) => s().mutationBatchTags.get(m.id))).size, 1, 'one batch');
    assert.deepEqual([...new Set(remeshes.flatMap((r) => r.expressIds))].sort(), [b.id, c.id].sort(), 'both moved columns re-mesh');
    assert.equal(s().activeTool, 'select', 'the command ends');
    assert.deepEqual([...s().selectedEntityIds].sort(), [a.id, b.id, c.id].map((id) => toGlobalIdFromModels(s().models, MODEL_ID, id)).sort(), 'the aligned elements are selected');

    act(() => s().undo(MODEL_ID));
    assert.equal(undoStack().length, before, 'ONE undo puts all of them back');
    assert.deepEqual([position(a.id), position(b.id), position(c.id)], [[1, 1, 0], [2.5, 3, 0], [5, 2, 0]]);
  });

  it('left, centre and right use the reference\'s edges along u; top uses v', () => {
    const wide = created(s().addColumn(MODEL_ID, STOREY, { Position: [8, 5, 0], Width: 1, Depth: 0.4, Height: 3 }));
    render3d({ ...Object.fromEntries(cols.map((c) => [c.id, c.box])), [wide]: [[7.5, 4.8, 0], [8.5, 5.2, 3]] });
    begin();
    click([1, 1]);
    click([8, 5]);
    // Left is the default: the reference's left edge is 0.8, the wide column's 7.5 (centre 8, 1 m wide).
    assert.equal(gesture().mode, 'left');
    commit();
    assert.deepEqual(position(wide), [1.3, 5, 0], 'its left edge moved onto 0.8: centre 0.8 + 0.5');
    act(() => s().undo(MODEL_ID));

    clearSelection();
    begin();
    click([1, 1]);
    click([8, 5]);
    setMode('right');
    commit();
    // The reference's right edge is 1.2; the wide column's is 8.5: it moves 7.3 left.
    assert.deepEqual(position(wide), [0.7, 5, 0].map((v) => +v.toFixed(6)));
    act(() => s().undo(MODEL_ID));

    clearSelection();
    begin();
    click([1, 1]);
    click([8, 5]);
    setMode('top');
    commit();
    // Top edges: 1.2 for the reference, 5.2 for the wide one: it moves 4 down.
    assert.deepEqual(position(wide), [8, 1, 0]);
    act(() => s().undo(MODEL_ID));

    clearSelection();
    begin();
    click([1, 1]);
    click([8, 5]);
    setMode('centre');
    commit();
    // Centre lines: 1 for the reference, 8 for the wide one.
    assert.deepEqual(position(wide), [1, 5, 0]);
  });

  it('a selection at the start is the reference (its primary) and the targets; Enter aligns', () => {
    const ids = cols.map((c) => toGlobalIdFromModels(s().models, MODEL_ID, c.id));
    act(() => { s().setSelectedEntityIds(ids); s().setSelectedEntityId(ids[2]); });
    begin();
    assert.deepEqual([gesture().reference, [...gesture().targets].sort()], [cols[2].id, [cols[0].id, cols[1].id].sort()]);
    commit();
    assert.deepEqual([position(cols[0].id), position(cols[1].id), position(cols[2].id)].map((p) => p[0]), [4.8 + 0.2, 4.8 + 0.2, 5], 'left edges line up on the last-selected column');
  });

  it('clicking the reference again lets go of it and of its targets; a target clicked twice drops out', () => {
    begin();
    click([1, 1]);
    click([2.5, 3]);
    click([2.5, 3]);
    assert.deepEqual(gesture().targets, [], 'a second click on a target drops it');
    click([2.5, 3]);
    click([1, 1]);
    assert.deepEqual([gesture().reference, gesture().targets], [null, []], 'the reference again resets');
    click([5, 2]);
    assert.equal(gesture().reference, cols[2].id, 'the next click is a new reference');
  });

  it('a double click commits, and an aligned pick writes nothing', () => {
    begin();
    click([1, 1]);
    click([2.5, 3]);
    setMode('centre');
    act(() => commandDoubleClick({ local: [2.5, 3], render: plane.localToRender([2.5, 3, 0]), winner: null, guides: [], locked: false }));
    assert.equal(position(cols[1].id)[0], 1, 'the double click applied the alignment');

    // Already aligned on the same edge: refused, nothing written.
    render3d({ ...Object.fromEntries(cols.map((c) => [c.id, c.box])), [cols[1].id]: [[0.8, 2.8, 0], [1.2, 3.2, 3]] });
    begin();
    click([1, 1]);
    click([1, 3]);
    const before = undoStack().length;
    commit();
    assert.equal(undoStack().length, before);
    assert.equal(getCommandRuntime().command?.id, 'element.align', 'the command keeps running');
  });

  it('reads a model\'s meshes from that model only: another model\'s geometry never stands in (multi-model)', () => {
    const meshA = boxMesh(cols[0].id, ...cols[0].box);
    const meshB = { ...boxMesh(cols[1].id, ...cols[1].box), expressId: meshA.expressId };
    const model = s().models.get(MODEL_ID)!;
    const own = { ...model, idOffset: 0, geometryResult: { ...model.geometryResult, meshes: [meshA] } as GeometryResult };
    const other = { ...model, idOffset: 1000, geometryResult: null };
    const models = new Map<string, typeof model>([['a', own], ['b', other]]);
    const state = { models, activeModelId: 'a', geometryResult: { meshes: [meshB] } as unknown as GeometryResult };
    assert.deepEqual(modelMeshes(state, 'a'), [meshA], 'a model with its own geometry uses it, not the mirror');
    assert.deepEqual(modelMeshes(state, 'b'), [], 'the active model\'s mirror is not model b\'s geometry, even where the global ids collide');
    assert.deepEqual(modelMeshes({ ...state, activeModelId: 'b' }, 'b'), [meshB], 'the mirror serves the model it mirrors');
  });

  it('a click near another element\'s vertex picks what is under the cursor: Align does not snap points', () => {
    // A mesh vertex 3 cm from the cursor: the modeling profile lands on it, Align's does not.
    const vertex: SnapSource = { id: 'mesh', collect(q, _radius, out) { out.push({ kind: 'vertex', local: [q.cursor[0] + 0.03, q.cursor[1]], source: 'mesh' }); } };
    const query = { cursor: [2.5, 3] as Vec2, metresPerPixel: 0.01, anchor: null, chain: [], modifiers: { shift: false, alt: false }, locks: {} };
    const sources = [vertex];
    assert.notDeepEqual(solveSnap(query, sources, MODELING_SNAP_PROFILE).local, [2.5, 3], 'control: the modeling profile snaps');
    assert.ok(typeof ELEMENT_ALIGN.snap === 'object', 'Align names its own profile');
    assert.deepEqual(solveSnap(query, sources, ELEMENT_ALIGN.snap).local, [2.5, 3]);
  });

  it('marks the reference, the picked targets and the edge they line up on, in the plan and in 3D', () => {
    begin();
    click([1, 1]);
    click([2.5, 3]);
    click([5, 2]);
    // The plan: 10 px per metre, y flipped; the reference's left edge (u = 0.8) spans every picked box.
    const toScreen = (p: Vec2) => [p[0] * 10, -p[1] * 10] as const;
    const plan = render(<svg><AlignPlan gesture={gesture()} ctx={getCommandRuntime().ctx!} toScreen={toScreen} /></svg>);
    assert.equal(plan.querySelectorAll('[data-align-layer] path').length, 3, 'the reference and its two targets');
    const guide = plan.querySelector('[data-align-layer] line')!;
    for (const x of [guide.getAttribute('x1'), guide.getAttribute('x2')]) assert.ok(Math.abs(Number(x) - 8) < 1e-3, `the guide runs along u = 0.8 m (8 px), got ${x}`);
    cleanup();

    useViewerStore.setState({
      cameraCallbacks: { projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: p.x * 10, y: -p.z * 10 }), getViewpoint: () => null },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
    const scene = render(<AlignScene gesture={gesture()} ctx={getCommandRuntime().ctx!} />);
    assert.equal(scene.querySelectorAll('[data-align-layer] path').length, 3);
    assert.ok(scene.querySelector('[data-align-layer] line'), 'and the guide, through the workplane');
  });

  it('the bar names the edge and how many will move; choosing an edge changes the gesture', () => {
    begin();
    click([1, 1]);
    click([2.5, 3]);
    const ui = render(<AlignBar gesture={gesture()} ctx={getCommandRuntime().ctx!} />);
    assert.match(ui.querySelector('[data-align-count]')!.textContent!, /1 picked · 1 to move/);
    const right = [...ui.querySelectorAll('[role="radio"]')].find((r) => r.textContent === 'Right') as HTMLElement;
    act(() => right.click());
    assert.equal(gesture().mode, 'right');
  });
});

describe('element.align with a wall and its window (#6232 C4)', () => {
  it('re-meshes what the moved wall hosts, and the window follows it', async () => {
    await start();
    const wall = created(s().addWall(MODEL_ID, STOREY, { Start: [0, 4, 0], End: [4, 4, 0], Thickness: 0.2, Height: 3 }));
    const placed = s().addHostedFill(MODEL_ID, wall, { kind: 'window', params: { Offset: 2, Sill: 0.9, Width: 1, Height: 1.2 } });
    assert.ok('expressId' in placed);
    const ref = column([6, 1]);
    render3d({ [ref.id]: ref.box, [wall]: [[0, 3.9, 0], [4, 4.1, 3]] });
    begin();
    click([6, 1]);
    click([2, 4]);
    setMode('bottom'); // reference bottom edge y = 0.8; the wall's bottom edge is 3.9
    remeshes = [];
    commit();
    assert.deepEqual(position(wall), [0, 0.9, 0], 'the wall\'s bottom edge (3.9) moved to the reference\'s (0.8)');
    const asked = new Set(remeshes.flatMap((r) => r.expressIds));
    assert.ok(asked.has(wall) && asked.has(placed.expressId) && asked.has(placed.openingId), `the wall, its opening and its window re-mesh: ${[...asked]}`);
  });
});

it('selected hosted child uses its host preview delta and commit placement once (#6232)', async () => {
  await start();
  const wall = created(s().addWall(MODEL_ID, STOREY, { Start: [0,4,0], End: [4,4,0], Thickness: .2, Height: 3 }));
  const window = s().addHostedFill(MODEL_ID, wall, { kind: 'window', params: { Offset: 2, Sill: .9, Width: 1, Height: 1.2 } });
  assert.ok('expressId' in window);
  const ref = column([6,1]);
  // Deliberately different host/child left edges: independent previews would
  // promise two incompatible shifts. Selection semantics keep the child hosted.
  render3d({ [ref.id]: ref.box, [wall]: [[0,3.9,0],[4,4.1,3]], [window.expressId]: [[2,3.95,.9],[3,4.05,2.1]] });
  act(() => {
    s().setSelectedEntityIds([ref.id, wall, window.expressId].map(id => toGlobalIdFromModels(s().models, MODEL_ID, id)));
    s().setSelectedEntityId(toGlobalIdFromModels(s().models, MODEL_ID, ref.id));
  });
  begin();
  assert.ok(gesture().carried?.includes(window.expressId));
  assert.deepEqual(alignMoves(gesture()).map(move => move.id), [wall], 'preview and atomic writer plan the same host root');
  assert.equal(ELEMENT_ALIGN.ghost!(gesture(), getCommandRuntime().ctx!).length, 1);
  const childLocal = position(window.expressId), undoBefore = undoStack().length;
  commit();
  assert.deepEqual(position(wall), [5.8,4,0]);
  assert.deepEqual(position(window.expressId), childLocal, 'its relative placement is not written a second time');
  act(() => s().undo(MODEL_ID));
  assert.equal(undoStack().length, undoBefore);
  assert.deepEqual(position(wall), [0,4,0]);
});

describe('element.align in a millimetre file on an offset storey (#6232 C4)', () => {
  it('moves by metres, whatever the file\'s unit and the storey\'s offset', async () => {
    await start({ unit: 'millimetre', storeyOffset: [3, 3] });
    const a = column([1, 1]);
    const b = column([2.5, 3]);
    render3d({ [a.id]: a.box, [b.id]: b.box });
    begin();
    click([1, 1]);
    click([2.5, 3]);
    commit();
    assert.deepEqual(position(b.id), [1, 3, 0]);
  });
});
