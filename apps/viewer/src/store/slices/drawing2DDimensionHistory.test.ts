/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo/redo for 2D dimensions: each command kind, redo cleared by a new
 * command, the cap, replay not recording, unusable dimensions never entering
 * history, and the scope rule (history follows the live markup: cleared on an
 * active-model change, a removal of the active model and a session reset).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createDrawing2DSlice, type Drawing2DSlice } from './drawing2DSlice.js';
import type { Dimension2D } from './drawing2DDimensions.js';
import { canRedoDimension2D, canUndoDimension2D, MAX_DIMENSION_2D_HISTORY, rebaseDimensionHistory } from './drawing2DDimensionHistory.js';
import { unionById } from '../../hooks/drawingPersistenceKey.js';
import { __resetLiveMarkupCacheForTests } from './drawing2DSlice.markupTransition.js';
import { useViewerStore } from '../index.js';
import type { FederatedModel } from '../types.js';

const makeStore = () => createStore<Drawing2DSlice>(createDrawing2DSlice);
const dim = (id: string, patch: Partial<Dimension2D> = {}): Dimension2D => ({
  id, a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, offset: 0.5, orientation: 'aligned', ...patch,
});
const ids = (list: { id: string }[]) => list.map((d) => d.id);

describe('dimension history commands', () => {
  it('records add, update, remove and clear with before/after snapshots', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('a'));
    s.getState().updateDimension2D('a', { offset: 2 });
    s.getState().removeDimension2D('a');
    s.getState().addDimension2D(dim('b'));
    s.getState().clearDimensions2D();
    const kinds = s.getState().dimension2DUndo.map((c) => c.kind);
    assert.deepEqual(kinds, ['add', 'update', 'remove', 'add', 'clear']);
    const [add, update, remove, , clear] = s.getState().dimension2DUndo;
    assert.deepEqual([ids(add.before), ids(add.after)], [[], ['a']]);
    assert.deepEqual([update.before[0].offset, update.after[0].offset], [0.5, 2]);
    assert.deepEqual([ids(remove.before), ids(remove.after)], [['a'], []]);
    assert.deepEqual([ids(clear.before), ids(clear.after)], [['b'], []]);
  });

  it('completing a placement records an add', () => {
    const s = makeStore();
    s.getState().addDimension2DPoint({ x: 0, y: 0 });
    s.getState().addDimension2DPoint({ x: 4, y: 0 });
    const id = s.getState().completeDimension2D({ offset: 1, orientation: 'aligned' });
    assert.ok(id);
    assert.deepEqual(s.getState().dimension2DUndo.map((c) => c.kind), ['add']);
    s.getState().undoDimension2D();
    assert.deepEqual(s.getState().dimensions2D, []);
    s.getState().redoDimension2D();
    assert.deepEqual(ids(s.getState().dimensions2D), [id]);
  });

  it('undoes and redoes every kind; undoing a clear restores everything', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('a'));
    s.getState().addDimension2D(dim('b'));
    s.getState().updateDimension2D('a', { offset: 3, text: 'x <>' });
    s.getState().removeDimension2D('b');
    s.getState().addDimension2D(dim('c'));
    s.getState().clearDimensions2D();
    const final = structuredClone(s.getState().dimensions2D);
    assert.deepEqual(final, []);
    s.getState().undoDimension2D(); assert.deepEqual(ids(s.getState().dimensions2D), ['a', 'c'], 'clear undone');
    s.getState().undoDimension2D(); assert.deepEqual(ids(s.getState().dimensions2D), ['a'], 'add undone');
    s.getState().undoDimension2D(); assert.deepEqual(ids(s.getState().dimensions2D), ['a', 'b'], 'remove undone');
    s.getState().undoDimension2D(); assert.deepEqual([s.getState().dimensions2D[0].offset, s.getState().dimensions2D[0].text], [0.5, undefined], 'update undone');
    s.getState().undoDimension2D(); s.getState().undoDimension2D();
    assert.deepEqual(s.getState().dimensions2D, []);
    assert.equal(canUndoDimension2D(s.getState()), false);
    for (let i = 0; i < 6; i++) s.getState().redoDimension2D();
    assert.deepEqual(s.getState().dimensions2D, final);
    assert.equal(canRedoDimension2D(s.getState()), false);
  });

  it('history holds copies: a later edit never rewrites a stored snapshot', () => {
    const s = makeStore();
    const source = dim('a');
    s.getState().addDimension2D(source);
    source.a.x = 99;
    s.getState().updateDimension2D('a', { offset: 7 });
    s.getState().undoDimension2D();
    assert.equal(s.getState().dimensions2D[0].a.x, 0);
    s.getState().undoDimension2D();
    s.getState().redoDimension2D();
    assert.equal(s.getState().dimensions2D[0].a.x, 0, 'redo restores what was added, not the caller\'s later mutation');
  });

  it('the selectors follow the stacks', () => {
    const s = makeStore();
    assert.deepEqual([canUndoDimension2D(s.getState()), canRedoDimension2D(s.getState())], [false, false]);
    s.getState().addDimension2D(dim('a'));
    assert.deepEqual([canUndoDimension2D(s.getState()), canRedoDimension2D(s.getState())], [true, false]);
    s.getState().undoDimension2D();
    assert.deepEqual([canUndoDimension2D(s.getState()), canRedoDimension2D(s.getState())], [false, true]);
  });

  it('undo and redo with empty stacks do nothing', () => {
    const s = makeStore();
    const before = s.getState().dimensions2D;
    s.getState().undoDimension2D(); s.getState().redoDimension2D();
    assert.equal(s.getState().dimensions2D, before);
  });

  it('a new command clears redo', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('a')); s.getState().addDimension2D(dim('b'));
    s.getState().undoDimension2D();
    assert.equal(s.getState().dimension2DRedo.length, 1);
    s.getState().updateDimension2D('a', { offset: 9 });
    assert.equal(s.getState().dimension2DRedo.length, 0);
    s.getState().undoDimension2D();
    s.getState().removeDimension2D('a');
    assert.equal(s.getState().dimension2DRedo.length, 0, 'remove clears it too');
    s.getState().undoDimension2D();
    s.getState().clearDimensions2D();
    assert.equal(s.getState().dimension2DRedo.length, 0, 'clear clears it too');
  });

  it('caps the undo stack, dropping the oldest commands', () => {
    const s = makeStore();
    for (let i = 0; i < MAX_DIMENSION_2D_HISTORY + 25; i++) s.getState().addDimension2D(dim(`d${i}`));
    assert.equal(s.getState().dimension2DUndo.length, MAX_DIMENSION_2D_HISTORY);
    assert.equal(s.getState().dimensions2D.length, MAX_DIMENSION_2D_HISTORY + 25, 'live state is not capped');
    for (let i = 0; i < MAX_DIMENSION_2D_HISTORY + 10; i++) s.getState().undoDimension2D();
    assert.equal(s.getState().dimensions2D.length, 25, 'only the newest 100 commands could be undone');
    assert.equal(s.getState().dimension2DRedo.length, MAX_DIMENSION_2D_HISTORY);
  });

  it('replay never records: stack sizes only move between the stacks', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('a')); s.getState().addDimension2D(dim('b'));
    s.getState().undoDimension2D();
    assert.deepEqual([s.getState().dimension2DUndo.length, s.getState().dimension2DRedo.length], [1, 1]);
    s.getState().redoDimension2D();
    assert.deepEqual([s.getState().dimension2DUndo.length, s.getState().dimension2DRedo.length], [2, 0]);
  });

  it('undoing the selected dimension\'s add clears the selection; other selections stay', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('a'));
    s.getState().setSelectedAnnotation2D({ type: 'dimension', id: 'a' });
    s.getState().undoDimension2D();
    assert.equal(s.getState().selectedAnnotation2D, null);
    s.getState().redoDimension2D();
    s.getState().setSelectedAnnotation2D({ type: 'measure', id: 'm' });
    s.getState().undoDimension2D();
    assert.equal(s.getState().selectedAnnotation2D?.id, 'm');
  });

  it('in-progress points are not history and survive an undo', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('a'));
    s.getState().addDimension2DPoint({ x: 1, y: 1 });
    assert.equal(s.getState().dimension2DUndo.length, 1);
    s.getState().undoDimension2D();
    assert.deepEqual(s.getState().dimension2DPoints, [{ x: 1, y: 1 }]);
    s.getState().cancelDimension2D();
    assert.equal(s.getState().dimension2DRedo.length, 1, 'cancel is not a command');
  });

  it('a finished drag is one update, committed from the list the drag began with', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('a'));
    const began = s.getState().dimensions2D;
    s.getState().moveAnnotation2D({ type: 'dimension', id: 'a' }, { x: 1, y: 1 });
    s.getState().moveAnnotation2D({ type: 'dimension', id: 'a' }, { x: 2, y: 3 });
    assert.equal(s.getState().dimension2DUndo.length, 1, 'moves while dragging do not record');
    s.getState().commitDimension2DMove(began);
    assert.deepEqual(s.getState().dimension2DUndo.map((c) => c.kind), ['add', 'update']);
    s.getState().commitDimension2DMove(s.getState().dimensions2D);
    assert.equal(s.getState().dimension2DUndo.length, 2, 'a drag that moved nothing records nothing');
    s.getState().undoDimension2D();
    assert.deepEqual(s.getState().dimensions2D[0].a, { x: 0, y: 0 });
  });

  it('deleting the selected dimension is recorded and undoable', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('a'));
    s.getState().setSelectedAnnotation2D({ type: 'dimension', id: 'a' });
    s.getState().deleteSelectedAnnotation2D();
    assert.deepEqual(s.getState().dimension2DUndo.map((c) => c.kind), ['add', 'remove']);
    s.getState().undoDimension2D();
    assert.deepEqual(ids(s.getState().dimensions2D), ['a']);
  });
});

