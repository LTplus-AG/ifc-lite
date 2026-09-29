/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `split.multi` (charter #6232, C5): one cut line through several elements,
 * one undo step. Three walls and a slab are cut by one line; the pieces keep
 * the split identity policy (`lib/split-guid.ts`); a window follows the wall
 * piece it stands in; what the plane crosses but the split predicate refuses
 * is reported and left alone; a failure while committing reverts the lot.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { uuidToIfcGuid, uuidV5 } from '@ifc-lite/encoding';
import { readHostedFill } from '@ifc-lite/create';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { readAttributes } from '@/lib/placement-core';
import { SPLIT_GLOBALID_NAMESPACE } from '@/lib/split-guid';
import { cleanup, render } from '@/test/render.js';
import { MESH_WALL, MODEL_ID, STOREY, TILTED_SLAB, seedModelingSession } from '@/test/modeling-session-fixture';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import type { CommandContext } from '../types.js';
import { CommandBarContent } from '@/components/viewer/tools/command/CommandHud';
import type { MultiSplitGesture } from './multi-split.js';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const gesture = () => getCommandRuntime().gesture as MultiSplitGesture;
// Through the running command, not its module: a build without it registers nothing and every test below fails.
const command = () => getCommandRuntime().command!;
const validate = (g: MultiSplitGesture, ctx: CommandContext) => command().validate!(g, ctx);
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const live = () => {
  const s = useViewerStore.getState();
  return { dataStore: s.models.get(MODEL_ID)!.ifcDataStore!, view: s.mutationViews.get(MODEL_ID)!, editor: s.storeEditors.get(MODEL_ID)! };
};
const derived = (source: string, k = 0) => uuidToIfcGuid(uuidV5(SPLIT_GLOBALID_NAMESPACE, `${source}/split/${k}`));
const round = (v: number) => Math.round(v * 1e6) / 1e6;

const GUIDS = { a: '2XQ$n5SLP5MBLyL442paFx', b: '3XQ$n5SLP5MBLyL442paFx', c: '0XQ$n5SLP5MBLyL442paFx', slab: '1pPHnf7cXCpPsNEnQf8_6C' } as const;

function guidOf(expressId: number): unknown {
  const { dataStore, view, editor } = live();
  return readAttributes(dataStore, view, editor, expressId)?.[0];
}

function built(result: { expressId: number } | { error: string }): number {
  assert.ok('expressId' in result, 'error' in result ? result.error : '');
  return result.expressId;
}

/** Walls along +x at y = 0, 2, 4 (4 m, 4 m and 5 m long), and a 4 × 6 m slab under all three. */
function authorScene() {
  const s = useViewerStore.getState();
  const wall = (guid: string, y: number, length: number) =>
    built(s.addWall(MODEL_ID, STOREY, { Start: [0, y, 0], End: [length, y, 0], Thickness: 0.2, Height: 2.5, GlobalId: guid }));
  return {
    a: wall(GUIDS.a, 0, 4),
    b: wall(GUIDS.b, 2, 4),
    c: wall(GUIDS.c, 4, 5),
    slab: built(s.addSlab(MODEL_ID, STOREY, {
      Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 6], [0, 6]], Thickness: 0.2, Position: [0, 0, -0.2], GlobalId: GUIDS.slab,
    })),
  };
}

function select(...ids: number[]): void {
  const s = useViewerStore.getState();
  s.setSelectedEntityIds(ids.map((id) => toGlobalIdFromModels(s.models, MODEL_ID, id)));
}

/** Two clicks: the cut line from (x0, y0) to (x1, y1), storey-local. */
function cut(x0: number, y0: number, x1: number, y1: number): void {
  useViewerStore.getState().startCommand('split.multi');
  act(() => { commandPointerMove(at(x0, y0)); commandPointerDown(at(x0, y0)); });
  act(() => { commandPointerMove(at(x1, y1)); });
}
const commitCut = () => act(() => { commandPointerDown(at(gesture().b![0], gesture().b![1])); });

/** Storey-local x-extent of a wall's axis. */
function wallSpan(expressId: number): [number, number] | null {
  const ends = useViewerStore.getState().readWallEndpoints(MODEL_ID, expressId);
  return ends ? [round(ends.start[0]), round(ends.end[0])] : null;
}
function slabSpan(expressId: number): [number, number] | null {
  const slab = useViewerStore.getState().readSlabFootprint(MODEL_ID, expressId);
  const xs = slab?.footprint.map((p) => p[0]);
  return xs ? [round(Math.min(...xs)), round(Math.max(...xs))] : null;
}
function authored(cls: string): number[] {
  const { view } = live();
  return view.getNewEntities().filter((e) => e.type.toUpperCase() === cls && !view.isDeleted(e.expressId)).map((e) => e.expressId);
}

