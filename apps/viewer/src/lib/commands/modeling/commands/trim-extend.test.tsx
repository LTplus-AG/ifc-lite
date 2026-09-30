/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.trimExtend` (charter #6232, C1): pick a boundary, then trim walls
 * and beams back to it or extend them out to it. A wall meeting a boundary
 * wall is joined through the join core (a T with its
 * `IfcRelConnectsPathElements`, the ending wall cut at the other's face, no
 * volume shared: proven on the wasm-meshed file); a trim never cuts through a
 * hosted window and refuses with the count; a wall the join core cannot read
 * is refused with the Split button's reason; every commit is ONE undo step.
 */

import '@/test/setup-dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { joinWallsInStore, resolveWallJoinAnchor, readHostedFill, readWallJoinRels, readWallJoinTarget } from '@ifc-lite/create';
import { readHostedCuts } from '@/lib/wall-hosted-cuts';
import type { MeshData } from '@ifc-lite/geometry';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
// The create package's mesh oracle: ray parity of sample points against each wall MESH.
import { meshWalls, sample } from '../../../../../../../packages/create/src/in-store/wall-join-mesh.oracle.js';
import { resolve as translate } from '@/i18n/registry';
import { modelEditTarget, recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { bodyPolygon } from './trim-extend-plan.js';
import { resizeWallMetres } from '@/store/slices/mutation-wall-resize';
import { useViewerStore } from '@/store';
import { resolveLinearElementChain } from '@/lib/linear-element-edit';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import type { Guide, SnapResult, Vec2 } from '@/lib/snap/types';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { CommandBarContent } from '@/components/viewer/tools/command/CommandHud';
import { cleanup, click as domClick, press, render } from '@/test/render.js';
import { MESH_WALL, MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime, updateCommandGesture } from '../runtime.js';
import { setRequestRemesh, type RemeshRequest } from '../transaction.js';
import { buildStoreyWorkplane, isWorkplane } from '../workplane.js';
import { prepareModel } from './trim-extend-model.js';
import type { TrimExtendGesture } from './trim-extend.js';

const ID = 'element.trimExtend';
const state = () => useViewerStore.getState();
const gesture = () => getCommandRuntime().gesture as TrimExtendGesture;

function snapAt(x: number, y: number, extra: Partial<SnapResult> = {}, shift = false): SnapResult {
  return { local: [x, y], winner: null, guides: [], locked: false, metresPerPixel: 0.01, modifiers: { shift, alt: false }, ...extra };
}
const hover = (x: number, y: number, shift = false, extra: Partial<SnapResult> = {}) => act(() => { commandPointerMove(snapAt(x, y, extra, shift)); });
const click = (x: number, y: number, shift = false, extra: Partial<SnapResult> = {}) =>
  act(() => { commandPointerMove(snapAt(x, y, extra, shift)); commandPointerDown(snapAt(x, y, extra, shift)); });
const setMode = (mode: 'trim' | 'extend') => act(() => { updateCommandGesture((g) => ({ ...(g as TrimExtendGesture), mode })); });

function built(result: { expressId: number } | { error: string }): number {
  assert.ok('expressId' in result, 'error' in result ? result.error : '');
  return result.expressId;
}
const wall = (start: Vec2, end: Vec2, thickness = 0.2) =>
  built(state().addWall(MODEL_ID, STOREY, { Start: [start[0], start[1], 0], End: [end[0], end[1], 0], Thickness: thickness, Height: 3 }));
const beam = (start: Vec2, end: Vec2) =>
  built(state().addBeam(MODEL_ID, STOREY, { Start: [start[0], start[1], 3], End: [end[0], end[1], 3], Width: 0.3, Height: 0.5 }));

function target() {
  const dataStore = state().models.get(MODEL_ID)!.ifcDataStore!;
  return { dataStore, view: state().mutationViews.get(MODEL_ID)!, editor: state().storeEditors.get(MODEL_ID)! };
}
const shape = (id: number) => { const t = target(); return readWallJoinTarget(t.dataStore, t.view, id, getModelLengthUnitScale(t.dataStore))!; };
const rels = () => { const t = target(); return readWallJoinRels(t.dataStore, t.view); };
const near = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const nearOne = (a: number, b: number) => Math.abs(a - b) < 1e-6;
// The reader rounds metre coordinates to nanometres; geometric equality is
// within that bound, rather than equality of floating-point addition order.
const samePolygon = (a: readonly Vec2[], b: readonly Vec2[]) => a.length === b.length
  && a.every((point, i) => point.every((value, j) => Math.abs(value - b[i][j]) <= 1e-9));
/** The number of distinct undo batches on the model's stack. */
function batches(): number {
  const s = state();
  return new Set((s.undoStacks.get(MODEL_ID) ?? []).map((m) => s.mutationBatchTags.get(m.id) ?? m.id)).size;
}
const mutations = () => target().view.getMutations().length;
function beamOf(id: number) {
  const t = target();
  const chain = resolveLinearElementChain(t.dataStore, t.view, t.editor, id, getModelLengthUnitScale(t.dataStore));
  assert.ok(chain, `beam #${id} is readable`);
  return chain;
}

const wasmPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm');
function exportModel(): string {
  const t = target();
  return new TextDecoder().decode(new StepExporter(t.dataStore, t.view).export({ schema: 'IFC4', applyMutations: true }).content);
}

/** No overlapping volume where two walls meet, and a solid body there: the wasm mesh is the judge. */
function expectCleanJunction(t: TestContext, ids: [number, number], centre: Vec2): void {
  if (!existsSync(wasmPath)) { t.diagnostic('wasm bundle not built: mesh oracle skipped'); return; }
  initSync({ module: readFileSync(wasmPath) });
  const meshes = meshWalls(new IfcAPI(), exportModel());
  const [a, b] = [meshes.get(ids[0]) ?? [], meshes.get(ids[1]) ?? []];
  assert.ok(a.length > 0 && b.length > 0, 'both walls mesh');
  const tally = sample(a, b, [centre[0], centre[1]]);
  assert.ok(tally.inside > 100, 'the junction is solid');
  assert.equal(tally.both, 0, 'and no volume is shared');
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
  state().exitModelWorkspace();
});

describe('element.trimExtend: extend a wall to a boundary wall (#6232 C1)', () => {
  for (const end of ['start', 'end'] as const) {
    it(`the ${end} extension ghost retains the opposite joined cut and matches the committed body (#6535)`, () => {
      const oppositeY = end === 'end' ? 0 : 4;
      const oldPartner = wall([0, oppositeY], [8, oppositeY]);
      const ending = wall([4, 0], [4, 4]);
      recordModellingEdit(useViewerStore, MODEL_ID, (_methods, draft) => {
        const t = target();
        return joinWallsInStore(draft, t.dataStore, resolveWallJoinAnchor(t.dataStore, draft.getMutationView()), oldPartner, ending);
      });
      const old = shape(ending).wall;
      assert.ok(end === 'end' ? old.startCut : old.endCut, 'the opposite end has a real IFC join cut');
      const originalFace = bodyPolygon(old).filter((p) => Math.abs(p[1] - oppositeY) < 0.2);
      const boundaryY = end === 'end' ? 6 : -2;
      wall([0, boundaryY], [8, boundaryY]);
      state().startCommand(ID);
      click(6, boundaryY);
      setMode('extend');
      const nearEnd = end === 'end' ? 3.8 : 0.2;
      hover(4, nearEnd);
      const preview = gesture().preview;
      assert.ok(preview?.ok, JSON.stringify(preview));
      const ghostFace = preview.outline.filter((p) => Math.abs(p[1] - oppositeY) < 0.2);
      assert.ok(samePolygon(ghostFace, originalFace), 'moving one axis end leaves the opposite joined face in the ghost');
      const before = batches();
      click(4, nearEnd);
      assert.equal(batches(), before + 1, 'the extension is one undo step');
      assert.ok(samePolygon(preview.outline, bodyPolygon(shape(ending).wall)), 'the ghost and actual re-read IFC body agree at both ends');
      state().undo(MODEL_ID);
      assert.ok(samePolygon(bodyPolygon(shape(ending).wall), bodyPolygon(old)), 'undo restores both original body faces');
    });
  }

  for (const end of ['start', 'end'] as const) {
    it(`moving the ${end} preserves a supported opposite custom cut without a join relationship (#6535)`, () => {
      const oppositeY = end === 'end' ? 0 : 4;
      const cut = { left: -0.1, right: -0.25 };
      const ending = built(state().addWall(MODEL_ID, STOREY, {
        Start: [4, 0, 0], End: [4, 4, 0], Thickness: 0.2, Height: 3,
        ...(end === 'end' ? { StartCut: cut } : { EndCut: cut }),
      }));
      const old = shape(ending).wall;
      assert.ok(end === 'end' ? old.startCut : old.endCut, 'the parsed supported trapezoid has the supplied cut');
      assert.equal(rels().length, 0, 'the custom cut has no join relationship');
      const boundaryY = end === 'end' ? 6 : -2;
      wall([0, boundaryY], [8, boundaryY]);
      state().startCommand(ID);
      click(6, boundaryY);
      setMode('extend');
      const nearEnd = end === 'end' ? 3.8 : 0.2;
      hover(4, nearEnd);
      const preview = gesture().preview;
      assert.ok(preview?.ok, JSON.stringify(preview));
      click(4, nearEnd);
      const oldFace = bodyPolygon(old).filter((p) => Math.abs(p[1] - oppositeY) < 0.3);
      const keptFace = bodyPolygon(shape(ending).wall).filter((p) => Math.abs(p[1] - oppositeY) < 0.3);
      assert.ok(samePolygon(keptFace, oldFace), 'the canonical writer preserves the supported opposite custom body face');
      assert.ok(samePolygon(preview.outline, bodyPolygon(shape(ending).wall)), 'the ghost is the body actually written');
      state().undo(MODEL_ID);
      assert.ok(samePolygon(bodyPolygon(shape(ending).wall), bodyPolygon(old)));
    });
  }

  it('makes a T: the relationship, the wall stopping at the near face, one undo step, one re-mesh', (t) => {
    const boundary = wall([0, 4], [8, 4]);
    const ending = wall([4, 0], [4, 3]);
    state().startCommand(ID);
    click(6, 4);
    assert.equal(gesture().boundary?.kind, 'wall');
    assert.equal(gesture().boundary?.ref?.expressId, boundary);
    setMode('extend');
    hover(4, 2.8);
    const preview = gesture().preview;
    assert.ok(preview?.ok && preview.op === 'extend' && preview.joinKind === 'T', JSON.stringify(preview));
    assert.equal(preview.removed, null, 'an extension removes nothing');

    const before = batches();
    click(4, 2.8);
    assert.equal(batches(), before + 1, 'one undo step');
    assert.ok(near(shape(ending).wall.end, [4, 4]), 'the axis reaches the boundary axis');
    assert.ok(near(shape(ending).wall.start, [4, 0]), 'the far end stayed');
    assert.ok(nearOne(shape(ending).wall.endCut!.left, -0.1), 'the body stops at the boundary wall face');
    assert.equal(shape(boundary).wall.endCut, undefined, 'the boundary wall runs through untouched');
    const [rel, ...rest] = rels();
    assert.equal(rest.length, 0);
    assert.equal(rel.relatingId, boundary);
    assert.equal(rel.relatingConnection, 'ATPATH');
    assert.equal(rel.relatedId, ending);
    assert.equal(rel.relatedConnection, 'ATEND');
    assert.equal(remeshed.length, 1);
    assert.equal(remeshed[0].cause, 'hostsChanged');
    assert.ok(remeshed[0].expressIds.includes(ending) && remeshed[0].expressIds.includes(boundary));
    expectCleanJunction(t, [boundary, ending], [4, 3.9]);

    // The command keeps its boundary for the next click.
    assert.equal(getCommandRuntime().command?.id, ID);
    assert.equal(gesture().boundary?.ref?.expressId, boundary);

    state().undo(MODEL_ID);
    assert.ok(near(shape(ending).wall.end, [4, 3]), 'undo puts the axis back');
    assert.equal(shape(ending).wall.endCut, undefined);
    assert.equal(rels().length, 0, 'and takes the join with it');
    state().redo(MODEL_ID);
    assert.equal(rels().length, 1);
    assert.ok(near(shape(ending).wall.end, [4, 4]));
  });

  it('without the join the same extension overlaps the boundary wall (the oracle can see it)', (t) => {
    if (!existsSync(wasmPath)) { t.skip('wasm bundle not built'); return; }
    const boundary = wall([0, 4], [8, 4]);
    const ending = wall([4, 0], [4, 3]);
    assert.ok(resizeWallMetres(useViewerStore, modelEditTarget(state(), MODEL_ID)!, MODEL_ID, ending, [4, 0, 0], [4, 4, 0]).ok);
    initSync({ module: readFileSync(wasmPath) });
    const meshes = meshWalls(new IfcAPI(), exportModel());
    assert.ok(sample(meshes.get(boundary) ?? [], meshes.get(ending) ?? [], [4, 3.9]).both > 0, 'an axis-to-axis extension shares volume with the wall it ends on');
  });

  it('extending the START of a wall, with a window standing in it, leaves the window where it is', () => {
    wall([0, 0], [8, 0]);
    const ending = wall([4, 2], [4, 6]);
    // 3 m up the wall (its local X from the start at y = 2): world y = 5.
    const fill = state().addHostedFill(MODEL_ID, ending, { kind: 'window', params: { Offset: 3, Sill: 0.9, Width: 1, Height: 1.2 } });
    assert.ok('expressId' in fill, 'error' in fill ? fill.error : '');
    const worldYBefore = 2 + readHostedFill(target().dataStore, fill.expressId, target().view)!.offset;
    state().startCommand(ID);
    click(6, 0);
    setMode('extend');
    const before = batches();
    click(4, 2.2);
    assert.equal(batches(), before + 1);
    assert.ok(near(shape(ending).wall.start, [4, 0]), 'the start reached the boundary');
    assert.equal(rels().length, 1);
    const read = readHostedFill(target().dataStore, fill.expressId, target().view)!;
    // The wall's origin moved to y = 0: the window's offset grew by the 2 m the wall was extended.
    assert.ok(nearOne(0 + read.offset, worldYBefore), `window world y ${read.offset} vs ${worldYBefore}`);
    state().undo(MODEL_ID);
    assert.ok(nearOne(readHostedFill(target().dataStore, fill.expressId, target().view)!.offset, 3), 'undo restores the window too');
  });

  it('a wall drawn in millimetres on an offset storey extends the same way', async () => {
    await seedModelingSession({ unit: 'millimetre', storeyOffset: [3, 3] });
    const boundary = wall([0, 4], [8, 4]);
    const ending = wall([4, 0], [4, 3]);
    state().startCommand(ID);
    click(6, 4);
    setMode('extend');
    click(4, 2.9);
    assert.ok(near(shape(ending).wall.end, [4, 4]), `${JSON.stringify(shape(ending).wall)}`);
    assert.equal(rels()[0]?.relatingId, boundary);
  });
});

