/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dimension markup kind in the drawing slice: its actions, selection,
 * delete and move, Clear markup, and that it travels with its model through
 * an active-model switch, a model removal and a session reset like the other
 * committed markup lists.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createDrawing2DSlice, type Drawing2DSlice, type DrawnSectionPlane } from './drawing2DSlice.js';
import {
  isDimension2D,
  isDimensionOnPlane,
  dimensionPlaneStamp,
  exportableDimensions,
  measuredDimensionValue,
  moveDimension2D,
  type Dimension2D,
} from './drawing2DDimensions.js';
import { __resetLiveMarkupCacheForTests } from './drawing2DSlice.markupTransition.js';
import { useViewerStore } from '../index.js';
import type { FederatedModel } from '../types.js';

const makeStore = () => createStore<Drawing2DSlice>(createDrawing2DSlice);

const dim = (id: string, patch: Partial<Dimension2D> = {}): Dimension2D => ({
  id, a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 0.5, orientation: 'aligned', ...patch,
});

const ids = (list: { id: string }[]) => list.map((d) => d.id);

describe('dimension actions', () => {
  it('adds, updates and removes dimensions', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('d1'));
    s.getState().addDimension2D(dim('d2'));
    assert.deepEqual(ids(s.getState().dimensions2D), ['d1', 'd2']);

    s.getState().updateDimension2D('d1', { offset: -1, text: 'W <>' });
    const d1 = s.getState().dimensions2D[0];
    assert.equal(d1.offset, -1);
    assert.equal(d1.text, 'W <>');

    s.getState().removeDimension2D('d1');
    assert.deepEqual(ids(s.getState().dimensions2D), ['d2']);
  });

  it('refuses an add or update that would store unusable geometry', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('bad', { offset: Number.NaN }));
    assert.equal(s.getState().dimensions2D.length, 0, 'a NaN offset is not stored');
    s.getState().addDimension2D(dim('d1'));
    s.getState().updateDimension2D('d1', { a: { x: Number.POSITIVE_INFINITY, y: 0 } });
    assert.equal(s.getState().dimensions2D[0].a.x, 0, 'a non-finite point leaves the dimension as it was');
  });

  it('refuses an add or update that would measure zero, like completing one does', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('flat', { orientation: 'vertical' }));
    assert.equal(s.getState().dimensions2D.length, 0, 'a vertical dimension of horizontally aligned points is not stored');
    s.getState().addDimension2D(dim('d1'));
    s.getState().updateDimension2D('d1', { orientation: 'vertical' });
    assert.equal(s.getState().dimensions2D[0].orientation, 'aligned', 'an update that would measure zero is refused');
  });

  it('places two points, then completes them into a dimension stamped with its plane', () => {
    const s = makeStore();
    const plane = { axis: 'down', position: 40, flipped: false, id: 'live-id', name: 'A' } as unknown as DrawnSectionPlane;
    s.getState().addDimension2DPoint({ x: 1, y: 1 });
    s.getState().addDimension2DPoint({ x: 1, y: 3 });
    s.getState().addDimension2DPoint({ x: 9, y: 9 });
    assert.equal(s.getState().dimension2DPoints.length, 2, 'a third point is ignored: a dimension measures two');

    const id = s.getState().completeDimension2D({ offset: 0.2, orientation: 'vertical', plane });
    assert.ok(id, 'completing returns the new id');
    const [created] = s.getState().dimensions2D;
    assert.equal(created.id, id);
    assert.deepEqual([created.a, created.b], [{ x: 1, y: 1 }, { x: 1, y: 3 }]);
    assert.equal(created.orientation, 'vertical');
    assert.deepEqual(created.plane, { axis: 'down', position: 40, flipped: false }, 'only the plane fields are kept');
    assert.equal(s.getState().dimension2DPoints.length, 0, 'the in-progress points are cleared');
  });

  it('does not create a degenerate dimension, and clears the points anyway', () => {
    const s = makeStore();
    s.getState().addDimension2DPoint({ x: 2, y: 0 });
    s.getState().addDimension2DPoint({ x: 2, y: 5 });
    assert.equal(s.getState().completeDimension2D({ offset: 1, orientation: 'horizontal' }), null,
      'a horizontal dimension between vertically aligned points measures nothing');
    assert.equal(s.getState().dimensions2D.length, 0);
    assert.equal(s.getState().dimension2DPoints.length, 0);
    assert.equal(s.getState().completeDimension2D({ offset: 1, orientation: 'aligned' }), null, 'no points, no dimension');
  });

  it('cancel and a tool switch drop the in-progress points', () => {
    const s = makeStore();
    s.getState().addDimension2DPoint({ x: 0, y: 0 });
    s.getState().cancelDimension2D();
    assert.equal(s.getState().dimension2DPoints.length, 0, 'cancel clears');
    s.getState().setAnnotation2DActiveTool('dimension');
    s.getState().addDimension2DPoint({ x: 0, y: 0 });
    s.getState().setAnnotation2DActiveTool('measure');
    assert.equal(s.getState().dimension2DPoints.length, 0, 'switching tool clears');
    assert.equal(s.getState().annotation2DActiveTool, 'measure');
  });
});

