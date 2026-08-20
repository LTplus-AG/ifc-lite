/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `BulkPropertyEditor` executes mutations via `queryEngine.applyAction()` ->
 * `MutablePropertyView.setProperty()` directly, bypassing the store's
 * `setProperty` action entirely — and with it, `canCollabEdit()`. Every
 * other authoring surface (MainToolbar's Edit pill/undo/redo, AuthorTab's
 * Edit mode/Add element/Space Sketch, the store's own `setProperty`,
 * `setAttribute`, geometry move, etc.) gates on
 * `collabRole === null || collabRole === 'editor' || collabRole === 'admin'`
 * before mutating. The Bulk Property Editor dialog — reachable from both
 * MainToolbar's "Edit Properties" menu and the ribbon AuthorTab's "Bulk
 * property editor" button — has no such check anywhere in its component or
 * in the direct `applyAction` call path, so a viewer/commenter-role
 * participant in a shared session can open it and mutate every matching
 * entity's properties.
 *
 * This mounts the real component against a real `MutablePropertyView` (the
 * same fixture-store pattern `SearchModal.filter.wiring.test.tsx` uses),
 * drives it through the actual Property Set / Property Name / New Value
 * inputs and the Execute button — the named user action a viewer-role
 * participant can take — and asserts no mutation lands when `collabRole`
 * is 'viewer'.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { BulkPropertyEditor } from './BulkPropertyEditor.js';

const MODEL_ID = 'model-a';

function seedStore(collabRole: 'viewer' | 'editor' | null) {
  const seeded = fixtureModels(
    fixtureModel(MODEL_ID, {
      entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A' }],
    }),
  );
  useViewerStore.setState({
    ...seeded,
    mutationViews: new Map(),
    mutationVersion: 0,
    collabRole,
  });
}

function openDialog(container: HTMLElement): void {
  const trigger = [...container.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Open'),
  );
  assert.ok(trigger, 'dialog trigger button must render');
  click(trigger!);
}

async function fillAndExecute(): Promise<void> {
  // Let the dialog's deferred init (storeys/types) and the mutation-view
  // registration effects settle.
  await advance(0);

  const psetInput = [...document.body.querySelectorAll('input')].find(
    (i) => i.placeholder === 'e.g., Pset_WallCommon',
  ) as HTMLInputElement | undefined;
  const propInput = [...document.body.querySelectorAll('input')].find(
    (i) => i.placeholder === 'e.g., FireRating',
  ) as HTMLInputElement | undefined;
  const valueInput = [...document.body.querySelectorAll('input')].find(
    (i) => i.placeholder === 'Value',
  ) as HTMLInputElement | undefined;
  assert.ok(psetInput && propInput && valueInput, 'Property Set / Property Name / New Value inputs must render');

  const setNativeValue = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  setNativeValue(psetInput!, 'Pset_Test');
  setNativeValue(propInput!, 'Foo');
  setNativeValue(valueInput!, 'Bar');

  // Let the match-count debounce (setTimeout(0) then setTimeout(200)) resolve
  // so `liveMatchCount` becomes non-zero and the Execute button un-disables.
  await advance(250);

  const executeBtn = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Apply to'),
  ) as HTMLButtonElement | undefined;
  assert.ok(executeBtn, 'Execute ("Apply to N entities") button must render');
  click(executeBtn!);
  await advance(0);
}

describe('BulkPropertyEditor — collab role gate on bulk mutation execute', () => {
  afterEach(() => {
    cleanup();
  });

  it('a viewer-role participant clicking Execute must not mutate any property', async () => {
    seedStore('viewer');
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
    await fillAndExecute();

    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.ok(view, 'a mutation view is registered for the model');
    const value = view!.getPropertyValue(42, 'Pset_Test', 'Foo');
    assert.equal(
      value,
      null,
      'Execute must not write Pset_Test.Foo when collabRole is viewer — this is the collab-role bypass',
    );
  });

  it('an editor-role participant clicking Execute DOES mutate (sanity: the dialog and query engine work at all)', async () => {
    seedStore('editor');
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
    await fillAndExecute();

    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.ok(view, 'a mutation view is registered for the model');
    const value = view!.getPropertyValue(42, 'Pset_Test', 'Foo');
    assert.equal(value, 'Bar', 'editor-role execute writes the property (sanity check on the harness)');
  });
});
