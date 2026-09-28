/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A historical model is READ-ONLY.
 *
 * "Returns null" is not on its own enough to assert, and this file does not
 * settle for it: a refused mutation must also leave NO undo entry and NOT
 * mark the model dirty. A gate that refuses the write but still pushes
 * history gives the user an Undo button for something that never happened,
 * and a dirty flag that offers to export edits that do not exist.
 *
 * The sibling `mutationSlice.collab-gate.test.ts` covers the other half of
 * `canEditModel` — the collab role — against the same harness shape.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createMutationSlice, type MutationSlice } from './mutationSlice.js';
import { createHistorySlice, type CommitTag } from './historySlice.js';
import type { ViewerState } from '../index.js';

const MODEL = 'm1';

function commitTag(historical: boolean): CommitTag {
  return {
    provider: 'fixture',
    projectId: 'p1',
    sourceModelId: 'sm1',
    commitId: historical ? 'c1' : 'c3',
    artifactDigest: 'sha256:x',
    historical,
    loadedAt: 1,
  };
}

/** Records every write so a refused mutation can be told from a silent one. */
function makeView() {
  const calls: string[] = [];
  return {
    calls,
    view: {
      setProperty: (...args: unknown[]) => {
        calls.push(`setProperty:${args[0]}`);
        return { id: 'mut-1', type: 'SET_PROPERTY' };
      },
      deleteProperty: () => {
        calls.push('deleteProperty');
        return { id: 'mut-2', type: 'DELETE_PROPERTY' };
      },
      setAttribute: () => {
        calls.push('setAttribute');
        return { id: 'mut-3', type: 'SET_ATTRIBUTE' };
      },
    },
  };
}

function buildSlice(historical: boolean) {
  const spy = makeView();
  let state: Record<string, unknown> = {
    models: new Map(),
    activeModelId: MODEL,
    mutationViews: new Map([[MODEL, spy.view]]),
    undoStacks: new Map(),
    redoStacks: new Map(),
    dirtyModels: new Set(),
    mutationVersion: 0,
    canCollabEdit: () => true,
    commitTags: new Map([[MODEL, commitTag(historical)]]),
    mirrorPropertyEdit: () => {},
    mirrorPropertyDelete: () => {},
    mirrorAttributeEdit: () => {},
  };
  const setState = (partial: unknown) => {
    const patch =
      typeof partial === 'function'
        ? (partial as (s: Record<string, unknown>) => Record<string, unknown>)(state)
        : (partial as Record<string, unknown>);
    state = { ...state, ...patch };
  };
  const getState = () => state as unknown as ViewerState;
  const slice = createMutationSlice(setState as never, getState as never, {} as never) as MutationSlice;
  const history = createHistorySlice(setState as never, getState as never, {} as never);
  state = { ...slice, canEditModel: history.canEditModel, ...state };
  return { spy, state: () => state as unknown as ViewerState & MutationSlice };
}

describe('mutationSlice — a historical model cannot be edited', () => {
  it('setProperty on a past version returns null and writes nothing', () => {
    const { spy, state } = buildSlice(true);
    const result = state().setProperty(MODEL, 42, 'Pset_Test', 'Foo', 'Bar');

    assert.equal(result, null);
    assert.deepEqual(spy.calls, [], 'the mutation view must never be touched');
  });

  it('leaves no undo entry and does not mark the model dirty', () => {
    const { state } = buildSlice(true);
    state().setProperty(MODEL, 42, 'Pset_Test', 'Foo', 'Bar');

    assert.equal(state().undoStacks.get(MODEL) ?? undefined, undefined, 'no undo entry for a write that did not happen');
    assert.equal(state().dirtyModels.has(MODEL), false, 'a past version is not dirty; there is nothing to export');
  });

  it('refuses every property/attribute writer, not just setProperty', () => {
    const { spy, state } = buildSlice(true);
    state().setProperty(MODEL, 42, 'Pset_Test', 'Foo', 'Bar');
    state().deleteProperty(MODEL, 42, 'Pset_Test', 'Foo');
    state().setAttribute(MODEL, 42, 'Name', 'Renamed');
    assert.deepEqual(spy.calls, []);
  });

  it('still allows the same edits on a live version', () => {
    const { spy, state } = buildSlice(false);
    const result = state().setProperty(MODEL, 42, 'Pset_Test', 'Foo', 'Bar');

    assert.notEqual(result, null, 'the gate must not refuse the current version');
    assert.deepEqual(spy.calls, ['setProperty:42']);
    assert.equal(state().dirtyModels.has(MODEL), true);
  });
});
