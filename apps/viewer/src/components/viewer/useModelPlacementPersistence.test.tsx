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

/** The hook's own restore-effect stamps `modelPlacement.frameKey` on every
 * run (`useModelPlacementPersistence.ts`), same as `applyModelTranslation`
 * and `setModelRotation` (`modelPlacementSlice.ts`). Review of the #4936 fix
 * found this THIRD call site still caching the FULL `placementFrameKey`
 * (base plus the live RTC suffix) instead of `placementFrameBaseKey`, so a
 * restore that runs while an RTC anchor is already live bakes that anchor
 * into the cache, and a LATER convergence then appends a second suffix on
 * top of it instead of replacing the first: `base:rtc:{X}:rtc:{Y}` instead
 * of the clean `base:rtc:{Y}` a session that never restored would compute
 * for the identical live anchor. */
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

it('caches only the base identity on restore, even when an RTC anchor is already live (#4936)', () => {
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
  assert.equal(useViewerStore.getState().modelPlacement.frameKey, 'local-engineering:m:z-up',
    'the restore-effect stamp must be the BASE identity, never the live RTC anchor it happened to see');

  // A later convergence moves the anchor (`updateModel` bumps `models`,
  // re-running the hook's effect, same as `federationRtcRebase.ts` does for
  // every converged model). Compare against what a session that never
  // restored (so never cached anything) would compute for the SAME live
  // anchor: the two must agree, or a restore-then-converge session silently
  // drifts from a genuinely fresh single-convergence one.
  const anchorY = { x: 444, y: 555, z: 666 };
  setLiveAnchor(anchorY);
  act(() => useViewerStore.getState().updateModel('first', {}));

  const afterRestoreThenConverge = placementFrameKey(useViewerStore.getState());
  const neverRestored = placementFrameKey({ ...useViewerStore.getState(), modelPlacement: emptyPlacementState() });
  assert.equal(afterRestoreThenConverge, neverRestored,
    'a restore that ran while an anchor was live must not out-live a later convergence to a different one');
});