describe('element.trimExtend: trim (#6232 C1)', () => {
  it('cuts a crossing wall back to the boundary wall: a T, the clicked side removed, one undo step', (t) => {
    const boundary = wall([0, 0], [8, 0]);
    const crossing = wall([4, -2], [4, 3]);
    state().startCommand(ID);
    click(6, 0);
    hover(4, 2.5);
    const preview = gesture().preview;
    assert.ok(preview?.ok && preview.op === 'trim' && preview.end === 'end', JSON.stringify(preview));
    // The ghost shows the kept side; the removed stretch (from y = 0 to y = 3) is what the HUD outlines red.
    assert.ok(preview.removed && preview.removed.every((p) => p[1] > -1e-9 && p[1] < 3 + 1e-9), JSON.stringify(preview.removed));

    const before = batches();
    click(4, 2.5);
    assert.equal(batches(), before + 1, 'one undo step');
    assert.ok(near(shape(crossing).wall.start, [4, -2]), 'the side that was not clicked stays');
    assert.ok(near(shape(crossing).wall.end, [4, 0]), 'the clicked side is gone');
    assert.ok(nearOne(shape(crossing).wall.endCut!.left, -0.1));
    const [rel] = rels();
    assert.equal(rels().length, 1);
    assert.equal(rel.relatingId, boundary);
    assert.equal(rel.relatingConnection, 'ATPATH');
    assert.equal(rel.relatedId, crossing);
    assert.equal(rel.relatedConnection, 'ATEND');
    expectCleanJunction(t, [boundary, crossing], [4, -0.1]);
    state().undo(MODEL_ID);
    assert.ok(near(shape(crossing).wall.end, [4, 3]));
    assert.equal(rels().length, 0);
  });

  it('a click on the other side removes THAT side', () => {
    wall([0, 0], [8, 0]);
    const crossing = wall([4, -2], [4, 3]);
    state().startCommand(ID);
    click(6, 0);
    click(4, -1.5);
    assert.ok(near(shape(crossing).wall.start, [4, 0]));
    assert.ok(near(shape(crossing).wall.end, [4, 3]));
    assert.equal(rels()[0]?.relatedConnection, 'ATSTART');
  });

  it('Shift flips the mode for a click: a trim command extends, and the refusal names the other mode', () => {
    wall([0, 4], [8, 4]);
    const stops = wall([4, 0], [4, 3]);
    state().startCommand(ID);
    click(6, 4);
    hover(4, 2.8);
    const refusal = gesture().preview;
    assert.ok(refusal && !refusal.ok);
    assert.match(refusal.reason, /Stops short of the boundary/);
    hover(4, 2.8, true);
    const flipped = gesture().preview;
    assert.ok(flipped?.ok && flipped.op === 'extend', 'Shift extends');
    click(4, 2.8, true);
    assert.ok(near(shape(stops).wall.end, [4, 4]));
    // And the other way round: Extend refuses a wall that crosses, Shift trims it.
    setMode('extend');
    const crossing = wall([2, 2], [2, 6]);
    hover(2, 5.5);
    const inside = gesture().preview;
    assert.ok(inside && !inside.ok && /Already crosses the boundary/.test(inside.reason));
    click(2, 5.5, true);
    assert.ok(near(shape(crossing).wall.end, [2, 4]));
  });
});

