/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4857 PR A review — `pushCreateEntityUndo` must key `undoStacks` /
 * `redoStacks` / `dirtyModels` (and the pushed `Mutation.modelId`) under the
 * SAME id `getOrCreateMutationView` registers the `MutablePropertyView`
 * under (`normalizeMutationModelId`'s `__legacy__` alias for a single-model /
 * no-real-id session) — the undo/redo apply path resolves the view via
 * `state.mutationViews.get(modelId)`, so a mismatch here means a legacy-
 * session cost create pushes an undo entry the apply path can never find a
 * view for.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pushCreateEntityUndo } from './mutation-cost-undo.js';

type PushFn = typeof pushCreateEntityUndo;
type SetArg = Parameters<PushFn>[0];

function fakeState(models: Map<string, unknown>) {
  return {
    models,
    undoStacks: new Map<string, unknown[]>(),
    redoStacks: new Map<string, unknown[]>(),
    dirtyModels: new Set<string>(),
    mutationVersion: 0,
  };
}

describe('pushCreateEntityUndo normalises modelId', () => {
  it('a single-model ("legacy") session keys undoStacks under the normalised __legacy__ id, not the raw "legacy"/"default" one', () => {
    let state = fakeState(new Map()); // models.size === 0 → the legacy case
    const set: SetArg = (updater) => {
      const partial = typeof updater === 'function' ? updater(state as never) : updater;
      state = { ...state, ...(partial as Partial<typeof state>) };
    };
    pushCreateEntityUndo(set, 'legacy', 42, 'IFCCOSTITEM');

    assert.equal(state.undoStacks.has('legacy'), false);
    const stack = state.undoStacks.get('__legacy__');
    assert.equal(stack?.length, 1);
    assert.equal((stack![0] as { modelId: string }).modelId, '__legacy__');
    assert.equal(state.dirtyModels.has('__legacy__'), true);
  });

  it('a real multi-model session keys undoStacks under the model id unchanged', () => {
    let state = fakeState(new Map([['m1', {}]]));
    const set: SetArg = (updater) => {
      const partial = typeof updater === 'function' ? updater(state as never) : updater;
      state = { ...state, ...(partial as Partial<typeof state>) };
    };
    pushCreateEntityUndo(set, 'm1', 42, 'IFCCOSTITEM');

    const stack = state.undoStacks.get('m1');
    assert.equal(stack?.length, 1);
    assert.equal(state.dirtyModels.has('m1'), true);
  });
});