/** A mesh spanning a box in storey-local metres, at the id's render frame (Y-up, z = -y). */
function giveMesh(expressId: number, min: [number, number, number], max: [number, number, number]): void {
  const positions = new Float32Array([min[0], min[2], -min[1], max[0], max[2], -max[1], max[0], min[2], -min[1]]);
  const mesh = { expressId, positions, normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] } as unknown as MeshData;
  live().dataStore && useViewerStore.getState().models.get(MODEL_ID)!.geometryResult!.meshes.push(mesh);
}

let remeshed: RemeshRequest[] = [];
let restoreRemesh: () => void = () => {};
beforeEach(async () => {
  await seedModelingSession();
  remeshed = [];
  restoreRemesh = setRequestRemesh((_get, request) => { remeshed.push(request); });
});
afterEach(() => {
  cleanup();
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
});

describe('split.multi: one line, several elements, one undo (#6232 C5)', () => {
  it('cuts three walls and a slab: every piece, the identities, one undo step, one re-mesh', () => {
    const { a, b, c, slab } = authorScene();
    select(a, b, c, slab);
    const before = undoDepth();
    cut(2, -1, 2, 7);
    assert.deepEqual(gesture().plan.splits.map((s) => s.expressId).sort(), [a, b, c, slab].sort(), 'the plan names all four');
    assert.equal(gesture().plan.refused.length, 0);
    commitCut();

    // Walls A and B are ties (2 | 2): the source keeps the piece holding the axis start.
    assert.deepEqual(wallSpan(a), [0, 2]);
    assert.deepEqual(wallSpan(b), [0, 2]);
    // Wall C is 2 | 3: the larger piece IS the source.
    assert.deepEqual(wallSpan(c), [2, 5]);
    const walls = authored('IFCWALL');
    assert.equal(walls.length, 6, 'three sources and three new pieces');
    const pieceOf = (source: number) => walls.find((id) => id !== source && guidOf(id) === derived(String(guidOf(source))));
    for (const [source, guid, span] of [[a, GUIDS.a, [2, 4]], [b, GUIDS.b, [2, 4]], [c, GUIDS.c, [0, 2]]] as const) {
      assert.equal(guidOf(source), guid, 'the source keeps its GlobalId');
      const piece = pieceOf(source);
      assert.ok(piece !== undefined, `a new piece with the derived GlobalId of ${guid}`);
      assert.deepEqual(wallSpan(piece), span);
    }
    // The slab: 12 m² | 12 m² tie, the source keeps the piece holding its first vertex.
    const slabs = authored('IFCSLAB');
    assert.equal(slabs.length, 2, 'the slab and its new half');
    assert.equal(guidOf(slab), GUIDS.slab);
    const half = slabs.find((id) => id !== slab)!;
    assert.equal(guidOf(half), derived(GUIDS.slab));
    assert.deepEqual([slabSpan(slab), slabSpan(half)].sort(), [[0, 2], [2, 4]]);

    assert.equal(undoDepth() > before, true);
    assert.equal(remeshed.length, 1, 'one re-mesh request for the one transaction');
    assert.equal(remeshed[0].cause, 'created');
    assert.equal(remeshed[0].expressIds.length, 8, 'four sources and four new pieces');

    // One undo step restores everything.
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), before, 'one Ctrl+Z took the whole cut');
    assert.deepEqual([wallSpan(a), wallSpan(b), wallSpan(c)], [[0, 4], [0, 4], [0, 5]]);
    assert.deepEqual(slabSpan(slab), [0, 4]);
    assert.equal(authored('IFCWALL').length, 3, 'the new pieces are gone');
    assert.equal(authored('IFCSLAB').length, 1);
    useViewerStore.getState().redo(MODEL_ID);
    assert.equal(authored('IFCWALL').length, 6, 'and redo puts them back');
  });

  it('selects every piece afterwards', () => {
    const { a, b, c, slab } = authorScene();
    select(a, b, c, slab);
    cut(2, -1, 2, 7);
    commitCut();
    const s = useViewerStore.getState();
    assert.equal(s.selectedEntityIds.size, 8);
  });

  it('a window follows the wall piece it stands in', () => {
    const { a, b, c } = authorScene();
    useViewerStore.getState().startCommand('window.place');
    act(() => { commandPointerMove(at(3, 2.05)); commandPointerDown(at(3, 2.05)); });
    const [window] = authored('IFCWINDOW');
    assert.ok(window, 'a window at x = 3 in wall B');
    useViewerStore.getState().endCommand('cancel');

    select(b);
    cut(2, -1, 2, 7);
    commitCut();
    const piece = authored('IFCWALL').find((id) => ![a, b, c].includes(id))!;
    assert.deepEqual(wallSpan(piece), [2, 4], 'the new piece is the far half');
    const hosted = readHostedFill(live().dataStore, window, live().view)!;
    assert.deepEqual([hosted.hostId, round(hosted.offset)], [piece, 1], 'the window went to the piece it stands in, 1 m from its start');
    assert.equal(authored('IFCRELFILLSELEMENT').length, 1, 'still filling its opening');
  });

  it('a window on the kept piece stays, shifted to the piece it is now measured from', () => {
    const { c } = authorScene();
    useViewerStore.getState().startCommand('window.place');
    act(() => { commandPointerMove(at(4, 4.05)); commandPointerDown(at(4, 4.05)); });
    const [window] = authored('IFCWINDOW');
    useViewerStore.getState().endCommand('cancel');
    select(c);
    cut(2, 3, 2, 5);
    commitCut();
    const hosted = readHostedFill(live().dataStore, window, live().view)!;
    // Wall C is 2 | 3: the far, larger piece keeps the identity and starts at 2 m.
    assert.deepEqual([hosted.hostId, round(hosted.offset)], [c, 2]);
  });
});

