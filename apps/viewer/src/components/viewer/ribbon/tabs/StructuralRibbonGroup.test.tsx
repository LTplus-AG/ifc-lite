/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10604: the View tab's Structural group reaches what was palette-only. */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { resolve } from '@/i18n/registry';
import { useViewerStore, type ViewerState } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { PersistentToolHosts } from '../../PersistentToolHosts';
import { ViewTab } from './ViewTab';

let initial: ViewerState;
beforeEach(() => { initial = useViewerStore.getState(); });
afterEach(() => {
  cleanup();
  act(() => useViewerStore.setState(initial, true));
});

const MODES = ['vis:structural-both', 'vis:structural-analytical', 'vis:structural-physical'] as const;

function control(id: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[role="group"] button[data-command-id="${id}"]`);
  assert.ok(button, `${id} is mounted in a ribbon group`);
  return button;
}
const groupOf = (id: string) => control(id).closest('[role="group"]')?.getAttribute('aria-label');
const pressed = (id: string) => control(id).getAttribute('aria-pressed');
const disabled = (id: string) => control(id).getAttribute('aria-disabled') === 'true';
const reason = (id: string) => control(id).dataset.unavailableReason;
const description = (id: string) =>
  document.getElementById(control(id).getAttribute('aria-describedby') ?? '')?.textContent ?? '';

function load(entities: Array<{ expressId: number; type: string }>) {
  act(() => useViewerStore.setState({
    ...fixtureModels(fixtureModel('m', { entities })), loading: false, collabRole: null, editEnabled: true, structuralViewMode: 'both',
    typeVisibility: { ...useViewerStore.getState().typeVisibility, structuralGlyphs: true },
  }));
}

function mount() {
  render(<PersistentToolHosts><ViewTab /></PersistentToolHosts>);
}

it('groups the structural controls on the View tab, explaining why each is off without a model', () => {
  mount();
  for (const id of [...MODES, 'vis:structuralGlyphs', 'model:derive-structural']) {
    assert.equal(groupOf(id), 'Structural', `${id} sits in the Structural group`);
    assert.equal(disabled(id), true, `${id} is unavailable with nothing loaded`);
  }
  assert.equal(reason('vis:structural-analytical'), 'commandPalette.availability.structural',
    'Derive cannot run without a model, so the reason does not offer it');
  assert.equal(description('vis:structural-analytical'), resolve('commandPalette.availability.structural'));
  const before = useViewerStore.getState().structuralViewMode;
  click(control('vis:structural-analytical'));
  assert.equal(useViewerStore.getState().structuralViewMode, before, 'an unavailable mode runs nothing');
});

it('offers Derive on a physical-only model and names it in the mode controls\' reason', async () => {
  load([{ expressId: 1, type: 'IfcBeam' }]);
  mount();
  assert.equal(disabled('model:derive-structural'), false, 'Derive runs on an editable physical model');
  for (const id of [...MODES, 'vis:structuralGlyphs']) {
    assert.equal(reason(id), 'commandPalette.availability.structuralDerivable', `${id} points at Derive`);
  }
  assert.match(description('vis:structural-both'), /Derive structural analysis model/);

  act(() => useViewerStore.setState({ collabRole: 'viewer' }));
  assert.equal(disabled('model:derive-structural'), true, 'a viewer cannot derive');
  assert.equal(reason('vis:structural-both'), 'commandPalette.availability.structural',
    'the reason drops Derive once it is unavailable');

  act(() => useViewerStore.setState({ collabRole: null }));
  click(control('model:derive-structural'));
  await waitFor(() => [...document.querySelectorAll('[role="dialog"]')]
    .some((dialog) => dialog.textContent?.includes(resolve('commandPalette.tool.deriveStructural.label'))),
  'Derive opens the derivation review');
});

it('switches the structural view mode with the pressed button naming the one that is on', () => {
  load([{ expressId: 1, type: 'IfcBeam' }, { expressId: 2, type: 'IfcStructuralCurveMember' }]);
  mount();
  for (const id of MODES) assert.equal(disabled(id), false, `${id} is available with analytical data`);
  assert.deepEqual(MODES.map(pressed), ['true', 'false', 'false']);

  click(control('vis:structural-analytical'));
  assert.equal(useViewerStore.getState().structuralViewMode, 'analytical');
  assert.deepEqual(MODES.map(pressed), ['false', 'true', 'false']);

  click(control('vis:structural-physical'));
  assert.equal(useViewerStore.getState().structuralViewMode, 'physical');
  assert.deepEqual(MODES.map(pressed), ['false', 'false', 'true']);

  click(control('vis:structural-both'));
  assert.equal(useViewerStore.getState().structuralViewMode, 'both');
});

it('the supports & loads toggle reports the drawn layer and turning it on leaves Physical', () => {
  load([{ expressId: 2, type: 'IfcStructuralPointConnection' }]);
  mount();
  assert.equal(pressed('vis:structuralGlyphs'), 'true');
  click(control('vis:structuralGlyphs'));
  assert.equal(useViewerStore.getState().typeVisibility.structuralGlyphs, false);
  assert.equal(pressed('vis:structuralGlyphs'), 'false');
  click(control('vis:structuralGlyphs'));

  act(() => useViewerStore.setState({ structuralViewMode: 'physical' }));
  assert.equal(pressed('vis:structuralGlyphs'), 'false', 'Physical masks the glyphs whatever the preference');
  assert.equal(description('vis:structuralGlyphs'), resolve('ribbon.view.structuralGlyphsMaskedTooltip'));
  click(control('vis:structuralGlyphs'));
  assert.equal(useViewerStore.getState().structuralViewMode, 'both', 'showing the glyphs leaves Physical');
  assert.equal(useViewerStore.getState().typeVisibility.structuralGlyphs, true);
  assert.equal(pressed('vis:structuralGlyphs'), 'true');
});
