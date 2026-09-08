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
 *
 * The UI gate (`canEditInSession`, derived from `collabRole`) sits alongside
 * an independent engine-level gate: `BulkQueryEngine` is constructed with a
 * `canCollabEdit` predicate (see `packages/mutations/src/mutation-guard.ts`)
 * that refuses the write at the chokepoint regardless of what this component
 * does. That backstop means "no mutation lands" is NOT a fact this file can
 * use to pin the UI layer on its own — it stays true even with the UI gate
 * deleted entirely, because the engine still refuses underneath it. The
 * separate test below asserts the control's own state (`disabled` + the
 * tooltip) instead, which is the one observable the engine gate cannot
 * fake: it is true if and only if the UI layer computed `canEditInSession`
 * correctly for a viewer role.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
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

  it('a viewer-role participant sees the Execute button disabled with the collab tooltip', async () => {
    // Asserts control STATE, not mutation outcome. The engine-level guard
    // (BulkQueryEngine's canCollabEdit, see mutation-guard.ts) would refuse
    // the write even if this component's own gate were deleted, so "no
    // mutation lands" can't distinguish "UI gate present" from "UI gate
    // removed but engine backstops" — a green run here would mask the loss
    // of the UI layer. `disabled` + the tooltip text are facts only the UI
    // layer controls; the engine cannot make them true on its behalf.
    seedStore('viewer');
    const container = render(<BulkPropertyEditor trigger={<button>Open</button>} />);
    openDialog(container);
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

    // Let the match-count debounce resolve so liveMatchCount > 0 — otherwise
    // the button would be disabled for an unrelated reason and the assertion
    // would be meaningless.
    await advance(250);

    const executeBtn = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Apply to'),
    ) as HTMLButtonElement | undefined;
    assert.ok(executeBtn, 'Execute ("Apply to N entities") button must render');
    assert.equal(executeBtn!.disabled, true, 'Execute button must be disabled for a viewer-role participant');
    assert.equal(
      executeBtn!.title,
      'Editing requires editor access in this shared session',
      'the disabled button must explain why via its tooltip',
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
