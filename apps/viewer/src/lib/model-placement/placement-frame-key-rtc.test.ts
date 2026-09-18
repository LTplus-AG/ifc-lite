/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { saveWorkspacePlacements, restoreWorkspacePlacements, placementFrameKey } from './persistence';
import { emptyPlacementState, importPlacements } from './state';
import { makePlacementManifest, resolvePlacementManifest } from './manifest';

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
function coordInfo(wasmRtcOffset?: CoordinateInfo['wasmRtcOffset']): CoordinateInfo {
  return { originShift: { x: 0, y: 0, z: 0 }, originalBounds: box, shiftedBounds: box,
    hasLargeCoordinates: false, ...(wasmRtcOffset ? { wasmRtcOffset } : {}) } as CoordinateInfo;
}

/** A non-georeferenced (local-engineering) workspace: `selectAnchorGeoref`
 * finds no usable map georef, so `placementFrameKey` falls to the
 * `local-engineering:*` branch under test. */
function localState(rtcOffset?: CoordinateInfo['wasmRtcOffset']) {
  const model = { ...fixtureModel('a'), sourceContentHash: 'source-a', loadedAt: 1,
    geometryResult: { coordinateInfo: coordInfo(rtcOffset) } as unknown as GeometryResult };
  return { ...useViewerStore.getState(), ...fixtureModels(model), modelPlacement: emptyPlacementState() };
}

describe('placementFrameKey distinguishes an RTC convergence (#4936)', () => {
  it('changes when federation convergence re-anchors the scene, and a saved pivot is not reused unshifted', () => {
    const disk = storage(), before = localState(undefined);
    const keyBefore = placementFrameKey(before);
    assert.equal(keyBefore, 'local-engineering:m:z-up');

    // A rotation pivot saved before the convergence: a workspace POINT, only
    // meaningful in the frame it was captured in.
    before.modelPlacement = importPlacements(before.modelPlacement,
      new Map([['a', { translation: [0, 0, 0], rotation: { angle: 0.5, pivot: [10, 0, 5] }, locked: false }]]));
    saveWorkspacePlacements(disk, before);

    // `convergeFederationRtcFrame` (#4897/#4906) stamps every converged
    // model's `coordinateInfo.wasmRtcOffset` with the shared anchor.
    const after = localState({ x: 1234567.891, y: -987654.321, z: 42.75 });
    const keyAfter = placementFrameKey(after);
    assert.notEqual(keyAfter, keyBefore, 'the frame key must change when the RTC anchor moves under the models');

    // The pivot saved under the old frame is not silently handed back under
    // the new one: nothing is found for the converged frame's key.
    assert.equal(restoreWorkspacePlacements(disk, after).size, 0);
  });

  it('refuses loudly when a manifest saved before a convergence is imported after it', () => {
    const before = localState(undefined);
    before.modelPlacement = importPlacements(before.modelPlacement,
      new Map([['a', { translation: [0, 0, 0], rotation: { angle: 0.25, pivot: [3, 0, -2] }, locked: false }]]));
    const manifest = makePlacementManifest(before.models, before.modelPlacement.placements, placementFrameKey(before));

    const after = localState({ x: 100, y: 200, z: 300 });
    assert.throws(() => resolvePlacementManifest(manifest, after.models, placementFrameKey(after)),
      /coordinate frame differs/);
  });

  it('stays the same across an unrelated re-read of an already-converged frame', () => {
    const offset = { x: 5, y: 6, z: 7 };
    assert.equal(placementFrameKey(localState(offset)), placementFrameKey(localState(offset)));
  });
});

/** `applyModelTranslation`/`setModelRotation` cache the BASE identity into
 * `modelPlacement.frameKey` on every commit (`modelPlacementSlice.ts`), and
 * `placementFrameKey` trusts that cache. Review of the first fix for #4936
 * found the cache was never invalidated: once ANY commit stamped it, a LATER
 * convergence (`convergeFederationRtcFrame`, #4897/#4906) rebased the live
 * pivots correctly but the top-level `modelPlacement.frameKey` never moved,
 * so a save after the convergence used the stale pre-convergence key and a
 * restore in a fresh (converged) session found nothing under it.
 *
 * These drive the REAL store actions (`openReposition` / `applyModelTranslation`
 * / `rebasePlacementFrame`), not the pure `state.ts` helpers, because the bug
 * lived specifically in the commit-time caching wired into the store slice:
 * every case above builds `emptyPlacementState()` fresh and never exercises it. */