describe('element.trimExtend: beams (#6232 C1)', () => {
  it('trims and extends along the axis, the start end moving the placement, no join', () => {
    wall([4, -2], [4, 6]);
    const long = beam([0, 0], [6, 0]);
    const short = beam([0, 1], [3, 1]);
    const late = beam([5, 3], [8, 3]);
    state().startCommand(ID);
    click(4, 5.9);
    assert.equal(gesture().boundary?.kind, 'wall');

    click(5.5, 0);
    assert.ok(nearOne(beamOf(long).depth, 4), 'trimmed to the wall axis');
    assert.ok(nearOne(beamOf(long).startCoordinates[0], 0));

    setMode('extend');
    click(2.9, 1);
    assert.ok(nearOne(beamOf(short).depth, 4), 'extended to it');

    const before = batches();
    click(5.1, 3);
    assert.equal(batches(), before + 1);
    assert.ok(nearOne(beamOf(late).startCoordinates[0], 4), 'its start moved to the boundary');
    assert.ok(nearOne(beamOf(late).depth, 4));
    assert.equal(rels().length, 0, 'a beam is not joined');
    state().undo(MODEL_ID);
    assert.ok(nearOne(beamOf(late).startCoordinates[0], 5) && nearOne(beamOf(late).depth, 3), 'undo restores start and length');
  });
});

