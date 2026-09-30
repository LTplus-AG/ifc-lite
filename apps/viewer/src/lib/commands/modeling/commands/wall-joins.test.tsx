/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall joins in the viewer (#6232 B2): `wall.place` writes an L at every
 * chained corner (and where the loop closes) and a T where a wall ends on
 * another's path, all in the placement's ONE undo step; `wall.moveEndpoint`
 * drags a shared corner with both walls; resize and split keep the Axis and
 * the joins current.
 */

import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { readWallJoinRels, readWallJoinTarget } from '@ifc-lite/create';
import { extractWallSegmentsForStorey } from '@ifc-lite/create';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser } from '@ifc-lite/parser';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
// The create package's mesh oracle: ray parity of sample points against each wall MESH.
import { meshWalls, sample } from '../../../../../../../packages/create/src/in-store/wall-join-mesh.oracle.js';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { joinPlacedWallIn } from '@/store/slices/mutation-wall-joins';
import { setWallSection } from '@/store/slices/mutation-wall-section';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { resizeRectangleWall } from '@/lib/wall-edit';
import { press } from '@/test/render.js';
import { commitElementTransform, type ElementTransformOp } from '@/lib/element-transform/commit';
import { buildStoreyWorkplane, isWorkplane } from '../workplane.js';
import { runTransaction } from '../transaction.js';
import type { ModelingCommand } from '../types.js';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '../runtime.js';
import { beginWallEndpointDrag, type WallEndpointGesture } from './wall-move-endpoint.js';
import type { WallPlaceGesture } from './wall-place-geometry.js';

const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const chain = () => (getCommandRuntime().gesture as WallPlaceGesture).chain;
const state = () => useViewerStore.getState();
const undo = () => state().undo(MODEL_ID);
const redo = () => state().redo(MODEL_ID);

function target() {
  const dataStore = state().models.get(MODEL_ID)!.ifcDataStore!;
  return { dataStore, view: state().mutationViews.get(MODEL_ID)! };
}
const rels = () => { const t = target(); return readWallJoinRels(t.dataStore, t.view); };
const shape = (id: number) => { const t = target(); return readWallJoinTarget(t.dataStore, t.view, id, 1)!; };
/** Live wall ids the session authored, oldest first. */
function wallIds(): number[] {
  const { view } = target();
  return view.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCWALL' && !view.isDeleted(e.expressId)).map((e) => e.expressId);
}
/** The number of distinct undo batches on the model's stack. */
function batches(): number {
  const s = state();
  return new Set((s.undoStacks.get(MODEL_ID) ?? []).map((m) => s.mutationBatchTags.get(m.id) ?? m.id)).size;
}
const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

const ROOM: Vec2[] = [[0, 0], [6, 0], [6, 4], [0, 4]];

beforeEach(async () => {
  await seedModelingSession();
  state().setAuthoringDefaults({ wallAlign: 'centre', chain: true });
  state().startCommand('wall.place');
});
afterEach(() => { state().exitModelWorkspace(); });

function drawRoom(): void {
  for (const [x, y] of ROOM) click(x, y);
  click(0, 0);
}

