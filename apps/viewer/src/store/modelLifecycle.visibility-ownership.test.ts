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
 * So the teardown is scoped by clash's OWN ownership record,
 * `clashVisibilityOwned` (clash slice), content-matched against the live
 * channel by `releaseOwnedClashVisibility` — the same predicate, on the same
 * record, that `useClash`'s run-start release uses.
 *
 * The previous revision inferred ownership from `clashSelectedId` instead, and
 * that inference is wrong in both directions; the running reproductions live in
 * `hooks/useClash.model-teardown-ownership.test.tsx`, which drives the real
 * hook. This file pins the store-level contract underneath them.
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
    clashVisibilityOwned: null,
    ghostExceptEntities: null,
    isolatedEntities: null,
    lensAppliedColors: null,
    pendingColorUpdates: null,
  });
});

/** Seed the shared channel the way `useClash`'s install helpers do: the channel
 *  itself plus the ownership record naming exactly what was installed. Both
 *  writes go through the real store actions. */
function installClashOwned(channel: 'ghost' | 'isolate', ids: number[]): void {
  const s = useViewerStore.getState();
  if (channel === 'isolate') s.setIsolatedEntities(new Set(ids));
  else s.setGhostExceptEntities(new Set(ids));
  const installed =
    channel === 'isolate'
      ? useViewerStore.getState().isolatedEntities
      : useViewerStore.getState().ghostExceptEntities;
  s.setClashVisibilityOwned(installed ? { channel, ids: installed } : null);
}

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

  it('KEEPS a ghost another owner installed even while a clash is SELECTED', () => {
    // The divergence the previous revision's gate could not see: a
    // highlight-mode focus leaves `clashSelectedId` set while owning neither
    // channel, so the next owner's ghost is not clash's to clear.
    useViewerStore.setState({
      clashSelectedId: 'rule-1 modelA:12 modelB:34',
      clashVisibilityOwned: null,
      ghostExceptEntities: new Set<number>([12, 34]),
    });
    useViewerStore.getState().removeModel('modelA');
    assert.notEqual(
      useViewerStore.getState().ghostExceptEntities,
      null,
      'a selection is not an ownership claim — clash disowns both channels in highlight mode',
    );
  });

  it('CLEARS a ghost clash OWNS — that ghost is focusClash\'s', () => {
    useViewerStore.setState({ clashSelectedId: 'rule-1 modelA:12 modelB:34' });
    installClashOwned('ghost', [12, 34]);
    useViewerStore.getState().removeModel('modelA');
    const s = useViewerStore.getState();
    assert.equal(s.ghostExceptEntities, null, 'clash owns this ghost and must release it');
    assert.equal(s.clashVisibilityOwned, null, 'and drop the claim with it');
  });

  it('CLEARS an EMPTY ghost clash owns — the resolved-solid path\'s "ghost everything"', () => {
    // `focusClash`'s solid branch installs `installClashGhost(new Set())`, and
    // a compute that lands after a teardown can leave `clashSelectedId` null
    // while that ghost stands. The ownership record covers it; the previous
    // revision guessed at it from `size === 0`, which would also have thrown
    // away an empty set some OTHER owner installed.
    installClashOwned('ghost', []);
    useViewerStore.setState({ clashSelectedId: null });
    useViewerStore.getState().removeModel('modelA');
    assert.equal(
      useViewerStore.getState().ghostExceptEntities,
      null,
      'an EMPTY ghost set fades the entire scene with nothing solid — the exact #2654 symptom',
    );
  });

  it('CLEARS an isolation clash owns with NO clash selected — selectElement\'s case', () => {
    // `useClash.selectElement` installs a NON-EMPTY isolation and never writes
    // `clashSelectedId`. Left standing, `isEntityVisible` hides everything.
    installClashOwned('isolate', [12]);
    useViewerStore.setState({ clashSelectedId: null });
    useViewerStore.getState().removeModel('modelA');
    assert.equal(useViewerStore.getState().isolatedEntities, null, 'a clash-owned isolation hides the scene');
  });

  it('KEEPS an isolation whose content no longer matches the claim', () => {
    // The user took the channel over after clash installed. The record still
    // names `isolate`, but ownership is decided by CONTENT.
    installClashOwned('isolate', [12]);
    useViewerStore.getState().isolateEntities([10_012]);
    useViewerStore.getState().removeModel('modelA');
    const s = useViewerStore.getState();
    assert.ok(s.isolatedEntities, 'a stale claim must not release someone else\'s isolation');
    assert.deepEqual([...s.isolatedEntities], [10_012], 'and must leave it untouched');
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
    });
    installClashOwned('ghost', []);
    const seq = useViewerStore.getState().clashSolidRequestSeq;

    useViewerStore.getState().removeModel('never-loaded');

    const s = useViewerStore.getState();
    assert.equal(s.clashSelectedId, 'rule-1 modelA:12 modelB:34', 'a no-op removal must not drop the focused clash');
    assert.equal(s.clashSolidStatus, 'solid', 'a no-op removal must not drop the solid');
    assert.equal(s.clashSolidRequestSeq, seq, 'a no-op removal must not invalidate an in-flight compute');
    assert.equal(s.models.size, 2, 'and must not disturb the federation');
  });
});
