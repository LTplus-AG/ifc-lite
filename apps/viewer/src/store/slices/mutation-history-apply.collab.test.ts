/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo and redo tell the collab room what they left, as the forward edit does (#10695). Without the mirror, a
 * peer keeps the value the local user just undid.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import type { ViewerState } from '../index.js';
import { applyRedoToView, applyUndoToView } from './mutation-history-apply.js';

function harness() {
  const mirrored: unknown[][] = [];
  const state = {
    mirrorPropertyEdit: (...args: unknown[]) => { mirrored.push(['edit', ...args]); },
    mirrorPropertyDelete: (...args: unknown[]) => { mirrored.push(['delete', ...args]); },
    mirrorAttributeEdit: (...args: unknown[]) => { mirrored.push(['attribute', ...args]); },
    mutationMeshTranslations: new Map(),
  };
  const get = () => state as unknown as ViewerState;
  const set = () => {};
  return { mirrored, undo: (view: MutablePropertyView, m: Mutation) => applyUndoToView(get, set, 'm1', view, m),
    redo: (view: MutablePropertyView, m: Mutation) => applyRedoToView(get, set, 'm1', view, m) };
}

describe('undo and redo mirror property edits to the collab room (#10695)', () => {
  it('undoing an update mirrors the restored value, redoing it mirrors the new one', () => {
    const view = new MutablePropertyView(null, 'm1');
    view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'REI30', PropertyValueType.String);
    const update = view.setProperty(1, 'Pset_WallCommon', 'FireRating', 'REI60', PropertyValueType.String);
    const { mirrored, undo, redo } = harness();
    undo(view, update);
    redo(view, update);
    assert.deepEqual(mirrored, [
      ['edit', 'm1', 1, 'Pset_WallCommon', 'FireRating', 'REI30', PropertyValueType.String],
      ['edit', 'm1', 1, 'Pset_WallCommon', 'FireRating', 'REI60', PropertyValueType.String],
    ]);
  });

  it('undoing a create mirrors a removal, and a deleted property comes back on undo', () => {
    const view = new MutablePropertyView(null, 'm1');
    const create = view.setProperty(2, 'Pset_Custom', 'Note', 'removed', PropertyValueType.String);
    const { mirrored, undo, redo } = harness();
    undo(view, create);
    redo(view, create);
    const remove = view.deleteProperty(2, 'Pset_Custom', 'Note');
    assert.ok(remove);
    undo(view, remove);
    redo(view, remove);
    assert.deepEqual(mirrored, [
      ['delete', 'm1', 2, 'Pset_Custom', 'Note'],
      // A value that happens to read 'removed' is still a value.
      ['edit', 'm1', 2, 'Pset_Custom', 'Note', 'removed', PropertyValueType.String],
      ['edit', 'm1', 2, 'Pset_Custom', 'Note', 'removed', PropertyValueType.String],
      ['delete', 'm1', 2, 'Pset_Custom', 'Note'],
    ]);
  });

  it('undo and redo of a named attribute edit mirror the restored and the new value', () => {
    const view = new MutablePropertyView(null, 'm1');
    const rename = view.setAttribute(3, 'Name', 'New name', 'Old name');
    const { mirrored, undo, redo } = harness();
    undo(view, rename);
    redo(view, rename);
    assert.deepEqual(mirrored, [['attribute', 'm1', 3, 'Name', 'Old name'], ['attribute', 'm1', 3, 'Name', 'New name']]);
  });
});