describe('wall.place writes joins (#6232 B2)', () => {
  it('a chained room has four joins, closes its loop, and each placement is one undo step', () => {
    click(...ROOM[0]);
    const counts: Array<[number, number]> = [];
    for (const [x, y] of [...ROOM.slice(1), ROOM[0]]) {
      click(x, y);
      counts.push([wallIds().length, batches()]);
    }
    assert.deepEqual(counts, [[1, 1], [2, 2], [3, 3], [4, 4]], 'one undo batch per wall, its joins included');
    assert.equal(rels().length, 4, 'an L at every corner, the closing one included');
    assert.deepEqual(chain(), [], 'closing the loop ends the chain');
    // Every wall carries an Axis and a body cut for its corners.
    for (const id of wallIds()) assert.notEqual(shape(id).axisRepId, null);

    undo();
    assert.equal(wallIds().length, 3, 'one undo removes the closing wall');
    assert.equal(rels().length, 2, 'and the two joins it wrote');
    undo();
    assert.equal(rels().length, 1);
    redo();
    redo();
    assert.equal(wallIds().length, 4);
    assert.equal(rels().length, 4, 'redo brings the joins back');
  });

  it('each corner is a butt: the through wall reaches the outer face, the other stops at the inner face', () => {
    drawRoom();
    const [first, second] = wallIds();
    const a = shape(first).wall;
    const b = shape(second).wall;
    // The first wall of a tie runs through: its end reaches the outer corner (x = 6.1).
    assert.ok(near([a.endCut!.left, a.endCut!.right], [0.1, 0.1]), 'runs through past the axis end');
    assert.ok(near([b.startCut!.left, b.startCut!.right], [-0.1, -0.1]), 'stops at the through wall face');
  });

  it('a wall that ends on another wall path is a T', () => {
    click(0, 0);
    click(8, 0);
    press(document.body, 'Escape');
    click(4, 5);
    click(4, 0);
    const [through, ending] = wallIds();
    const [rel] = rels();
    assert.equal(rels().length, 1);
    assert.equal(rel.relatingId, through, 'the wall whose path is joined runs through');
    assert.equal(rel.relatingConnection, 'ATPATH');
    assert.equal(rel.relatedId, ending);
    assert.equal(rel.relatedConnection, 'ATEND');
    assert.ok(near([shape(ending).wall.endCut!.left], [-0.1]), 'the ending wall stops at the near face');
    assert.equal(shape(through).wall.endCut, undefined, 'the through wall keeps its body');
    undo();
    assert.equal(rels().length, 0, 'one undo takes the wall and its T');
    assert.equal(wallIds().length, 1);
  });

  it('a wall that only passes near another is not joined', () => {
    click(0, 0);
    click(8, 0);
    press(document.body, 'Escape');
    click(4, 5);
    click(4, 1);
    assert.equal(rels().length, 0);
  });

  it('re-joining an already joined pair replaces its relationship', () => {
    click(0, 0);
    click(4, 0);
    click(4, 3);
    const [a, b] = wallIds();
    const [first] = rels();
    const outcome = joinPlacedWallIn(useViewerStore, MODEL_ID, STOREY, b, [a]);
    assert.ok(outcome.ok && outcome.joined.length === 1);
    assert.equal(rels().length, 1, 'no second relationship');
    assert.notEqual(rels()[0].relId, first.relId, 'the relationship was rewritten');
    assert.equal(rels()[0].relatingId, first.relatingId, 'and the wall that ran through still does');
    undo();
    assert.equal(rels()[0]?.relId, first.relId, 'undo brings the first relationship back');
  });
});

describe('wall.moveEndpoint takes the joined wall along (#6232 B2)', () => {
  const release = () => act(() => { window.dispatchEvent(new window.PointerEvent('pointerup')); });
  const dragTo = (x: number, y: number) => {
    const plane = (getCommandRuntime().gesture as WallEndpointGesture).plane!;
    commandPointerMove({ local: [x, y], render: plane.localToRender([x, y, 0]), winner: null, guides: [], locked: false });
  };

  it('dragging a shared corner moves both walls and re-cuts the joins, in one undo step', () => {
    drawRoom();
    const [first, second, third, fourth] = wallIds();
    state().setSelectedEntityId(toGlobalIdFromModels(state().models, MODEL_ID, first));
    const before = batches();
    beginWallEndpointDrag('end');
    dragTo(7, 1);
    release();
    assert.ok(near(state().readWallEndpoints(MODEL_ID, first)!.end, [7, 1, 0]));
    assert.ok(near(state().readWallEndpoints(MODEL_ID, second)!.start, [7, 1, 0]), 'the neighbour follows the corner');
    assert.ok(near(state().readWallEndpoints(MODEL_ID, second)!.end, [6, 4, 0]), 'its far end stays');
    assert.ok(near(state().readWallEndpoints(MODEL_ID, first)!.start, [0, 0, 0]));
    assert.equal(rels().length, 4, 'all four joins stay');
    assert.equal(batches(), before + 1, 'one undo step');
    // The corner is cut against the new direction: an oblique join has a slanted end.
    assert.notEqual(shape(second).wall.startCut, undefined);
    assert.ok(shape(third).axisRepId !== null && shape(fourth).axisRepId !== null);

    undo();
    assert.ok(near(state().readWallEndpoints(MODEL_ID, first)!.end, [6, 0, 0]));
    assert.ok(near(state().readWallEndpoints(MODEL_ID, second)!.start, [6, 0, 0]));
    assert.equal(rels().length, 4);
  });

  it('a wall that was not joined drags alone, as before', () => {
    click(0, 0);
    press(document.body, 'Escape');
    press(document.body, 'Escape');
    state().startCommand('wall.place');
    state().setAuthoringDefaults({ chain: false });
    click(0, 0);
    click(4, 0);
    const [only] = wallIds();
    state().setSelectedEntityId(toGlobalIdFromModels(state().models, MODEL_ID, only));
    beginWallEndpointDrag('end');
    dragTo(5, 0);
    release();
    assert.ok(near(state().readWallEndpoints(MODEL_ID, only)!.end, [5, 0, 0]));
    assert.equal(rels().length, 0);
  });
});