describe('element.trimExtend: hosted openings (#6232 C1)', () => {
  function windowedWall() {
    wall([0, 0], [8, 0]);
    const crossing = wall([4, -2], [4, 3]);
    // Centre 3.5 m along the wall from its start (y = 1.5), 1 m wide: it stands over y 1 to 2.
    const fill = state().addHostedFill(MODEL_ID, crossing, { kind: 'window', params: { Offset: 3.5, Sill: 0.9, Width: 1, Height: 1.2 } });
    assert.ok('expressId' in fill, 'error' in fill ? fill.error : '');
    return { crossing, window: fill.expressId };
  }

  it('a trim that would cut through a window is refused with the count, and writes nothing', () => {
    const { crossing } = windowedWall();
    state().startCommand(ID);
    click(6, 0);
    hover(4, 2.5);
    const preview = gesture().preview;
    assert.ok(preview && !preview.ok);
    assert.match(preview.reason, /1 opening, door or window hosted in this wall/);

    const written = mutations();
    const depth = batches();
    click(4, 2.5);
    assert.equal(mutations(), written, 'nothing was written');
    assert.equal(batches(), depth);
    assert.ok(near(shape(crossing).wall.end, [4, 3]));
    assert.equal(getCommandRuntime().command?.id, ID, 'the command keeps running');
  });

  it('trimming the side WITHOUT the window keeps it: at its place, through the moved placement, and undoes with the trim', () => {
    const { crossing, window } = windowedWall();
    const worldY = () => shape(crossing).origin[1] + readHostedFill(target().dataStore, window, target().view)!.offset;
    assert.ok(nearOne(worldY(), 1.5));
    state().startCommand(ID);
    click(6, 0);
    const before = batches();
    click(4, -1.5);
    assert.equal(batches(), before + 1);
    assert.ok(near(shape(crossing).wall.start, [4, 0]));
    assert.ok(nearOne(worldY(), 1.5), `the window did not move: ${worldY()}`);
    state().undo(MODEL_ID);
    assert.ok(nearOne(worldY(), 1.5));
    assert.ok(near(shape(crossing).wall.start, [4, -2]));
  });
});

