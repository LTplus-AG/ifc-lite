/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `grid.place` (charter #6232, D3): two corners (or typed extents) and the
 * spacing make an IfcGrid with tagged axes, ONE undo step; the ghost is the
 * real axes; the tag scheme swaps numbers and letters; and once placed, the
 * grid's axes and crossings are what the command pointer snaps to, on the
 * storey (walls, columns and curtain walls land on them).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup } from '@/test/render.js';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { glyphFor } from '@/components/viewer/tools/command/snap-hud-geometry';
import { solveSnap } from '@/lib/snap/solve';
import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import type { SnapResult } from '@/lib/snap/types';
import '../builtin.js';
import { commandPointerDown, commandPointerMove, getCommandRuntime, updateCommandGesture, writeCommandField } from '../runtime.js';
import { setRequestRemesh } from '../transaction.js';
import type { CommandContext } from '../types.js';
import { modelSnapSources } from '../snap-solve.js';
import { GRID_PLACE } from './grid-place.js';
import { axisCount, axisOffsets, resetGridSettings, withGridSettings, type GridPlaceGesture } from './grid-place-geometry.js';

const at = (x: number, y: number, shift = false): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false, modifiers: { shift, alt: false } });
const gesture = () => getCommandRuntime().gesture as GridPlaceGesture;
const ctx = () => getCommandRuntime().ctx as CommandContext;
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const click = (x: number, y: number) => act(() => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); });
const index = (id: string) => GRID_PLACE.fields!.findIndex((f) => f.id === id);

function live(type: string) {
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  return view.getNewEntities().filter((e) => e.type.toUpperCase() === type && !view.isDeleted(e.expressId));
}

/** The tags of a grid's axes, per family, read back from the written IfcGridAxis records. */
function tags(): { u: string[]; v: string[] } {
  const [grid] = live('IFCGRID');
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  const tagsOf = (list: unknown) => (list as string[]).map((ref) => String(view.getNewEntity(Number(ref.slice(1)))!.attributes[0]));
  return { u: tagsOf(grid.attributes[7]), v: tagsOf(grid.attributes[8]) };
}

let restoreRemesh: () => void = () => {};

beforeEach(async () => {
  await seedModelingSession();
  resetGridSettings();
  restoreRemesh = setRequestRemesh(() => {});
  useViewerStore.getState().startCommand('grid.place');
});
afterEach(() => {
  restoreRemesh();
  useViewerStore.getState().exitModelWorkspace();
  cleanup();
});

describe('axisOffsets (#6232 D3)', () => {
  it('runs at the spacing and closes on the far side', () => {
    assert.deepEqual(axisOffsets(12, 6), [0, 6, 12]);
    assert.deepEqual(axisOffsets(13, 6), [0, 6, 12, 13]);
    assert.deepEqual(axisOffsets(4, 6), [0, 4]);
  });
});

describe('axisCount (#6232 D3)', () => {
  it('counts what axisOffsets makes, without making it', () => {
    for (const [extent, spacing] of [[12, 6], [13, 6], [4, 6], [10, 3], [0.7, 0.1]] as const) {
      assert.equal(axisCount(extent, spacing), axisOffsets(extent, spacing).length, `${extent} at ${spacing}`);
    }
  });
});