describe('resize and split keep the Axis and the joins current (#6232 B2)', () => {
  const axisOf = (id: number) => {
    const t = target();
    const seg = extractWallSegmentsForStorey(t.dataStore, STOREY, t.view);
    const i = seg.contributingWallIds.indexOf(id);
    return i < 0 ? null : seg.segments[i];
  };

  it('a resized wall without joins keeps its Axis on the new ends', () => {
    click(0, 0);
    click(4, 0);
    const [id] = wallIds();
    assert.ok(state().resizeWall(MODEL_ID, id, [1, 1, 0], [7, 1, 0]).ok);
    const axis = axisOf(id)!;
    assert.ok(near(axis.a, [1, 1]) && near(axis.b, [7, 1]), `axis ${JSON.stringify(axis)}`);
    assert.notEqual(shape(id).axisRepId, null);
  });

  it('a resized joined wall keeps its Axis, and the join is cut against the new end', () => {
    click(0, 0);
    click(4, 0);
    click(4, 3);
    const [a, b] = wallIds();
    // Lengthen the second wall: its start stays on the first wall's axis.
    assert.ok(state().resizeWall(MODEL_ID, b, [4, 0, 0], [4, 5, 0]).ok);
    assert.ok(near(axisOf(b)!.b, [4, 5]));
    assert.equal(rels().length, 1);
    assert.ok(near(shape(b).wall.end, [4, 5]));
    // Drag the first wall's end a little short of the corner: it snaps back to the crossing, its Axis with it.
    assert.ok(state().resizeWall(MODEL_ID, a, [0, 0, 0], [3.9, 0, 0]).ok);
    assert.ok(near(shape(b).wall.start, [4, 0]), 'the second wall holds its corner');
    assert.ok(near(axisOf(a)!.b, [4, 0]));
    assert.equal(rels().length, 1);
    // Drag it well away from the corner: the walls no longer meet, the join goes and the second wall stops square.
    assert.ok(state().resizeWall(MODEL_ID, a, [0, 0, 0], [2, 0, 0]).ok);
    assert.equal(rels().length, 0, 'the join is dropped');
    assert.equal(shape(b).wall.startCut, undefined, 'the wall that stayed is square at that end');
    assert.ok(near(axisOf(a)!.b, [2, 0]), 'the first wall keeps the end it was given');
    undo();
    assert.equal(rels().length, 1, 'undo brings the join back');
    assert.ok(near(shape(b).wall.start, [4, 0]) && shape(b).wall.startCut !== undefined);
  });

  it('splitting a joined wall keeps the joins on the right pieces, in one undo step', () => {
    drawRoom();
    const [first, second] = wallIds();
    assert.equal(rels().length, 4);
    const before = batches();
    // The first wall runs (0,0) -> (6,0): cut it at 4 m, so the corner at its end goes with the last piece.
    const split = state().splitWallAtDistance(MODEL_ID, first, 4);
    assert.ok(split.ok, split.ok ? '' : split.reason);
    assert.equal(batches(), before + 1, 'one undo step');
    const pieces = wallIds();
    assert.equal(pieces.length, 5, 'one new piece');
    const all = rels();
    assert.equal(all.length, 4, 'still four joins');
    const [near0, far0] = split.ok ? [split.left.expressId, split.right.expressId] : [0, 0];
    const joinsOf = (id: number) => all.filter((r) => r.relatingId === id || r.relatedId === id);
    assert.equal(joinsOf(near0).length, 1, 'the first piece keeps the corner at (0,0)');
    assert.equal(joinsOf(far0).length, 1, 'the second piece takes the corner at (6,0)');
    assert.ok(joinsOf(near0).every((r) => r.relatingId !== second && r.relatedId !== second));
    assert.ok(joinsOf(far0).some((r) => r.relatingId === second || r.relatedId === second));
    // The pieces meet square at the cut and carry their own Axis.
    assert.ok(near(shape(near0).wall.end, [4, 0]) && near(shape(far0).wall.start, [4, 0]));
    assert.notEqual(shape(far0).axisRepId, null);
    assert.equal(shape(near0).wall.endCut, undefined);

    undo();
    assert.equal(wallIds().length, 4);
    assert.equal(rels().length, 4);
    assert.ok(near(shape(first).wall.end, [6, 0]), 'undo restores the wall and its corner');
  });
});

