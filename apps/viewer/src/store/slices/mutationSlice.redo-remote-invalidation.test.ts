/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * github.com/LTplus-AG/ifc-lite/issues/5223: "Redo silently overwrites a
 * collaborator's edit with a stale local value."
 *
 * Repro shape (from the issue, executed here with a real, stateful
 * `MutablePropertyView` and the real `createMutationSlice`, not a spy):
 * set a property A -> B locally, undo it (B's mutation sits on the redo
 * stack), apply the write a remote peer's collab handler would make to the
 * SAME field, then redo — the peer's value must survive.
 *
 * `collabSlice.ts`'s `onProperty`/`onPropertyDelete`/`onPsetDelete`/
 * `onAttribute`/`onPlacement`/`onEntityDelete` handlers now each call
 * `invalidateRedoForEntity(modelId, entityId)` right after applying the
 * inbound write — this file exercises that mechanism directly (the
 * handlers themselves need a live `CollabSession`/`CollabDocApi` to
 * construct, which is why `collabSlice.gates.test.ts` also stops at the
 * synchronous surface and documents the async half as uncovered).
 * `remoteWrite()` below stands in for "the collab handler ran": it does
 * exactly what each handler does — write the view, then invalidate.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMutationSlice, type MutationSlice } from './mutationSlice.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import type { ViewerState } from '../index.js';

const MODEL = 'm1';

function buildSlice() {
  const view = new MutablePropertyView(null, MODEL);
  let state: Record<string, unknown> = {
    models: new Map(),
    activeModelId: MODEL,
    mutationViews: new Map([[MODEL, view]]),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    mutationMeshTranslations: new Map(),
    removedNewEntities: new Map(),
    removedMeshes: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
    canCollabEdit: () => true,
    mirrorPropertyEdit: () => {},
    mirrorPropertyDelete: () => {},
    mirrorAttributeEdit: () => {},
    mirrorEntityRemove: () => {},
    setPendingMeshTranslations: () => {},
  };
  const setState = (partial: unknown) => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state)
        : (partial as Record<string, unknown>);
    state = { ...state, ...patch };
  };
  const getState = () => state as unknown as ViewerState;
  // `replayAppearanceHistory(api, ...)` keys its coordinated-command registry
  // off `api.getState` by reference; nothing registers against this fake
  // function, so it falls through to the plain undo/redo stacks below.
  const api = { getState, setState, subscribe: () => () => {} };
  const slice = createMutationSlice(setState as never, getState as never, api as never) as MutationSlice;
  state = { ...slice, ...state };
  return {
    view,
    state: () => state as unknown as ViewerState & MutationSlice,
  };
}

/** Stands in for what a `collabSlice` remote-apply handler does: write the
 * room model's view directly (no local undo, no echo — collabSlice.ts's
 * documented contract), then invalidate any queued redo for that entity. */
function remoteApplyProperty(
  s: ViewerState & MutationSlice, view: MutablePropertyView,
  entityId: number, pset: string, prop: string, value: string,
) {
  view.setProperty(entityId, pset, prop, value, PropertyValueType.String);
  s.invalidateRedoForEntity(MODEL, entityId);
}

describe('redo vs. an inbound remote edit (#5223)', () => {
  it('RED/GREEN: redo must not overwrite a peer property write with the stale local value', () => {
    const { view, state } = buildSlice();
    let s = state();

    s.setProperty(MODEL, 1, 'Pset_Test', 'P', 'B');
    s.undo(MODEL);
    assert.equal(view.getPropertyValue(1, 'Pset_Test', 'P'), null, 'undo restored the pre-edit (absent) value');

    // The exact write the collab `onProperty` handler makes for a peer's edit.
    remoteApplyProperty(state(), view, 1, 'Pset_Test', 'P', 'REMOTE');
    assert.equal(view.getPropertyValue(1, 'Pset_Test', 'P'), 'REMOTE', 'peer write landed');

    s = state();
    s.redo(MODEL);

    assert.equal(
      view.getPropertyValue(1, 'Pset_Test', 'P'), 'REMOTE',
      'redo replayed the stale local "B" over the peer\'s "REMOTE" value — this is the defect',
    );
  });

  it('covers UPDATE_ATTRIBUTE, not just UPDATE_PROPERTY', () => {
    const { view, state } = buildSlice();
    let s = state();
    const attrOf = () => view.getAttributeMutationsForEntity(1).find((a) => a.name === 'Name')?.value;

    s.setAttribute(MODEL, 1, 'Name', 'local-name');
    s.undo(MODEL);

    // What the collab `onAttribute` handler does: write, then invalidate.
    view.setAttribute(1, 'Name', 'peer-name');
    state().invalidateRedoForEntity(MODEL, 1);
    assert.equal(attrOf(), 'peer-name', 'peer write landed');

    s = state();
    s.redo(MODEL);

    assert.equal(
      attrOf(), 'peer-name',
      'a redo of an UPDATE_ATTRIBUTE mutation must not clobber the peer write either',
    );
  });

  it('no-regression: ordinary undo/redo with no collab activity is untouched', () => {
    const { view, state } = buildSlice();
    let s = state();

    s.setProperty(MODEL, 1, 'Pset_Test', 'P', 'B');
    s.undo(MODEL);
    assert.equal(view.getPropertyValue(1, 'Pset_Test', 'P'), null);

    s = state();
    s.redo(MODEL);
    assert.equal(view.getPropertyValue(1, 'Pset_Test', 'P'), 'B', 'an ordinary redo with no remote activity still restores B');
  });

  it('no-regression: redo of entity A survives an unrelated remote edit to entity B (per-entity, not wholesale)', () => {
    const { view, state } = buildSlice();
    let s = state();

    s.setProperty(MODEL, 1, 'Pset_Test', 'P', 'B');
    s.undo(MODEL);

    // A peer edits a DIFFERENT entity.
    remoteApplyProperty(state(), view, 2, 'Pset_Test', 'Other', 'peer-on-2');

    s = state();
    s.redo(MODEL);

    assert.equal(
      view.getPropertyValue(1, 'Pset_Test', 'P'), 'B',
      'entity 1\'s redo must survive a remote edit to a different entity',
    );
  });

  it('remote-delete-then-undo: an undo of a local edit does not write onto a tombstone', () => {
    const { view, state } = buildSlice();
    const s = state();

    s.setProperty(MODEL, 1, 'Pset_Test', 'P', 'B');
    assert.equal(view.getPropertyValue(1, 'Pset_Test', 'P'), 'B');

    // A peer deletes the entity (the collab `onEntityDelete` path: a direct
    // view write, outside the undo/redo stacks).
    view.deleteEntity(1);
    assert.equal(view.isDeleted(1), true);

    // Undo of the earlier local edit must not write a property back onto
    // the now-tombstoned entity. A source-buffer tombstone (unlike an
    // overlay-created one) does not purge existing property overlay data
    // (`deleteEntity`'s non-`newEntities` branch), so the correct signal
    // that the write was SKIPPED is that the value is untouched — still
    // 'B' — not that it reverted to the pre-edit 'null' undo would
    // otherwise have written.
    state().undo(MODEL);

    assert.equal(
      view.getPropertyValue(1, 'Pset_Test', 'P'), 'B',
      'undo must not write onto an entity a peer has since deleted — the value must be untouched, not reverted to null',
    );
    assert.equal(view.isDeleted(1), true, 'the tombstone itself is untouched by the skipped undo');
  });
});