describe('grid.place (#6232 D3)', () => {
  it('two corners write a tagged grid as one undo step', () => {
    const before = undoDepth();
    click(0, 0);
    click(12, 8);
    assert.equal(live('IFCGRID').length, 1);
    // 12 m at 6 m spacing: 1, 2, 3 across; 8 m at 6 m: A, B and the closing axis C at 8 m.
    assert.deepEqual(tags(), { u: ['1', '2', '3'], v: ['A', 'B', 'C'] });
    assert.equal(live('IFCGRIDAXIS').length, 6);
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(live('IFCGRID').length, 0);
    assert.equal(live('IFCGRIDAXIS').length, 0);
    assert.equal(undoDepth(), before);
  });

  it('the letters scheme swaps the tags, and it and the spacing carry to the next grid', () => {
    act(() => { updateCommandGesture((g) => withGridSettings(g as GridPlaceGesture, { tags: 'letters', spacingU: 5, spacingV: 4 })); });
    click(0, 0);
    click(10, 8);
    // 10 m at 5 m: A, B, C across; 8 m at 4 m: 1, 2, 3 down.
    assert.deepEqual(tags(), { u: ['A', 'B', 'C'], v: ['1', '2', '3'] });
    assert.equal(gesture().tags, 'letters');
    assert.equal(gesture().spacingU, 5);
    assert.equal(gesture().points.length, 0, 'the next grid starts fresh');
  });

  it('typed Width, Depth and spacing size the grid', () => {
    click(1, 1);
    act(() => {
      writeCommandField(index('width'), 10);
      writeCommandField(index('depth'), 6);
      writeCommandField(index('spacingU'), 5);
      writeCommandField(index('spacingV'), 3);
    });
    act(() => { commandPointerMove(at(3, 3)); commandPointerDown(at(3, 3)); });
    // 10 m at 5 m: 3 U axes; 6 m at 3 m: 3 V axes.
    assert.equal(live('IFCGRIDAXIS').length, 6);
  });

  it('the ghost is one strip per axis of the grid that is written', () => {
    click(0, 0);
    act(() => { commandPointerMove(at(12, 8)); });
    const [mesh] = GRID_PLACE.ghost!(gesture(), ctx());
    assert.equal(mesh.indices.length / 3, 6 * 12);
  });

  it('refuses a spacing that would make too many axes without enumerating them', () => {
    click(0, 0);
    act(() => { writeCommandField(index('spacingU'), 1e-12); commandPointerMove(at(100, 50)); });
    const started = Date.now();
    const verdict = GRID_PLACE.validate!(gesture(), ctx());
    assert.ok(Date.now() - started < 500, 'validation returns at once');
    assert.deepEqual(verdict, { ok: false, reasonKey: 'grid.tooManyAxes' });
    assert.deepEqual(GRID_PLACE.ghost!(gesture(), ctx()), []);
  });

  it('refuses a grid with no area, writing nothing', () => {
    const before = undoDepth();
    click(0, 0);
    click(0, 0);
    assert.equal(undoDepth(), before);
    assert.equal(live('IFCGRID').length, 0);
  });

  it('places the grid on the session storey', () => {
    useViewerStore.getState().setSessionStorey(UPPER_STOREY);
    click(0, 0);
    click(6, 6);
    const spatial = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!.spatialHierarchy;
    assert.equal(spatial?.elementToStorey.get(live('IFCGRID')[0].expressId), UPPER_STOREY);
  });
});

describe('the placed grid is a snap target (#6232 D3)', () => {
  const solve = (local: [number, number], anchor: [number, number] | null = null) => solveSnap(
    { cursor: local, metresPerPixel: 0.01, anchor, chain: [], modifiers: { shift: false, alt: false }, locks: {} },
    modelSnapSources(MODEL_ID),
    MODELING_SNAP_PROFILE,
  );

  it('a cursor near a grid crossing lands on it with the grid glyph; off the storey it is not offered', () => {
    click(2, 3);
    click(14, 11);
    // Grid origin (2, 3): the crossing of U 2 (x = 8) and V B (y = 9) is (8, 9).
    useViewerStore.getState().startCommand('column.place');
    const snapped = solve([8.05, 9.04]);
    assert.equal(snapped.winner?.kind, 'gridIntersection');
    assert.deepEqual(snapped.local, [8, 9]);
    assert.equal(glyphFor(snapped), 'grid');
    // Away from every crossing and axis: free.
    assert.equal(solve([5, 6]).winner, null);
    // On an axis, between crossings: the axis.
    const onAxis = solve([8.03, 6]);
    assert.equal(onAxis.winner?.kind, 'edge');
    assert.equal(onAxis.local[0], 8);

    act(() => { useViewerStore.getState().setSessionStorey(UPPER_STOREY); });
    assert.equal(solve([8.05, 9.04]).winner, null, "the ground storey's grid is not on the upper storey");
    act(() => { useViewerStore.getState().setSessionStorey(STOREY); });
    assert.equal(solve([8.05, 9.04]).winner?.kind, 'gridIntersection');
  });

  it('an undone grid is no longer a target', () => {
    click(2, 3);
    click(14, 11);
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(solve([8.05, 9.04]).winner, null);
  });
});