describe('element.trimExtend: the joined body protects hosted openings (#6535 review)', () => {
  for (const side of ['start', 'end'] as const) {
    it(`${side}: refuses an opening inside the trimmed axis but crossing the boundary near face`, () => {
      wall([0, 0], [8, 0]);
      const crossing = wall([4, -2], [4, 3]);
      const Offset = side === 'end' ? 1.75 : 2.25;
      const fill = state().addHostedFill(MODEL_ID, crossing, { kind: 'window', params: { Offset, Sill: 0.9, Width: 0.4, Height: 1.2 } });
      assert.ok('expressId' in fill, 'error' in fill ? fill.error : '');
      state().startCommand(ID);
      click(6, 0);
      hover(4, side === 'end' ? 2.5 : -1.5);
      const preview = gesture().preview;
      assert.ok(preview && !preview.ok, 'the axis reaches y=0, but the joined body ends at its near face y=±0.1');
      assert.match(preview.reason, /1 opening, door or window hosted in this wall/);
      const before = batches();
      const written = mutations();
      click(4, side === 'end' ? 2.5 : -1.5);
      assert.equal(batches(), before);
      assert.equal(mutations(), written);
      assert.ok(near(shape(crossing).wall.start, [4, -2]));
      assert.ok(near(shape(crossing).wall.end, [4, 3]));
      assert.ok(nearOne(readHostedFill(target().dataStore, fill.expressId, target().view)!.offset, Offset));
    });

    it(`${side}: an opening wholly inside the joined body remains in place in one undo step`, () => {
      wall([0, 0], [8, 0]);
      const crossing = wall([4, -2], [4, 3]);
      const Offset = side === 'end' ? 1.6 : 2.4;
      const fill = state().addHostedFill(MODEL_ID, crossing, { kind: 'window', params: { Offset, Sill: 0.9, Width: 0.4, Height: 1.2 } });
      assert.ok('expressId' in fill, 'error' in fill ? fill.error : '');
      const worldY = () => shape(crossing).origin[1] + readHostedFill(target().dataStore, fill.expressId, target().view)!.offset;
      const beforeY = worldY();
      state().startCommand(ID);
      click(6, 0);
      const before = batches();
      click(4, side === 'end' ? 2.5 : -1.5);
      assert.equal(batches(), before + 1);
      assert.ok(nearOne(worldY(), beforeY));
      state().undo(MODEL_ID);
      assert.ok(nearOne(worldY(), beforeY));
      assert.ok(near(shape(crossing).wall.start, [4, -2]));
      assert.ok(near(shape(crossing).wall.end, [4, 3]));
    });
  }
});

