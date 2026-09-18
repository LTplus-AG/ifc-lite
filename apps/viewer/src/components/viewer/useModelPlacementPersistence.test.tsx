/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { displayedTranslation, emptyPlacementState, importPlacements } from '@/lib/model-placement/state';
import { saveWorkspacePlacements, restoreWorkspacePlacements, placementFrameKey } from '@/lib/model-placement/persistence';
import { useModelPlacementPersistence } from './useModelPlacementPersistence';

const model = (id: string) => ({ ...fixtureModel(id), sourceContentHash: 'same-source' });
function Harness() {
  useModelPlacementPersistence();
  const placement = useViewerStore((state) => state.modelPlacement);
  return <output>{displayedTranslation(placement, 'first').join(',')}</output>;
}
function addDuplicate() {
  act(() => useViewerStore.setState((state) => ({ models: new Map([...state.models, ['second', model('second')]]) })));
}
beforeEach(() => {
  localStorage.clear();
  const state = { ...useViewerStore.getState(), ...fixtureModels(model('saved')), modelPlacement: emptyPlacementState() };
  state.modelPlacement = importPlacements(state.modelPlacement, new Map([['saved', { translation: [25, 0, 0], locked: false }]]));
  saveWorkspacePlacements(localStorage, state);
  useViewerStore.setState({ ...fixtureModels(model('first')), modelPlacement: emptyPlacementState(), repositionOpen: false });
});
afterEach(() => { cleanup(); localStorage.clear(); });

it('revokes a previously restored offset when a second source copy makes automatic binding ambiguous (#4226)', () => {
  const ui = render(<Harness />);
  assert.equal(ui.textContent, '25,0,0');
  addDuplicate();
  assert.equal(ui.textContent, '0,0,0');
  assert.deepEqual(displayedTranslation(useViewerStore.getState().modelPlacement, 'second'), [0, 0, 0]);
});

it('preserves an explicit user move when a duplicate source arrives (#4226)', () => {
  const ui = render(<Harness />);
  act(() => {
    const state = useViewerStore.getState();
    state.openReposition(['first']); state.previewModelTranslation([3, 0, 0]); state.applyModelTranslation();
  });
  assert.equal(ui.textContent, '28,0,0');
  addDuplicate();
  assert.equal(ui.textContent, '28,0,0');
});

it('cancels an in-flight preview before revoking its ambiguous automatic baseline (#4226)', () => {
  const ui = render(<Harness />);
  act(() => { const state = useViewerStore.getState(); state.openReposition(['first']); state.previewModelTranslation([3, 0, 0]); });
  assert.equal(ui.textContent, '28,0,0');
  addDuplicate();
  assert.equal(ui.textContent, '0,0,0');
  act(() => useViewerStore.getState().applyModelTranslation());
  assert.equal(ui.textContent, '0,0,0', 'a delayed Apply cannot resurrect the revoked automatic offset');
});

it('saves a move made before the background scan identity finishes (#4226)', () => {
  useViewerStore.setState({ ...fixtureModels({ ...model('first'), sourceContentHash: undefined }), modelPlacement: emptyPlacementState() });
  const ui = render(<Harness />);
  act(() => { const state = useViewerStore.getState(); state.openReposition(['first']); state.previewModelTranslation([42, 0, 0]); state.applyModelTranslation(); });
  act(() => useViewerStore.getState().updateModel('first', { sourceContentHash: 'same-source' }));
  assert.equal(ui.textContent, '42,0,0', 'late automatic restoration does not overwrite an explicit move');
  const reloaded = { ...useViewerStore.getState(), ...fixtureModels(model('again')), modelPlacement: emptyPlacementState() };
  assert.deepEqual(restoreWorkspacePlacements(localStorage, reloaded).get('again')?.translation, [42, 0, 0]);
});