describe('dimension selection, delete and move', () => {
  it('deletes the selected dimension', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('d1'));
    s.getState().addDimension2D(dim('d2'));
    s.getState().setSelectedAnnotation2D({ type: 'dimension', id: 'd1' });
    s.getState().deleteSelectedAnnotation2D();
    assert.deepEqual(ids(s.getState().dimensions2D), ['d2']);
    assert.equal(s.getState().selectedAnnotation2D, null, 'the selection is cleared');
  });

  it('removing the selected dimension by id clears the selection; removing another keeps it', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('d1'));
    s.getState().addDimension2D(dim('d2'));
    s.getState().setSelectedAnnotation2D({ type: 'dimension', id: 'd2' });
    s.getState().removeDimension2D('d1');
    assert.equal(s.getState().selectedAnnotation2D?.id, 'd2');
    s.getState().removeDimension2D('d2');
    assert.equal(s.getState().selectedAnnotation2D, null);
  });

  it('moves a and b together so a lands on the new origin, offset unchanged', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('d1', { a: { x: 1, y: 2 }, b: { x: 5, y: 5 }, offset: -0.75 }));
    s.getState().addDimension2D(dim('d2'));
    s.getState().moveAnnotation2D({ type: 'dimension', id: 'd1' }, { x: 11, y: 12 });
    const [moved, other] = s.getState().dimensions2D;
    assert.deepEqual([moved.a, moved.b], [{ x: 11, y: 12 }, { x: 15, y: 15 }]);
    assert.equal(moved.offset, -0.75);
    assert.deepEqual([other.a, other.b], [{ x: 0, y: 0 }, { x: 4, y: 0 }], 'other dimensions stay');
  });

  it('moveDimension2D returns the same list for an unknown id', () => {
    const list = [dim('d1')];
    assert.equal(moveDimension2D(list, 'nope', { x: 1, y: 1 }) === list, true, 'unchanged by identity');
  });

  it('Clear markup clears dimensions with the rest', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('d1'));
    s.getState().addDimension2DPoint({ x: 0, y: 0 });
    s.getState().setSelectedAnnotation2D({ type: 'dimension', id: 'd1' });
    s.getState().clearAllAnnotations2D();
    assert.equal(s.getState().dimensions2D.length, 0);
    assert.equal(s.getState().dimension2DPoints.length, 0);
    assert.equal(s.getState().selectedAnnotation2D, null);
  });

  it('clearDimensions2D clears only dimensions and a dimension selection', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('d1'));
    s.getState().addMeasure2DResult({ id: 'm1', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, distance: 1 });
    s.getState().setSelectedAnnotation2D({ type: 'measure', id: 'm1' });
    s.getState().clearDimensions2D();
    assert.equal(s.getState().dimensions2D.length, 0);
    assert.equal(s.getState().measure2DResults.length, 1);
    assert.equal(s.getState().selectedAnnotation2D?.type, 'measure', 'another kind\'s selection is kept');
  });
});

describe('measuredDimensionValue', () => {
  it('projects a→b on the orientation', () => {
    const d = { a: { x: 0, y: 0 }, b: { x: 3, y: -4 } };
    assert.equal(measuredDimensionValue({ ...d, orientation: 'aligned' }), 5);
    assert.equal(measuredDimensionValue({ ...d, orientation: 'horizontal' }), 3);
    assert.equal(measuredDimensionValue({ ...d, orientation: 'vertical' }), 4);
  });
});

describe('isDimension2D', () => {
  it('accepts a minimal and a full dimension', () => {
    assert.equal(isDimension2D(dim('d1')), true);
    assert.equal(isDimension2D(dim('d2', {
      text: '<> mm', refs: { a: { globalId: 'g1', ifcType: 'IfcWall' } },
      plane: { axis: 'front', position: 10, flipped: true, custom: { normal: [0, 1, 0], distance: 2 } as DrawnSectionPlane['custom'] },
    })), true);
  });

  it('rejects malformed values', () => {
    const bad: unknown[] = [
      null, 'x', {}, { ...dim('d'), id: '' }, { ...dim('d'), a: { x: 'a', y: 0 } }, { ...dim('d'), offset: null },
      { ...dim('d'), orientation: 'diagonal' }, { ...dim('d'), text: 3 }, { ...dim('d'), plane: { axis: 'down' } },
      { ...dim('d'), plane: { axis: 'down', position: 1, flipped: false, custom: { normal: [0, 1], distance: 1 } } },
      { ...dim('d'), refs: { a: { globalId: 1 } } }, { ...dim('d'), refs: 'r' },
    ];
    bad.forEach((v, i) => assert.equal(isDimension2D(v), false, `case ${i} is rejected`));
  });
});