describe('split.multi: what the line crosses and cannot split (#6232 C5)', () => {
  it('reports each refusal with its reason and leaves it untouched', () => {
    const { a, slab } = authorScene();
    select(a, slab, MESH_WALL, TILTED_SLAB);
    cut(2, -1, 2, 7);
    const refused = new Map(gesture().plan.refused.map((r) => [r.expressId, r.reason]));
    assert.match(refused.get(MESH_WALL) ?? '', /mesh or B-rep/, 'the Split button\'s own reason for a mesh body');
    assert.ok(refused.has(TILTED_SLAB), 'a tilted extrusion is refused too');
    assert.deepEqual(gesture().plan.splits.map((s) => s.expressId).sort(), [a, slab].sort());
    const before = { mesh: guidOf(MESH_WALL), tilted: guidOf(TILTED_SLAB), footprint: useViewerStore.getState().readSlabFootprint(MODEL_ID, TILTED_SLAB)?.footprint };
    commitCut();
    assert.equal(authored('IFCWALL').length, 4, 'walls B and C uncut, wall A and its new piece');
    assert.equal(authored('IFCSLAB').length, 2);
    assert.deepEqual(
      { mesh: guidOf(MESH_WALL), tilted: guidOf(TILTED_SLAB), footprint: useViewerStore.getState().readSlabFootprint(MODEL_ID, TILTED_SLAB)?.footprint },
      before, 'the refused elements are as they were');
  });

  it('when everything the line crosses is refused, nothing is written', () => {
    select(MESH_WALL, TILTED_SLAB);
    const before = undoDepth();
    cut(2, -1, 2, 7);
    const verdict = validate(gesture(), getCommandRuntime().ctx as CommandContext);
    assert.deepEqual(verdict, { ok: false, reasonKey: 'multiSplit.nothingSplittable' });
    commitCut();
    assert.equal(undoDepth(), before);
    assert.equal(getCommandRuntime().command?.id, 'split.multi', 'the command keeps running');
  });

  it('a line that crosses nothing writes nothing', () => {
    const { a } = authorScene();
    select(a);
    const before = undoDepth();
    cut(9, -1, 9, 7);
    assert.deepEqual(gesture().plan, { splits: [], refused: [], marks: [] });
    assert.deepEqual(validate(gesture(), getCommandRuntime().ctx as CommandContext), { ok: false, reasonKey: 'multiSplit.crossesNothing' });
    commitCut();
    assert.equal(undoDepth(), before);
  });

  it('a wall the line crosses within 5 cm of its end is refused, not cut', () => {
    const { a, b } = authorScene();
    select(a, b);
    cut(3.97, -1, 3.97, 7);
    assert.deepEqual(gesture().plan.splits, []);
    assert.equal(gesture().plan.refused.length, 2);
    assert.match(gesture().plan.refused[0].reason, /within 5 cm/);
  });

  it('a commit whose planned split fails is reverted whole', () => {
    const { a, b, slab } = authorScene();
    select(a, b, slab);
    const before = undoDepth();
    const original = useViewerStore.getState().splitSlabByLine;
    useViewerStore.setState({ splitSlabByLine: () => ({ ok: false, reason: 'boom' }) });
    try {
      cut(2, -1, 2, 7);
      commitCut();
    } finally {
      useViewerStore.setState({ splitSlabByLine: original });
    }
    assert.equal(undoDepth(), before, 'the walls already cut were undone with it');
    assert.deepEqual([wallSpan(a), wallSpan(b)], [[0, 4], [0, 4]]);
    assert.equal(authored('IFCWALL').length, 3, 'no new wall survives');
    assert.equal(remeshed.length, 0);
  });
});