describe('dimensions that never enter history', () => {
  it('refuses unusable adds, updates and completions without recording', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('good'));
    const recorded = s.getState().dimension2DUndo;
    s.getState().addDimension2D(dim('nan', { offset: Number.NaN }));
    s.getState().addDimension2D(dim('inf', { a: { x: Number.POSITIVE_INFINITY, y: 0 } }));
    s.getState().addDimension2D(dim('zero', { b: { x: 0, y: 0 } }));
    s.getState().addDimension2D(dim('flat', { orientation: 'vertical' }));
    s.getState().addDimension2D(dim('bad-orientation', { orientation: 'diagonal' as never }));
    s.getState().updateDimension2D('good', { orientation: 'vertical' });
    s.getState().updateDimension2D('good', { offset: Number.NaN });
    s.getState().addDimension2DPoint({ x: 1, y: 1 });
    s.getState().addDimension2DPoint({ x: 1, y: 1 });
    assert.equal(s.getState().completeDimension2D({ offset: 1, orientation: 'aligned' }), null);
    assert.equal(s.getState().dimension2DUndo, recorded, 'nothing was recorded');
    assert.deepEqual(ids(s.getState().dimensions2D), ['good']);
  });

  it('no-op edits do not record: unknown ids, unchanged updates, clearing an empty list', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('a'));
    const recorded = s.getState().dimension2DUndo;
    s.getState().updateDimension2D('missing', { offset: 3 });
    s.getState().updateDimension2D('a', { offset: 0.5 });
    s.getState().removeDimension2D('missing');
    s.getState().clearDimensions2D();
    assert.equal(s.getState().dimension2DUndo.length, 2, 'only the real clear was recorded');
    s.getState().clearDimensions2D();
    assert.equal(s.getState().dimension2DUndo.length, 2, 'clearing nothing records nothing');
    assert.notEqual(recorded, s.getState().dimension2DUndo);
  });
});