const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', '..', 'packages', 'wasm', 'pkg', 'ifc-lite_bg.wasm');

describe('the exported model keeps the joins and meshes clean (#6232 B2)', () => {
  function exportModel(): string {
    const { dataStore, view } = target();
    return new TextDecoder().decode(new StepExporter(dataStore, view).export({ schema: 'IFC4', applyMutations: true }).content);
  }

  /** Mesh the export and check every corner of the room: solid, and no volume inside both walls. */
  function expectCleanCorners(api: IfcAPI, corners: Vec2[]): void {
    const meshes = meshWalls(api, exportModel());
    const ids = wallIds();
    corners.forEach((corner, i) => {
      const tally = sample(meshes.get(ids[(i + ids.length - 1) % ids.length]) ?? [], meshes.get(ids[i]) ?? [], [corner[0], corner[1]]);
      assert.ok(tally.inside > 100, `corner ${i} is solid`);
      assert.equal(tally.both, 0, `corner ${i}: no overlapping volume`);
    });
  }

  it('a drawn room and a dragged corner mesh with no overlap; the file re-parses with all four joins', async (t: TestContext) => {
    if (!existsSync(wasmPath)) { t.skip('wasm bundle not built — run `bash scripts/build-wasm.sh` first'); return; }
    initSync({ module: readFileSync(wasmPath) });
    const api = new IfcAPI();
    drawRoom();
    expectCleanCorners(api, ROOM);

    const [first] = wallIds();
    state().setSelectedEntityId(toGlobalIdFromModels(state().models, MODEL_ID, first));
    beginWallEndpointDrag('end');
    const plane = (getCommandRuntime().gesture as WallEndpointGesture).plane!;
    commandPointerMove({ local: [7, 1], render: plane.localToRender([7, 1, 0]), winner: null, guides: [], locked: false });
    act(() => { window.dispatchEvent(new window.PointerEvent('pointerup')); });
    expectCleanCorners(api, [ROOM[0], [7, 1], ROOM[2], ROOM[3]]);

    const text = exportModel();
    const reparsed = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
    assert.equal(reparsed.entityIndex.byType.get('IFCRELCONNECTSPATHELEMENTS')?.length, 4, 'the joins survive export and re-parse');
    assert.equal(readWallJoinRels(reparsed, null).length, 4);
    assert.equal(text.match(/'Axis','Curve2D'/g)?.length, 4, 'and every wall keeps its Axis');
  });
});

