/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The other side of #2654's model-lifecycle teardown: what `removeModel` must
 * NOT destroy.
 *
 * `ghostExceptEntities` / `isolatedEntities` are SHARED channels with four
 * owners besides clash — `useClash.releaseClashVisibility`, `LayerDiffView`,
 * Space Sketch's `useSpaceGhostPreview` (whose comment reads "never clears
 * state it didn't set"), and `syncSourceModel`'s post-removal purge. The last
 * one is a hard contract, not a preference:
 *
 *     syncSourceModel.ts:188   removeModel(modelId);
 *     syncSourceModel.ts:189   purgeStaleEntityState(modelId, replacementId);
 *
 * `purgeStaleEntityState` deliberately KEEPS the part of the user's X-ray /
 * isolation that still belongs to a surviving model and drops only the ids
 * burned with the replaced one. An unconditional clear inside `removeModel`
 * makes that filter dead code on its only production path, and "Sync from
 * source" silently wipes the user's X-ray.
 *
 * So the teardown is scoped by OWNERSHIP EVIDENCE available at the store
 * level: a clash is focused (`clashSelectedId !== null`), or the set is EMPTY
 * — the "ghost everything / hide everything" degenerate state that is clash's
 * resolved-solid signature and that no owner can want to keep (the same
 * reasoning `purgeStaleEntityState` already applies to an emptied isolate
 * set, syncSourceModel.ts:262-264).
 */

import '@/test/setup-dom.js';
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { useViewerStore } from './index.js';
import type { FederatedModel } from './types.js';

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

function model(id: string, idOffset: number): FederatedModel {
  return {
    id,
    name: id,
    fileName: `${id}.ifc`,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    loadedAt: 0,
    idOffset,
    maxExpressId: 1000,
  } as unknown as FederatedModel;
}

beforeEach(() => {
  useViewerStore.setState({
    models: new Map([['modelA', model('modelA', 0)], ['modelB', model('modelB', 10_000)]]),
    activeModelId: 'modelA',
    clashSelectedId: null,
    clashHighlightColors: null,
    clashSolidStatus: 'none',
    ghostExceptEntities: null,
    isolatedEntities: null,
    lensAppliedColors: null,
    pendingColorUpdates: null,
  });
});

describe('removeModel leaves visibility state it does not own (#2654 second review)', () => {
  it('KEEPS a user X-ray when no clash is focused — syncSourceModel purges it afterwards', () => {
    // 12 belongs to modelA (removed), 10_012 to the surviving modelB.
    const ghost = new Set<number>([12, 10_012]);
    useViewerStore.setState({ ghostExceptEntities: ghost });

    useViewerStore.getState().removeModel('modelA');

    assert.notEqual(
      useViewerStore.getState().ghostExceptEntities,
      null,
      'removeModel must not wipe a ghost it does not own — purgeStaleEntityState (syncSourceModel.ts:267-271) filters it to the non-stale part, and an unconditional clear one line earlier makes that dead code',
    );
    assert.deepEqual(
      [...(useViewerStore.getState().ghostExceptEntities ?? new Set())].sort((a, b) => a - b),
      [12, 10_012].sort((a, b) => a - b),
      'removeModel itself does no id filtering — that is the resync purge\'s job',
    );
  });

  it('KEEPS a user isolation when no clash is focused', () => {
    useViewerStore.setState({ isolatedEntities: new Set<number>([12, 10_012]) });
    useViewerStore.getState().removeModel('modelA');
    assert.notEqual(
      useViewerStore.getState().isolatedEntities,
      null,
      'removeModel must not wipe an isolation it does not own — #2662 established that a user isolation survives a clash run, and a federated sibling leaving is no stronger a signal',
    );
  });

  it('CLEARS a ghost when a clash IS focused — that ghost is focusClash\'s', () => {
    useViewerStore.setState({
      clashSelectedId: 'rule-1 modelA:12 modelB:34',
      ghostExceptEntities: new Set<number>([12, 34]),
    });
    useViewerStore.getState().removeModel('modelA');
    assert.equal(useViewerStore.getState().ghostExceptEntities, null, 'a focused clash owns the ghost channel');
  });

  it('CLEARS an EMPTY ghost even with no clash focused — "ghost everything" is never wanted', () => {
    // The resolved-solid path installs `new Set()`, and a run that finished
    // after a teardown can leave the field set with `clashSelectedId` already
    // null. Nothing else installs an empty ghost: `setGhostExceptEntities`
    // maps a falsy argument to null, and the other owners always pass ids.
    useViewerStore.setState({ ghostExceptEntities: new Set<number>() });
    useViewerStore.getState().removeModel('modelA');
    assert.equal(
      useViewerStore.getState().ghostExceptEntities,
      null,
      'an EMPTY ghost set fades the entire scene with nothing solid — the exact #2654 symptom',
    );
  });

  it('CLEARS an EMPTY isolation — it would hide the whole scene', () => {
    useViewerStore.setState({ isolatedEntities: new Set<number>() });
    useViewerStore.getState().removeModel('modelA');
    assert.equal(useViewerStore.getState().isolatedEntities, null, 'an empty isolate set hides everything');
  });

  it('does not touch a paint channel clash never took', () => {
    // Pset / IDS / schedule colouring also drives `pendingColorUpdates`.
    // Restoring `lensAppliedColors` over it on an unrelated model removal
    // would silently switch that colouring off.
    const overlay = new Map<number, [number, number, number, number]>([[10_007, [1, 0, 0, 1]]]);
    useViewerStore.setState({ pendingColorUpdates: overlay });
    useViewerStore.getState().removeModel('modelA');
    assert.equal(
      useViewerStore.getState().pendingColorUpdates,
      overlay,
      'with no clash focused and no pair tint recorded, clash never owned the colour channel',
    );
  });

  it('is a no-op for an unknown / already-removed model id', () => {
    // `syncSourceModel` and the collab teardown can both re-enter with an id
    // that has already gone. Tearing the clash presentation down for a removal
    // that removes nothing is a user-visible side effect of a no-op.
    useViewerStore.setState({
      clashSelectedId: 'rule-1 modelA:12 modelB:34',
      clashSolidStatus: 'solid',
      ghostExceptEntities: new Set<number>(),
    });
    const seq = useViewerStore.getState().clashSolidRequestSeq;

    useViewerStore.getState().removeModel('never-loaded');

    const s = useViewerStore.getState();
    assert.equal(s.clashSelectedId, 'rule-1 modelA:12 modelB:34', 'a no-op removal must not drop the focused clash');
    assert.equal(s.clashSolidStatus, 'solid', 'a no-op removal must not drop the solid');
    assert.equal(s.clashSolidRequestSeq, seq, 'a no-op removal must not invalidate an in-flight compute');
    assert.equal(s.models.size, 2, 'and must not disturb the federation');
  });
});
