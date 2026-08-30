/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PropertyEditor`'s inline commit path (`commitSave`) and its "Add
 * Property" / "Add Quantity" dialogs all fed a user-typed Real/Integer
 * string through `parseFloat(value) || 0` / `parseInt(value, 10) || 0`.
 * `NaN || 0` is `0`, so typing anything that doesn't parse as a number
 * ("abc", a stray character, an unfinished edit) silently wrote a real `0`
 * into the model — indistinguishable from a value the user actually
 * entered, with no error shown anywhere. See PR #3456 (same defect in
 * `CsvConnector.parseValue`) and the sibling record on that PR's thread.
 *
 * This mounts the real inline editor against a real `MutablePropertyView`
 * (the fixture-store pattern `BulkPropertyEditor.collab-gate.test.tsx`
 * uses) and drives it through the actual value input, type buttons, and
 * Save action.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { configureMutationView } from '@/utils/configureMutationView';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { PropertyEditor } from './PropertyEditor.js';
import { toast } from '@/components/ui/toast';

const MODEL_ID = 'model-a';
const ENTITY_ID = 42;
const PSET = 'Pset_WallCommon';
const PROP = 'ThermalTransmittance';

function seedStore(): MutablePropertyView {
  const model = fixtureModel(MODEL_ID, {
    entities: [{ expressId: ENTITY_ID, type: 'IfcWall', name: 'Wall A' }],
  });
  const seeded = fixtureModels(model);
  const dataStore = model.ifcDataStore!;
  const view = new MutablePropertyView(dataStore.properties ?? null, MODEL_ID);
  configureMutationView(view, dataStore);
  useViewerStore.setState({
    ...seeded,
    mutationViews: new Map([[MODEL_ID, view]]),
    mutationVersion: 0,
    collabRole: null,
  });
  return view;
}

function setInputValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function getTypeButton(label: string): HTMLButtonElement {
  const btn = [...document.body.querySelectorAll('button')].find((b) => b.textContent === label);
  assert.ok(btn, `${label} type button must render`);
  return btn as HTMLButtonElement;
}

function getValueInput(): HTMLInputElement {
  const input = document.body.querySelector('input[placeholder="Enter value"]') as HTMLInputElement | null;
  assert.ok(input, 'value input must render once editing');
  return input!;
}

function getSaveButton(): HTMLButtonElement {
  const save = [...document.body.querySelectorAll('button')].find((b) =>
    b.querySelector('svg.lucide-check'),
  ) as HTMLButtonElement | undefined;
  assert.ok(save, 'Save button must render');
  return save!;
}

/** Enters edit mode (default type is String — a plain `type="text"` input,
 *  unsanitized) and returns the value input + Save button, both still in
 *  String mode. Every step is followed by `advance(0)` so the resulting
 *  state update commits before the next DOM query — a raw `dispatchEvent`
 *  outside `click()` (which already wraps in `act()`) does not flush
 *  synchronously. */
async function openEditor(container: HTMLElement): Promise<{ input: HTMLInputElement; save: HTMLButtonElement }> {
  const editSpan = [...container.querySelectorAll('span')].find((s) => s.title === 'Click to edit');
  assert.ok(editSpan, 'value span must render (click to enter edit mode)');
  click(editSpan!);
  await advance(0);

  return { input: getValueInput(), save: getSaveButton() };
}

/**
 * Types `text` while the field is still in String mode (`type="text"`, no
 * browser/jsdom number-input sanitization) and only THEN switches to
 * `typeLabel` ('Real' or 'Int') via the type button — the realistic way a
 * non-numeric string reaches a Real/Integer commit: the field starts as
 * String, the switch to Real/Integer doesn't touch `value` (see the type
 * button's `onClick`), and `<input type="number">` only sanitizes on the
 * next keystroke/paste, not on becoming controlled with a mismatched
 * existing value. Typing directly into a live `type="number"` input, by
 * contrast, is sanitized away by the DOM before it ever reaches React state
 * — true in real browsers and in jsdom alike — so it can't reproduce the
 * defect at all.
 */
async function typeThenSwitchType(
  container: HTMLElement,
  text: string,
  typeLabel: string,
): Promise<{ save: HTMLButtonElement }> {
  const { input } = await openEditor(container);
  setInputValue(input, text);
  await advance(0);

  click(getTypeButton(typeLabel));
  await advance(0);

  return { save: getSaveButton() };
}

describe('PropertyEditor — Real/Integer parse guard (commitSave)', () => {
  let originalToastError: typeof toast.error;
  let toastMessages: string[];

  afterEach(() => {
    cleanup();
    if (originalToastError) toast.error = originalToastError;
  });

  function spyToastError() {
    toastMessages = [];
    originalToastError = toast.error;
    toast.error = (message: string) => {
      toastMessages.push(message);
    };
  }

  it('does not write 0 for a non-numeric Real edit; blocks the save with an error', async () => {
    spyToastError();
    const view = seedStore();
    const container = render(
      <PropertyEditor modelId={MODEL_ID} entityId={ENTITY_ID} psetName={PSET} propName={PROP} currentValue={null} />,
    );

    const { save } = await typeThenSwitchType(container, 'abc', 'Real');
    click(save);
    await advance(0);

    assert.equal(
      view.getPropertyValue(ENTITY_ID, PSET, PROP),
      null,
      'a non-numeric Real entry must not write a fabricated 0',
    );
    assert.equal(toastMessages.length, 1, 'an error must be surfaced to the user');
    assert.match(toastMessages[0], /not a valid Real value/);
  });

  it('does not write 0 for a non-numeric Integer edit; blocks the save with an error', async () => {
    spyToastError();
    const view = seedStore();
    const container = render(
      <PropertyEditor modelId={MODEL_ID} entityId={ENTITY_ID} psetName={PSET} propName={PROP} currentValue={null} />,
    );

    const { save } = await typeThenSwitchType(container, 'abc', 'Int');
    click(save);
    await advance(0);

    assert.equal(
      view.getPropertyValue(ENTITY_ID, PSET, PROP),
      null,
      'a non-numeric Integer entry must not write a fabricated 0',
    );
    assert.equal(toastMessages.length, 1, 'an error must be surfaced to the user');
    assert.match(toastMessages[0], /not a valid Integer value/);
  });

  it('REGRESSION GUARD: a genuine "0" Real entry still writes 0', async () => {
    spyToastError();
    const view = seedStore();
    const container = render(
      <PropertyEditor modelId={MODEL_ID} entityId={ENTITY_ID} psetName={PSET} propName={PROP} currentValue={null} />,
    );

    const { save } = await typeThenSwitchType(container, '0', 'Real');
    click(save);
    await advance(0);

    assert.equal(
      view.getPropertyValue(ENTITY_ID, PSET, PROP),
      0,
      'a genuinely-entered 0 must still be written — the fix must not reject real zeros',
    );
    assert.equal(toastMessages.length, 0, 'a valid 0 must not raise an error');
  });

  it('REGRESSION GUARD: a genuine "0" Integer entry still writes 0', async () => {
    spyToastError();
    const view = seedStore();
    const container = render(
      <PropertyEditor modelId={MODEL_ID} entityId={ENTITY_ID} psetName={PSET} propName={PROP} currentValue={null} />,
    );

    const { save } = await typeThenSwitchType(container, '0', 'Int');
    click(save);
    await advance(0);

    assert.equal(view.getPropertyValue(ENTITY_ID, PSET, PROP), 0, 'a genuinely-entered 0 must still be written');
    assert.equal(toastMessages.length, 0, 'a valid 0 must not raise an error');
  });

  it("an empty Real entry writes null (unset), matching the Boolean arm's existing convention", async () => {
    spyToastError();
    const view = seedStore();
    // Seed an existing value so we can observe the edit actually clearing it.
    view.setProperty(ENTITY_ID, PSET, PROP, 12.5, PropertyValueType.Real);
    const container = render(
      <PropertyEditor
        modelId={MODEL_ID}
        entityId={ENTITY_ID}
        psetName={PSET}
        propName={PROP}
        currentValue={12.5}
        currentType={PropertyValueType.Real}
      />,
    );

    const { input, save } = await openEditor(container);
    setInputValue(input, '');
    await advance(0);
    click(save);
    await advance(0);

    assert.equal(
      view.getPropertyValue(ENTITY_ID, PSET, PROP),
      null,
      'an empty Real field commits as unset (null), the same convention the Boolean arm already uses',
    );
    assert.equal(toastMessages.length, 0, 'clearing to empty is not a parse error');
  });

  it('a valid Real edit still commits normally (sanity check on the harness)', async () => {
    spyToastError();
    const view = seedStore();
    const container = render(
      <PropertyEditor modelId={MODEL_ID} entityId={ENTITY_ID} psetName={PSET} propName={PROP} currentValue={null} />,
    );

    const { save } = await typeThenSwitchType(container, '3.14', 'Real');
    click(save);
    await advance(0);

    assert.equal(view.getPropertyValue(ENTITY_ID, PSET, PROP), 3.14);
    assert.equal(toastMessages.length, 0);
  });
});