describe('split.multi: nothing selected sweeps the storey (#6232 C5)', () => {
  it('splits every wall and slab of the active storey the line crosses, and stays storey-wide', () => {
    const { a, b, c, slab } = authorScene();
    useViewerStore.getState().setSelectedEntityIds([]);
    useViewerStore.getState().setSelectedEntityId(null);
    cut(2, -1, 2, 7);
    assert.equal(gesture().mode, 'storey');
    const named = new Set(gesture().plan.splits.map((s) => s.expressId));
    for (const id of [a, b, c, slab]) assert.ok(named.has(id), `#${id} is on the storey and crossed`);
    commitCut();
    assert.equal(authored('IFCWALL').length, 6);
    assert.equal(gesture().mode, 'storey', 'the pieces are selected, but the next line still sweeps the storey');
    assert.equal(gesture().a, null, 'a fresh line');
  });

  it('reports a refused element the line crosses (by its mesh), and stays quiet about one it misses', () => {
    authorScene();
    giveMesh(TILTED_SLAB, [0, 0, 0], [4, 3, 0.2]);
    giveMesh(MESH_WALL, [8, 8, 0], [9, 9, 1]);
    useViewerStore.getState().setSelectedEntityIds([]);
    useViewerStore.getState().setSelectedEntityId(null);
    cut(2, -1, 2, 7);
    const refused = gesture().plan.refused.map((r) => r.expressId);
    assert.ok(refused.includes(TILTED_SLAB), 'crossed and refused: reported');
    assert.ok(!refused.includes(MESH_WALL), 'not crossed: not mentioned');
    const marks = gesture().plan.marks.filter((m) => m.status === 'refused').map((m) => m.expressId);
    assert.ok(marks.includes(TILTED_SLAB), 'and drawn as refused');
  });

  it('leaves the walls a line only touches at a corner alone', () => {
    const { a, b, c } = authorScene();
    cut(4, -1, 4, 7);
    const named = gesture().plan.splits.map((s) => s.expressId);
    assert.ok(!named.includes(a) && !named.includes(b), 'walls ending on the line are not crossed');
    assert.ok(named.includes(c), 'the 5 m wall runs past it');
  });
});

describe('split.multi: the plan (#6232 C5)', () => {
  it('draws the cut plane as a ghost, and marks what it splits', () => {
    const { a, slab } = authorScene();
    select(a, slab);
    cut(2, -1, 2, 7);
    const g = gesture();
    const ctx = getCommandRuntime().ctx as CommandContext;
    assert.equal(command().ghost!(g, ctx).length, 1, 'one ghost mesh for the plane');
    assert.deepEqual(g.plan.marks.map((m) => [m.expressId, m.status]).sort(), [[a, 'split'], [slab, 'split']].sort());
    assert.equal(command().hud.hint!(g), 'multiSplit.hintEnd');
  });

  it('needs two points before it commits', () => {
    const { a } = authorScene();
    select(a);
    useViewerStore.getState().startCommand('split.multi');
    const ctx = getCommandRuntime().ctx as CommandContext;
    assert.deepEqual(validate(gesture(), ctx), { ok: false, reasonKey: 'multiSplit.needLine' });
    act(() => { commandPointerMove(at(2, -1)); commandPointerDown(at(2, -1)); });
    assert.deepEqual(validate(gesture(), ctx), { ok: false, reasonKey: 'multiSplit.needLine' }, 'one point is not a line');
  });
});

describe('split.multi: the bar (#6232 C5)', () => {
  it('says what the cut takes and splits, and names each refusal with its reason', () => {
    const { a } = authorScene();
    select(a, MESH_WALL);
    cut(2, -1, 2, 7);
    const ui = render(<CommandBarContent tier={0} />);
    assert.match(ui.querySelector('[data-multi-split="scope"]')?.textContent ?? '', /Selected: 2 elements/);
    assert.equal(ui.querySelector('[data-multi-split="splits"]')?.textContent, '1 will split');
    const refused = ui.querySelector('[data-multi-split="refused"]');
    assert.equal(refused?.textContent, '1 refused');
    assert.match(refused?.getAttribute('title') ?? '', /mesh or B-rep/);
  });
});