describe('placementFrameKey does not serve a cache frozen before a convergence (#4936 review)', () => {
  /** Loads a fresh single-model workspace, commits a translation (caching
   * `modelPlacement.frameKey`), then converges: the model's own `CoordinateInfo`
   * picks up `wasmRtcOffset` (what `convergeGeometryOntoRtcAnchor` writes) and
   * `rebasePlacementFrame` runs (what `federationRtcRebase.ts` calls after it),
   * exactly the order production runs them in. Returns the live `placementFrameKey`
   * read afterward, plus the store `disk` the placement was saved to. */
  function committedThenConverged(anchor: CoordinateInfo['wasmRtcOffset']) {
    useViewerStore.setState(localState(undefined));
    const store = useViewerStore.getState();
    store.openReposition(['a']);
    store.previewModelTranslation([3, 0, 0]);
    store.applyModelTranslation();
    assert.equal(useViewerStore.getState().modelPlacement.frameKey, 'local-engineering:m:z-up',
      'sanity: the commit cached the pre-convergence base');

    useViewerStore.setState((s) => {
      const model = s.models.get('a')!;
      const models = new Map(s.models);
      models.set('a', { ...model, geometryResult: { ...model.geometryResult, coordinateInfo: coordInfo(anchor) } as unknown as GeometryResult });
      return { models };
    });
    useViewerStore.getState().rebasePlacementFrame(new Map([['a', { x: 1, y: 2, z: 3 }]]));

    const disk = storage();
    saveWorkspacePlacements(disk, useViewerStore.getState());
    return { disk, key: placementFrameKey(useViewerStore.getState()) };
  }

  it('a placement committed before a convergence still round-trips through save/restore afterward', () => {
    const anchor = { x: 1234567.891, y: -987654.321, z: 42.75 };
    const { disk } = committedThenConverged(anchor);

    // A fresh session (frameKey: null) reloading the same, already-converged
    // workspace: nothing was committed in it yet, so the cache cannot lie.
    // `placementFrameKey` recomputes live from the reloaded model's own
    // (already-anchored) `coordinateInfo`, matching what was actually saved.
    const restored = restoreWorkspacePlacements(disk, localState(anchor)).get('a');
    assert.deepEqual(restored?.translation, [3, 0, 0],
      'the pre-convergence commit must not be dropped by a stale save key');
  });

  it('does not fall back to restoring under the pre-convergence key either', () => {
    const anchor = { x: 1234567.891, y: -987654.321, z: 42.75 };
    const { disk } = committedThenConverged(anchor);
    assert.equal(savedUnder(disk, 'local-engineering:m:z-up'), null,
      'nothing was ever saved under the stale pre-convergence key');
  });

  it('two sessions that each commit before converging match only when they reach the same live anchor', () => {
    const anchorA = { x: 10, y: 20, z: 30 }, anchorB = { x: 40, y: 50, z: 60 };
    assert.equal(committedThenConverged(anchorA).key, committedThenConverged(anchorA).key,
      'same live anchor after independent pre-convergence commits must match');
    assert.notEqual(committedThenConverged(anchorA).key, committedThenConverged(anchorB).key,
      'different live anchors after independent pre-convergence commits must not match');
  });

  it('a SECOND commit, made after a convergence has already happened, still caches only the base', () => {
    const anchorA = { x: 10, y: 20, z: 30 }, anchorB = { x: 40, y: 50, z: 60 };
    committedThenConverged(anchorA);
    // A second commit while the workspace is already converged onto anchor A:
    // if the commit cached the FULL `placementFrameKey` (base + live RTC, the
    // bug this test isolates) instead of just the base, anchor A would be
    // frozen into `modelPlacement.frameKey` here.
    const store = useViewerStore.getState();
    store.openReposition(['a']);
    store.previewModelTranslation([0, 5, 0]);
    store.applyModelTranslation();

    // The federation converges again, this time onto a DIFFERENT anchor.
    useViewerStore.setState((s) => {
      const model = s.models.get('a')!;
      const models = new Map(s.models);
      models.set('a', { ...model, geometryResult: { ...model.geometryResult, coordinateInfo: coordInfo(anchorB) } as unknown as GeometryResult });
      return { models };
    });
    useViewerStore.getState().rebasePlacementFrame(new Map([['a', { x: 4, y: 5, z: 6 }]]));

    assert.equal(useViewerStore.getState().models.get('a')?.geometryResult?.coordinateInfo.wasmRtcOffset, anchorB,
      'sanity: the live anchor is now B, not A');
    assert.equal(placementFrameKey(useViewerStore.getState()), placementFrameKey(localState(anchorB)),
      'a commit made between two convergences must not freeze the FIRST anchor past the SECOND');
  });
});

function savedUnder(disk: ReturnType<typeof storage>, frame: string): string | null {
  return disk.getItem('ifc-lite:placements:v1:' + frame);
}