/** #4936's fix went through three rounds: first the RTC anchor was folded
 * into `placementFrameKey` for a non-georeferenced workspace, then it turned
 * out THIS hook's restore effect (like the two `modelPlacementSlice.ts`
 * commit actions) cached that computed value into `modelPlacement.frameKey`,
 * so a later convergence appended a second RTC suffix instead of replacing
 * the first. The final fix removes the cache entirely: nothing but an
 * explicit realignment (`commitRealignmentFrame`) ever writes
 * `modelPlacement.realignedFrameKey`, and `placementFrameKey` recomputes the
 * rest fresh from live `state.models` on every call (`persistence.ts`). This
 * case exercises the hook itself (not the pure `state.ts`/`persistence.ts`
 * helpers) through a restore-then-converge sequence, confirming both halves:
 * the hook never touches the pin, and a later convergence is still reflected. */
function coordInfo(wasmRtcOffset?: CoordinateInfo['wasmRtcOffset']): CoordinateInfo {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  return { originShift: { x: 0, y: 0, z: 0 }, originalBounds: box, shiftedBounds: box,
    hasLargeCoordinates: false, ...(wasmRtcOffset ? { wasmRtcOffset } : {}) } as CoordinateInfo;
}
function modelWithAnchor(id: string, anchor?: CoordinateInfo['wasmRtcOffset']) {
  return { ...model(id), geometryResult: { coordinateInfo: coordInfo(anchor) } as unknown as GeometryResult };
}
function setLiveAnchor(anchor: CoordinateInfo['wasmRtcOffset']): void {
  act(() => useViewerStore.setState((state) => {
    const models = new Map(state.models);
    const live = models.get('first')!;
    models.set('first', { ...live, geometryResult: { coordinateInfo: coordInfo(anchor) } as unknown as GeometryResult });
    return { models };
  }));
}

it('a restore made while an RTC anchor is already live never pins the frame, and a later convergence is still reflected (#4936)', () => {
  const anchorX = { x: 111, y: 222, z: 333 };

  // A PRIOR session already converged onto anchor X and saved under that
  // live key ("local-engineering:m:z-up:rtc:{X}"), not the plain base key
  // `beforeEach` saved 'saved' under.
  const priorSession = { ...useViewerStore.getState(), ...fixtureModels(modelWithAnchor('first', anchorX)), modelPlacement: emptyPlacementState() };
  priorSession.modelPlacement = importPlacements(priorSession.modelPlacement, new Map([['first', { translation: [7, 0, 0], locked: false }]]));
  saveWorkspacePlacements(localStorage, priorSession);

  // The CURRENT session mounts with the SAME live anchor already
  // established, so the restore below finds and applies it.
  useViewerStore.setState({ ...fixtureModels(modelWithAnchor('first', anchorX)), modelPlacement: emptyPlacementState(), repositionOpen: false });
  const ui = render(<Harness />);
  assert.equal(ui.textContent, '7,0,0', 'sanity: the restore under the live-anchor key actually found the placement');
  assert.equal(useViewerStore.getState().modelPlacement.realignedFrameKey, null,
    'the restore effect must never write a pin; nothing but an explicit realignment does');

  // A later convergence moves the anchor (`updateModel` bumps `models`,
  // re-running the hook's effect, same as `federationRtcRebase.ts` does for
  // every converged model). Compare against what a session that never
  // restored would compute for the SAME live anchor: the two must agree, or
  // a restore-then-converge session silently drifts from a genuinely fresh
  // single-convergence one.
  const anchorY = { x: 444, y: 555, z: 666 };
  setLiveAnchor(anchorY);
  act(() => useViewerStore.getState().updateModel('first', {}));

  const afterRestoreThenConverge = placementFrameKey(useViewerStore.getState());
  const neverRestored = placementFrameKey({ ...useViewerStore.getState(), modelPlacement: emptyPlacementState() });
  assert.equal(afterRestoreThenConverge, neverRestored,
    'a restore that ran while an anchor was live must not out-live a later convergence to a different one');
});