describe('a moved or turned wall takes its joined walls along (#6232 B2)', () => {
  /** Move / turn `selected` in storey-local metres, as `element.move` / `element.rotate` write it: one transaction. */
  function transform(selected: number[], op: (local: (x: number, y: number) => readonly [number, number, number]) => ElementTransformOp): boolean {
    const plane = buildStoreyWorkplane(state(), MODEL_ID, STOREY, 0);
    assert.ok(isWorkplane(plane));
    const command: ModelingCommand = {
      id: 'test.transform', labelKey: 'modelInspector.edit', hud: {}, snap: 'modeling', init: () => null,
      pointerMove: (g) => g, pointerDown: (g) => g,
      commit: (_g, tx) => commitElementTransform(tx, MODEL_ID, selected, op((x, y) => plane.localToRender([x, y, 0]))),
    };
    const get = useViewerStore.getState;
    return runTransaction(useViewerStore, command, null, { get, modelId: MODEL_ID, storeyId: STOREY, workplane: plane }).ok;
  }
  const move = (dx: number, dy: number) => (l: (x: number, y: number) => readonly [number, number, number]): ElementTransformOp =>
    ({ kind: 'move', from: l(0, 0), to: l(dx, dy) });

  it('the walls joined at a moved wall end follow its corners, in one undo step', () => {
    drawRoom();
    const [first, second, third, fourth] = wallIds();
    const before = batches();
    assert.ok(transform([first], move(0, 1)));
    assert.equal(batches(), before + 1);
    assert.ok(near(shape(first).wall.start, [0, 1]) && near(shape(first).wall.end, [6, 1]), 'the wall moved');
    assert.ok(near(shape(second).wall.start, [6, 1]) && near(shape(second).wall.end, [6, 4]), 'the next wall stretched to the new corner');
    assert.ok(near(shape(fourth).wall.end, [0, 1]) && near(shape(fourth).wall.start, [0, 4]), 'so did the previous one');
    assert.ok(near(shape(third).wall.start, [6, 4]) && near(shape(third).wall.end, [0, 4]), 'the far wall stayed');
    assert.equal(rels().length, 4, 'all four joins stay');
    for (const id of wallIds()) assert.notEqual(shape(id).axisRepId, null);
    undo();
    assert.ok(near(shape(first).wall.start, [0, 0]) && near(shape(second).wall.start, [6, 0]) && near(shape(fourth).wall.end, [0, 0]));
    assert.equal(rels().length, 4);
  });

  it('a wall that ends on the moved wall keeps its place along it, also through a turn', () => {
    click(0, 0);
    click(8, 0);
    press(document.body, 'Escape');
    click(4, 5);
    click(4, 0);
    const [through, ending] = wallIds();
    assert.ok(transform([through], move(0, -1)));
    assert.ok(near(shape(ending).wall.end, [4, -1]), 'the T end went with the wall');
    assert.equal(rels().length, 1);
    assert.equal(rels()[0].relatingId, through);
    // Turn it a quarter turn about its start: the ending wall's end swings to the same point of the wall.
    assert.ok(transform([through], (l) => ({ kind: 'rotate', pivot: l(0, -1), angle: Math.PI / 2 })));
    assert.ok(near(shape(through).wall.end, [0, 7]), `through ${JSON.stringify(shape(through).wall)}`);
    assert.ok(near(shape(ending).wall.end, [0, 3]), `ending ${JSON.stringify(shape(ending).wall)}`);
    assert.equal(rels().length, 1);
  });

  it('walls that move together keep their joins untouched', () => {
    drawRoom();
    const before = rels().map((r) => r.relId).sort();
    assert.ok(transform(wallIds(), move(2, 3)));
    assert.deepEqual(rels().map((r) => r.relId).sort(), before, 'no join was rewritten');
    assert.ok(near(shape(wallIds()[0]).wall.start, [2, 3]));
  });

  it('moving a wall that ends on another off it drops the join and squares the end', () => {
    click(0, 0);
    click(8, 0);
    press(document.body, 'Escape');
    click(4, 5);
    click(4, 0);
    const [, ending] = wallIds();
    assert.ok(transform([ending], move(0, 3)));
    assert.equal(rels().length, 0, 'the ending wall no longer reaches the path');
    assert.equal(shape(ending).wall.endCut, undefined, 'and stops square');
  });
});

describe('edits that cannot keep a wall\'s joins valid refuse, and edits that land say so (#6232 B2)', () => {
  it('one edit of thickness AND height on a joined wall lands both on the wall and re-cuts its corners', () => {
    drawRoom();
    const [first, second] = wallIds();
    const before = batches();
    const outcome = setWallSection(useViewerStore, MODEL_ID, first, { thickness: 0.3, height: 2.5 });
    assert.deepEqual(outcome, { ok: true, remesh: [first] }, 'the write names the wall (and any opening it re-cut) for the re-mesh');
    const wall = shape(first);
    assert.ok(Math.abs(wall.wall.thickness - 0.3) < 1e-9, `thickness ${wall.wall.thickness}`);
    assert.ok(Math.abs(wall.height - 2.5) < 1e-9, `height ${wall.height}`);
    assert.ok(near([shape(second).wall.startCut!.left], [-0.15]), 'the neighbour stops at the thicker wall face');
    assert.equal(rels().length, 4);
    assert.ok(batches() > before);
  });

  it('a wall whose body cannot be read refuses a size edit instead of reporting ok', () => {
    drawRoom();
    const [first] = wallIds();
    const t = modelEditTarget(state(), MODEL_ID)!;
    // The body loses its representations: there is nothing for a height to land on.
    t.editor.setPositionalAttribute(shape(first).productShapeId, 2, []);
    const outcome = setWallSection(useViewerStore, MODEL_ID, first, { height: 2 });
    assert.equal(outcome.ok, false);
  });

  it('resizeRectangleWall refuses a joined wall and writes nothing', () => {
    drawRoom();
    const [first] = wallIds();
    const t = modelEditTarget(state(), MODEL_ID)!;
    const before = shape(first).wall;
    const stack = state().undoStacks.get(MODEL_ID)?.length;
    const mutations = t.view.getMutations().length;
    const result = resizeRectangleWall(t.dataStore, t.view, t.editor, first, [0, 0, 0], [9, 0, 0]);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /joins/);
    assert.equal(t.view.getMutations().length, mutations, 'nothing was written');
    assert.equal(state().undoStacks.get(MODEL_ID)?.length, stack);
    assert.deepEqual(shape(first).wall, before);
    assert.equal(rels().length, 4);
  });
});
