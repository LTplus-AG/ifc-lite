/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collab role gate on property mutations (PR #1692 review follow-up).
 *
 * In a shared session, only editor/admin may write. The gate must run BEFORE
 * the local MutablePropertyView commit — otherwise a viewer-role user's edit
 * lands in the local view/undo/dirty state but never syncs to the room, and
 * the model silently diverges. Single-user sessions (collab role === null)
 * must be completely unaffected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createMutationSlice, type MutationSlice } from './mutationSlice.js';
import type { ViewerState } from '../index.js';

/** Minimal MutablePropertyView double that records writes. */
function makeViewSpy() {
  const calls: string[] = [];
  const mutation = { id: 'mut_test', type: 'UPDATE_PROPERTY', timestamp: 0, modelId: 'm1', entityId: 1 };
  return {
    calls,
    view: {
      setProperty: (..._a: unknown[]) => { calls.push('setProperty'); return mutation; },
      deleteProperty: (..._a: unknown[]) => { calls.push('deleteProperty'); return mutation; },
      setAttribute: (..._a: unknown[]) => { calls.push('setAttribute'); return mutation; },
      createPropertySet: (..._a: unknown[]) => { calls.push('createPropertySet'); return mutation; },
    },
  };
}

/**
 * Build the mutation slice on a mock combined state with an injectable
 * collab role. Mirrors the buildSlice pattern in uiSlice.edit-mode.test.ts.
 */
function buildSlice(canEdit: boolean) {
  const spy = makeViewSpy();
  let state: Record<string, unknown> = {
    models: new Map(),
    activeModelId: 'm1',
    mutationViews: new Map([['m1', spy.view]]),
    undoStacks: new Map(),
    redoStacks: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
    canCollabEdit: () => canEdit,
    // Mirrors are cross-slice; the gate under test runs before they would.
    mirrorPropertyEdit: () => {},
    mirrorPropertyDelete: () => {},
    mirrorAttributeEdit: () => {},
  };
  const setState = (partial: unknown) => {
    const updates =
      typeof partial === 'function'
        ? (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state)
        : (partial as Record<string, unknown>);
    state = { ...state, ...updates };
  };
  const getState = () => state as unknown as ViewerState;
  const slice = createMutationSlice(
    setState as never,
    getState as never,
    {} as never,
  ) as MutationSlice;
  state = { ...slice, ...state };
  return { spy, state: () => state as unknown as ViewerState & MutationSlice };
}

describe('mutationSlice — collab role gate on property mutations', () => {
  it('viewer role: property writes are rejected BEFORE touching the local view', () => {
    const { spy, state } = buildSlice(false);
    const s = state();
    assert.strictEqual(s.setProperty('m1', 1, 'Pset_Test', 'P', 'v'), null);
    assert.strictEqual(s.deleteProperty('m1', 1, 'Pset_Test', 'P'), null);
    assert.strictEqual(s.setAttribute('m1', 1, 'Name', 'x'), null);
    assert.strictEqual(s.createPropertySet('m1', 1, 'Pset_New', []), null);
    assert.deepStrictEqual(spy.calls, [], 'local view must not be written for a read-only role');
    assert.strictEqual((state() as unknown as { mutationVersion: number }).mutationVersion, 0);
    assert.strictEqual((state() as unknown as { dirtyModels: Set<string> }).dirtyModels.size, 0);
  });

  it('editor/admin (and single-user, role null): property writes commit locally', () => {
    const { spy, state } = buildSlice(true);
    const s = state();
    assert.notStrictEqual(s.setProperty('m1', 1, 'Pset_Test', 'P', 'v'), null);
    assert.notStrictEqual(s.setAttribute('m1', 1, 'Name', 'x'), null);
    assert.deepStrictEqual(spy.calls, ['setProperty', 'setAttribute']);
    assert.ok((state() as unknown as { dirtyModels: Set<string> }).dirtyModels.has('m1'));
  });
});
