/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5872, third site: the property-value editor's Save / Enter wrote the value
 * back even when nothing changed, recording an undo entry and clearing the
 * redo branch for a no-op, the same defect the attribute editor had.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { configureMutationView } from '@/utils/configureMutationView';
import { MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
import { PropertyEditor } from './PropertyEditor.js';

const MODEL_ID = 'model-a';
const REDO_SENTINEL = { id: 'redo-sentinel', type: 'UPDATE_PROPERTY', timestamp: 0, modelId: MODEL_ID, entityId: 42 } as Mutation;

function seed(): void {
  const model = fixtureModel(MODEL_ID, { entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A' }] });
  const view = new MutablePropertyView(model.ifcDataStore!.properties ?? null, MODEL_ID);
  configureMutationView(view, model.ifcDataStore!);
  useViewerStore.setState({
    ...fixtureModels(model),
    mutationViews: new Map([[MODEL_ID, view]]),
    undoStacks: new Map(),
    redoStacks: new Map([[MODEL_ID, [REDO_SENTINEL]]]),
    collabRole: null,
  });
}

async function open(container: HTMLElement): Promise<HTMLInputElement> {
  const value = [...container.querySelectorAll('span')].find((s) => s.title === 'Click to edit');
  assert.ok(value, 'the value renders');
  click(value!);
  await advance(0);
  const input = container.querySelector('input[placeholder="Enter value"]') as HTMLInputElement | null;
  assert.ok(input, 'clicking the value opens the editor');
  return input!;
}

const undo = () => useViewerStore.getState().undoStacks.get(MODEL_ID) ?? [];

describe('property-value editor commits only real changes (#5872)', () => {
  afterEach(() => cleanup());

  it('Enter on an unchanged value records nothing and keeps redo', async () => {
    seed();
    const container = render(<PropertyEditor modelId={MODEL_ID} entityId={42} psetName="Pset_WallCommon" propName="Reference" currentValue="W-01" />);
    const input = await open(container);
    act(() => { input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await advance(0);
    assert.equal(undo().length, 0, 'no undo entry for an unchanged value');
    assert.deepEqual(useViewerStore.getState().redoStacks.get(MODEL_ID), [REDO_SENTINEL], 'the redo branch survives');
    assert.equal(container.querySelector('input[placeholder="Enter value"]'), null, 'the editor closes');
  });
});
