/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `runTransaction` (charter #6232, WP2): a command's commit is ONE undo step
 * however many mutations it writes, and a commit that throws leaves the undo
 * stack, the redo stack and the overlay as they were.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { fixtureModel } from '@/test/store-fixture';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { runTransaction, setRequestRemesh, type RemeshRequest } from './transaction.js';
import type { CommandContext, CommitResult, ModelingCommand } from './types.js';

const ctx: CommandContext = { get: useViewerStore.getState, modelId: MODEL_ID, storeyId: STOREY, workplane: null };

function command(commit: ModelingCommand['commit']): ModelingCommand {
  return {
    id: 'test.tx', labelKey: 'modelingCommand.closeAria', hud: {}, snap: 'modeling',
    init: () => null, pointerMove: (g) => g, pointerDown: (g) => g, commit,
  };
}

const NOTHING: CommitResult = { created: [], deleted: [], remesh: [] };
const undoDepth = () => useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
const redoDepth = () => useViewerStore.getState().redoStacks.get(MODEL_ID)?.length ?? 0;

let view: MutablePropertyView;
let restoreRemesh: () => void;
beforeEach(async () => {
  view = await seedModelingSession();
  // The seam's own contract is tested here; the real service in transaction.remesh.test.ts.
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => restoreRemesh());

describe('runTransaction (#6232 WP2)', () => {
  it('four mutations in one commit are one undo step', () => {
    const outcome = runTransaction(useViewerStore, command((_g, tx) => {
      for (const name of ['A', 'B', 'C', 'D']) tx.store.setProperty(MODEL_ID, STOREY, 'Pset_Test', name, name);
      return NOTHING;
    }), null, ctx);
    assert.equal(outcome.ok, true);
    assert.equal(undoDepth(), 4, 'each setProperty pushed its own mutation');

    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), 0, 'one undo reverted the whole commit');
    assert.equal(redoDepth(), 4);
    useViewerStore.getState().redo(MODEL_ID);
    assert.equal(undoDepth(), 4, 'one redo re-applied it');
  });

  it('keeps an earlier edit a separate undo step', () => {
    useViewerStore.getState().setProperty(MODEL_ID, STOREY, 'Pset_Test', 'Before', 'x');
    runTransaction(useViewerStore, command((_g, tx) => {
      tx.store.setProperty(MODEL_ID, STOREY, 'Pset_Test', 'A', 'a');
      tx.store.setProperty(MODEL_ID, STOREY, 'Pset_Test', 'B', 'b');
      return NOTHING;
    }), null, ctx);
    useViewerStore.getState().undo(MODEL_ID);
    assert.equal(undoDepth(), 1, 'the pre-existing edit survives the commit undo');
  });

  it('a commit that throws leaves the undo stack, redo stack and overlay unchanged', () => {
    useViewerStore.getState().setProperty(MODEL_ID, STOREY, 'Pset_Test', 'Before', 'x');
    useViewerStore.getState().undo(MODEL_ID);
    useViewerStore.getState().setProperty(MODEL_ID, STOREY, 'Pset_Test', 'Kept', 'y');
    const undoBefore = useViewerStore.getState().undoStacks.get(MODEL_ID);
    const redoBefore = useViewerStore.getState().redoStacks.get(MODEL_ID);
    const entitiesBefore = view.getNewEntities().length;

    const outcome = runTransaction(useViewerStore, command((_g, tx) => {
      const wall = tx.store.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
      assert.ok(!('error' in wall), 'the partial write really happened');
      assert.ok(view.getNewEntities().length > entitiesBefore);
      throw new Error('boom');
    }), null, ctx);

    assert.deepEqual(outcome, { ok: false, reason: 'boom' });
    assert.deepEqual(useViewerStore.getState().undoStacks.get(MODEL_ID), undoBefore);
    assert.deepEqual(useViewerStore.getState().redoStacks.get(MODEL_ID), redoBefore);
    assert.equal(view.getNewEntities().length, entitiesBefore, 'the half-built wall is gone from the overlay');
  });

  it('refuses outside edit mode and writes nothing', () => {
    useViewerStore.setState({ editEnabled: false });
    let ran = false;
    const outcome = runTransaction(useViewerStore, command(() => { ran = true; return NOTHING; }), null, ctx);
    assert.equal(outcome.ok, false);
    assert.equal(ran, false);
  });

  it('selects and re-meshes in the model the commit names, not the session model', () => {
    // A split of an element selected in another federated model (#6232 WP2 review).
    const OTHER = 'other';
    const other = { ...fixtureModel(OTHER, { idOffset: 100_000 }), maxExpressId: 1_000 } as unknown as FederatedModel;
    useViewerStore.setState({ models: new Map([...useViewerStore.getState().models, [OTHER, other]]) });
    const requests: RemeshRequest[] = [];
    setRequestRemesh((_get, request) => { requests.push(request); });
    const outcome = runTransaction(useViewerStore, command((_g, tx) => {
      tx.store.setProperty(MODEL_ID, STOREY, 'Pset_Test', 'A', 'a');
      return { modelId: OTHER, created: [7], deleted: [], remesh: [7], select: [7] };
    }), null, ctx);
    assert.ok(outcome.ok);
    assert.equal(requests[0]?.modelId, OTHER);
    const models = useViewerStore.getState().models;
    assert.equal(useViewerStore.getState().selectedEntityId, toGlobalIdFromModels(models, OTHER, 7));
    assert.notEqual(toGlobalIdFromModels(models, OTHER, 7), toGlobalIdFromModels(models, MODEL_ID, 7));
  });

  it('asks the re-mesh seam once, with the batch it tagged', () => {
    const requests: RemeshRequest[] = [];
    setRequestRemesh((_get, request) => { requests.push(request); });
    const outcome = runTransaction(useViewerStore, command((_g, tx) => {
      tx.store.setProperty(MODEL_ID, STOREY, 'Pset_Test', 'A', 'a');
      return { created: [], deleted: [], remesh: [STOREY] };
    }), null, ctx);
    assert.ok(outcome.ok);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], { modelId: MODEL_ID, batchId: outcome.batchId, expressIds: [STOREY], cause: 'shape' });
  });
});