describe('isDimensionOnPlane', () => {
  const plan: DrawnSectionPlane = { axis: 'down', position: 50, flipped: false };
  it('matches the plane it was stamped with', () => {
    assert.equal(isDimensionOnPlane({ plane: dimensionPlaneStamp(plan) }, plan), true);
  });
  it('is on the current cut without a stamp or without a drawn plane', () => {
    assert.equal(isDimensionOnPlane({}, plan), true, 'no stamp');
    assert.equal(isDimensionOnPlane({ plane: plan }, null), true, 'no drawn plane');
  });
  it('differs by axis, position or flip', () => {
    assert.equal(isDimensionOnPlane({ plane: plan }, { ...plan, axis: 'front' }), false, 'axis');
    assert.equal(isDimensionOnPlane({ plane: plan }, { ...plan, position: 50.5 }), false, 'position');
    assert.equal(isDimensionOnPlane({ plane: plan }, { ...plan, flipped: true }), false, 'flip');
  });
  it('compares a custom plane by normal and distance', () => {
    const custom = { normal: [0, 0, 1], distance: 3, pickedAt: [0, 0, 3], tangent: [1, 0, 0], bitangent: [0, 1, 0] } as DrawnSectionPlane['custom'];
    const face: DrawnSectionPlane = { ...plan, custom };
    assert.equal(isDimensionOnPlane({ plane: dimensionPlaneStamp(face) }, face), true, 'same custom plane');
    assert.equal(isDimensionOnPlane({ plane: face }, { ...face, custom: { ...custom!, distance: 3.1 } }), false, 'moved');
    assert.equal(isDimensionOnPlane({ plane: face }, plan), false, 'custom against cardinal');
  });
  it('a second pick on the same face is another cut (#10076 review)', () => {
    const custom = { normal: [0, 0, 1], distance: 3, pickedAt: [0, 0, 3], tangent: [1, 0, 0], bitangent: [0, 1, 0] } as NonNullable<DrawnSectionPlane['custom']>;
    const face: DrawnSectionPlane = { ...plan, custom };
    const stamp = { plane: dimensionPlaneStamp(face) };
    // Same normal, distance and axes; the frame origin sits 2 m along the tangent.
    assert.equal(isDimensionOnPlane(stamp, { ...face, custom: { ...custom, pickedAt: [2, 0, 3] } }), false, 'second pick');
    // A pick point off the plane along the normal projects onto the same origin.
    assert.equal(isDimensionOnPlane(stamp, { ...face, custom: { ...custom, pickedAt: [0, 0, 5] } }), true, 'same origin on the plane');
    assert.equal(isDimensionOnPlane(stamp, { ...face, custom: { ...custom, tangent: [0, 1, 0], bitangent: [-1, 0, 0] } }), false, 'rotated axes');
    const bare = { plane: { ...plan, custom: { normal: [0, 0, 1], distance: 3 } as NonNullable<DrawnSectionPlane['custom']> } };
    assert.equal(isDimensionOnPlane(bare, face), true, 'a stamp without frame fields still matches by normal and distance');
  });
  it('exports keep only dimensions on the current cut, in order', () => {
    const other: DrawnSectionPlane = { ...plan, position: 53 };
    const list = [dim('here', { plane: plan }), dim('there', { plane: other }), dim('unstamped')];
    assert.deepEqual(ids(exportableDimensions(list, plan)), ['here', 'unstamped']);
    assert.deepEqual(ids(exportableDimensions(list, other)), ['there', 'unstamped']);
    assert.deepEqual(ids(exportableDimensions(list, null)), ['here', 'there', 'unstamped'], 'no drawn plane: nothing to tell apart');
  });
});

describe('dimensions travel with their model', () => {
  const model = (id: string) => ({ id, name: id, visible: true, idOffset: 0 } as unknown as FederatedModel);
  beforeEach(() => {
    __resetLiveMarkupCacheForTests();
    useViewerStore.getState().resetViewerState();
    useViewerStore.setState({ models: new Map([['A', model('A')], ['B', model('B')]]), activeModelId: 'A' });
  });

  it('an A → B → A switch hides A\'s dimensions on B and restores them on A', () => {
    useViewerStore.getState().addDimension2D(dim('dA'));
    useViewerStore.getState().addDimension2DPoint({ x: 1, y: 1 });
    useViewerStore.getState().setActiveModel('B');
    assert.equal(useViewerStore.getState().dimensions2D.length, 0, 'B starts without A\'s dimensions');
    assert.equal(useViewerStore.getState().dimension2DPoints.length, 0, 'an in-progress point does not cross models');
    useViewerStore.getState().setActiveModel('A');
    assert.deepEqual(ids(useViewerStore.getState().dimensions2D), ['dA']);
  });

  it('removing the active model drops its dimensions from the survivor', () => {
    useViewerStore.getState().addDimension2D(dim('dA'));
    useViewerStore.getState().removeModel('A');
    assert.equal(useViewerStore.getState().activeModelId, 'B');
    assert.equal(useViewerStore.getState().dimensions2D.length, 0);
  });

  it('a session reset clears dimensions', () => {
    useViewerStore.getState().addDimension2D(dim('dA'));
    useViewerStore.getState().addDimension2DPoint({ x: 1, y: 1 });
    useViewerStore.getState().resetViewerState();
    assert.equal(useViewerStore.getState().dimensions2D.length, 0);
    assert.equal(useViewerStore.getState().dimension2DPoints.length, 0);
  });
});
