/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { displayedTranslation, emptyPlacementState, importPlacements } from '@/lib/model-placement/state';
import { saveWorkspacePlacements, restoreWorkspacePlacements } from '@/lib/model-placement/persistence';
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