describe('element.trimExtend: openings whose place cannot be read (#6232 C1)', () => {
  /** A void relationship of `wallId` whose RelatedOpeningElement resolves to nothing. */
  function danglingVoid(wallId: number): void {
    target().editor.addEntity('IfcRelVoidsElement', ['0dAnglingVoidRelGuid0000', null, null, null, `#${wallId}`, null]);
  }

  it('a decoded void relation with an unreadable host cannot be assumed to belong elsewhere (#6535)', () => {
    wall([0, 0], [8, 0]);
    const crossing = wall([4, -2], [4, 3]);
    target().editor.addEntity('IfcRelVoidsElement', ['0dAnglingVoidRelGuid0000', null, null, null, null, null]);
    state().startCommand(ID);
    click(6, 0);
    hover(4, 2.5);
    const preview = gesture().preview;
    assert.ok(preview && !preview.ok, 'an unknown host is not proof that the void belongs to another wall');
    assert.match(preview.reason, /Can't tell where 1 opening/);
    const before = mutations();
    click(4, 2.5);
    assert.equal(mutations(), before);
    assert.ok(near(shape(crossing).wall.end, [4, 3]));
  });

  it('a positive end extension with a submillimetre joined-body contraction still refuses an unknown opening (#6535)', () => {
    wall([0, 0], [8, 0], 0.004);
    const ending = wall([4, -4], [4, -0.0015]);
    danglingVoid(ending);
    state().startCommand(ID);
    click(6, 0);
    setMode('extend');
    hover(4, -0.2);
    const preview = gesture().preview;
    assert.ok(preview && !preview.ok, 'the axis grows 1.5 mm but its joined near face retreats 0.5 mm');
    assert.match(preview.reason, /Can't tell where 1 opening/);
    const before = batches();
    const written = mutations();
    click(4, -0.2);
    assert.equal(batches(), before);
    assert.equal(mutations(), written);
    assert.ok(near(shape(ending).wall.end, [4, -0.0015]));
  });

  it('a trim through a wall with a void relationship that names no opening is refused, never guessed', () => {
    wall([0, 0], [8, 0]);
    const crossing = wall([4, -2], [4, 3]);
    danglingVoid(crossing);
    state().startCommand(ID);
    click(6, 0);
    hover(4, 2.5);
    const preview = gesture().preview;
    assert.ok(preview && !preview.ok, 'refused');
    assert.match(preview.reason, /Can't tell where 1 opening/);
    const written = mutations();
    click(4, 2.5);
    assert.equal(mutations(), written, 'nothing was written');
    assert.ok(near(shape(crossing).wall.end, [4, 3]));
  });

  it('extending a wall\'s start (which moves its placement) is refused the same way', () => {
    wall([0, 0], [8, 0]);
    const ending = wall([4, 2], [4, 6]);
    danglingVoid(ending);
    state().startCommand(ID);
    click(6, 0);
    setMode('extend');
    hover(4, 2.2);
    const preview = gesture().preview;
    assert.ok(preview && !preview.ok);
    assert.match(preview.reason, /Can't tell where 1 opening/);
  });

  it('an effective dangling overlay void is an opening of unknown place, never an invented cut', () => {
    const crossing = wall([4, -2], [4, 3]);
    danglingVoid(crossing);
    const t = target();
    const seen = readHostedCuts(t.dataStore, t.view, crossing);
    assert.equal(seen.unreadable.length, 1);
    assert.equal(seen.cuts.length, 0);
  });
});

describe('element.trimExtend: other boundaries (#6232 C1)', () => {
  it('a guide line the snap solver holds (a grid axis) is a boundary: the wall is extended to it, with no join', () => {
    const ending = wall([4, 0], [4, 3]);
    const guide: Guide = { kind: 'line', origin: [0, 4], dir: [1, 0], role: 'edge' };
    const winner = { kind: 'edge' as const, local: [2, 4] as Vec2, source: 'grid' as const, guide };
    state().startCommand(ID);
    hover(2, 4, false, { winner });
    assert.equal(gesture().hover?.kind, 'line');
    click(2, 4, false, { winner });
    assert.ok(gesture().boundary);
    setMode('extend');
    click(4, 2.9);
    assert.ok(near(shape(ending).wall.end, [4, 4]));
    assert.equal(rels().length, 0);
  });

  it('a slab edge is a boundary: a wall is extended to it', () => {
    state().addSlab(MODEL_ID, STOREY, { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 6], [0, 6]], Thickness: 0.2, Position: [0, 0, -0.2] });
    const ending = wall([0, 3], [3, 3]);
    state().startCommand(ID);
    click(4.02, 4.5);
    assert.equal(gesture().boundary?.kind, 'slab');
    setMode('extend');
    click(2.9, 3);
    assert.ok(near(shape(ending).wall.end, [4, 3]));
    assert.equal(rels().length, 0);
  });

  it('a boundary that stops before the element\'s line meets it refuses', () => {
    wall([0, 4], [3, 4]);
    wall([6, 0], [6, 3]);
    state().startCommand(ID);
    click(1, 4);
    setMode('extend');
    hover(6, 2.9);
    const preview = gesture().preview;
    assert.ok(preview && !preview.ok);
    assert.match(preview.reason, /stops before/);
  });
});

describe('element.trimExtend: refusals (#6232 C1)', () => {
  /** A mesh spanning a box in storey-local metres, at the id's render frame (Y-up, z = -y). */
  function giveMesh(expressId: number, min: [number, number, number], max: [number, number, number]): void {
    const positions = new Float32Array([min[0], min[2], -min[1], max[0], max[2], -max[1], max[0], min[2], -min[1]]);
    const mesh = { expressId, positions, normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] } as unknown as MeshData;
    state().models.get(MODEL_ID)!.geometryResult!.meshes.push(mesh);
  }

  it('a wall the join core cannot read is refused with the reason the Split button gives', () => {
    wall([0, 4], [8, 4]);
    giveMesh(MESH_WALL, [10, 0, 0], [14, 0.3, 3]);
    const plane = buildStoreyWorkplane(state(), MODEL_ID, STOREY, 0);
    assert.ok(isWorkplane(plane));
    const meshTarget = prepareModel(state(), MODEL_ID, STOREY, plane).targets.find((t) => t.expressId === MESH_WALL);
    const verdict = state().readSplitTarget(MODEL_ID, MESH_WALL);
    assert.ok(meshTarget && !verdict.ok);
    assert.equal(meshTarget.refusal, translate(verdict.reasonKey));

    state().startCommand(ID);
    click(2, 4);
    hover(12, 0.1);
    const preview = gesture().preview;
    assert.ok(preview && !preview.ok);
    assert.equal(preview.reason, translate(verdict.reasonKey));
    const written = mutations();
    click(12, 0.1);
    assert.equal(mutations(), written);
  });

  it('a click that is not on a boundary picks nothing; a click on a wall picks it', () => {
    wall([0, 4], [8, 4]);
    state().startCommand(ID);
    click(3, 1);
    assert.equal(gesture().boundary, null);
    click(3, 4);
    assert.ok(gesture().boundary);
  });

  it('Backspace picks another boundary; Escape starts over, then leaves', () => {
    wall([0, 4], [8, 4]);
    state().startCommand(ID);
    click(3, 4);
    press(document.body, 'Backspace');
    assert.equal(gesture().boundary, null);
    click(3, 4);
    press(document.body, 'Escape');
    assert.equal(gesture().boundary, null);
    assert.equal(getCommandRuntime().command?.id, ID);
    press(document.body, 'Escape');
    assert.equal(getCommandRuntime().command, null);
  });
});

describe('element.trimExtend: the bar and the key (#6232 C1)', () => {
  it('the bar switches Trim and Extend and names the boundary and what a click would do', () => {
    wall([0, 4], [8, 4]);
    wall([4, 0], [4, 3]);
    state().startCommand(ID);
    click(6, 4);
    const ui = render(<CommandBarContent tier={0} />);
    assert.equal(ui.querySelector('[data-trim-extend="boundary"]')?.getAttribute('data-picked'), 'true');
    hover(4, 2.8);
    assert.match(ui.querySelector('[data-trim-extend="refused"]')?.textContent ?? '', /Stops short/);
    const extend = [...ui.querySelectorAll('[role="radio"]')].find((el) => el.textContent === 'Extend')!;
    domClick(extend);
    assert.equal(gesture().mode, 'extend');
    hover(4, 2.8);
    assert.equal(ui.querySelector('[data-trim-extend="result"]')?.getAttribute('data-join'), 'T');
    assert.match(ui.querySelector('[data-trim-extend="result"]')?.textContent ?? '', /Extend 1 m · T join/);
  });

  it('Shift+E starts it in the workspace only', () => {
    function Keys() { useKeyboardShortcuts(); return null; }
    state().exitModelWorkspace();
    useViewerStore.setState({ editEnabled: false, selectedEntityId: null });
    render(<Keys />);
    press(document.body, 'E', { shiftKey: true });
    assert.equal(getCommandRuntime().command, null, 'nothing outside the workspace');
    state().enterModelWorkspace();
    press(document.body, 'E', { shiftKey: true });
    assert.equal(getCommandRuntime().command?.id, ID);
    assert.equal(state().session?.activeCommandId, ID);
  });
});
