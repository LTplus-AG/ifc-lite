/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5604: the hierarchy's "Remove model" used to call `removeModel` at once,
 * discarding a model's unexported edits without a word. A model with changes
 * (the per-model count the Export modified IFC… badge sums) now asks first; a model
 * without any is still removed straight away.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { HierarchyPanel } from './HierarchyPanel.js';

// The Models list is virtualized; happy-dom reports no layout, so give the
// scroll container a plausible size (pattern from HierarchyPanel.federation.test.tsx).
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });

function removeButton(container: HTMLElement, modelName: string): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(`button[aria-label="Remove model ${modelName}"]`);
  assert.ok(btn, `expected a remove button for ${modelName}`);
  return btn;
}

function dialogButton(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === label);
}

describe('HierarchyPanel — removing a model with unexported changes (#5604)', () => {
  beforeEach(() => {
    const edited = new MutablePropertyView(null, 'edited');
    edited.setProperty(1, 'Pset_WallCommon', 'FireRating', 'REI60', PropertyValueType.Label);
    useViewerStore.setState({
      ...fixtureModels(
        fixtureModel('edited', { entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall' }] }),
        fixtureModel('clean', { entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall' }] }),
      ),
      mutationViews: new Map([['edited', edited]]),
      mutationVersion: 1,
      georefMutations: new Map(),
      scheduleData: null,
      scheduleIsEdited: false,
      scheduleSourceModelId: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('asks before removing an edited model, and keeps it when the user cancels', () => {
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    const name = useViewerStore.getState().models.get('edited')!.name;

    click(removeButton(container, name));
    assert.ok(useViewerStore.getState().models.has('edited'), 'the edited model must not be removed before the user confirms');
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog, 'a confirmation dialog must open');
    assert.match(dialog.textContent ?? '', /1 change that has not been exported/);

    click(dialogButton('Cancel')!);
    assert.ok(useViewerStore.getState().models.has('edited'), 'cancel keeps the model and its edits');
    assert.equal(document.body.querySelector('[role="dialog"]'), null, 'cancel closes the dialog');

    click(removeButton(container, name));
    click(dialogButton('Remove and discard changes')!);
    assert.ok(!useViewerStore.getState().models.has('edited'), 'confirming removes the model');
  });

  it('removes a model without changes straight away', () => {
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    click(removeButton(container, useViewerStore.getState().models.get('clean')!.name));
    assert.ok(!useViewerStore.getState().models.has('clean'), 'a clean model is removed at once');
    assert.equal(document.body.querySelector('[role="dialog"]'), null, 'with no dialog in between');
  });
});