describe('dimension history scope', () => {
  const model = (id: string) => ({ id, name: id, visible: true, idOffset: 0 } as unknown as FederatedModel);
  beforeEach(() => {
    __resetLiveMarkupCacheForTests();
    useViewerStore.getState().resetViewerState();
    useViewerStore.setState({ models: new Map([['A', model('A')], ['B', model('B')]]), activeModelId: 'A' });
  });
  const seed = () => {
    useViewerStore.getState().addDimension2D(dim('a'));
    useViewerStore.getState().addDimension2D(dim('b'));
    useViewerStore.getState().undoDimension2D();
    const { dimension2DUndo, dimension2DRedo } = useViewerStore.getState();
    assert.ok(dimension2DUndo.length > 0 && dimension2DRedo.length > 0, 'both stacks hold something');
  };

  it('a session reset clears both stacks', () => {
    seed();
    useViewerStore.getState().resetViewerState();
    assert.deepEqual([useViewerStore.getState().dimension2DUndo, useViewerStore.getState().dimension2DRedo], [[], []]);
  });

  it('switching the active model clears history, and A\'s dimensions come back without it', () => {
    seed();
    useViewerStore.getState().setActiveModel('B');
    assert.deepEqual([useViewerStore.getState().dimension2DUndo, useViewerStore.getState().dimension2DRedo], [[], []]);
    useViewerStore.getState().setActiveModel('A');
    assert.deepEqual(ids(useViewerStore.getState().dimensions2D), ['a']);
    useViewerStore.getState().undoDimension2D();
    assert.deepEqual(ids(useViewerStore.getState().dimensions2D), ['a'], 'B\'s empty history cannot undo A\'s dimension away');
  });

  it('removing the active model clears history', () => {
    seed();
    useViewerStore.getState().removeModel('A');
    assert.equal(useViewerStore.getState().activeModelId, 'B');
    assert.deepEqual([useViewerStore.getState().dimension2DUndo, useViewerStore.getState().dimension2DRedo], [[], []]);
  });

  it('removing a model that is not active keeps the active model\'s history', () => {
    seed();
    useViewerStore.getState().removeModel('B');
    assert.equal(useViewerStore.getState().dimension2DUndo.length, 1);
    assert.equal(useViewerStore.getState().dimension2DRedo.length, 1);
  });
});

describe('dimension history across a restore', () => {
  it('keeps undo for markup drawn while the restore resolved, without dropping restored entries', () => {
    const s = makeStore();
    s.getState().addDimension2D(dim('meanwhile'));
    // The restore unites the stored entry with the live list and rebases history the same way.
    const stored = [dim('saved-1'), dim('saved-2')];
    const live = s.getState();
    s.setState({
      dimensions2D: unionById(stored, live.dimensions2D),
      dimension2DUndo: rebaseDimensionHistory(live.dimension2DUndo, (snap) => unionById(stored, snap)),
      dimension2DRedo: rebaseDimensionHistory(live.dimension2DRedo, (snap) => unionById(stored, snap)),
    });
    assert.deepEqual(ids(s.getState().dimensions2D), ['saved-1', 'saved-2', 'meanwhile']);
    assert.equal(canUndoDimension2D(s.getState()), true);
    s.getState().undoDimension2D();
    assert.deepEqual(ids(s.getState().dimensions2D), ['saved-1', 'saved-2']);
    s.getState().redoDimension2D();
    assert.deepEqual(ids(s.getState().dimensions2D), ['saved-1', 'saved-2', 'meanwhile']);
  });
});
