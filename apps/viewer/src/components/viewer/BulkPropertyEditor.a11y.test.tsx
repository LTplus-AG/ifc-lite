/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BulkPropertyEditor's fields (#5812): every `Input`/`Select` is reachable
 * by `getByLabelText` — including every `Select`, whose `SelectTrigger`
 * (see `ui/select.tsx`) now reads its `id`/`aria-labelledby` back out of
 * `FieldContext` rather than needing a duplicated `aria-label` at each call
 * site (#5812 review).
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, click } from '@/test/render.js';
import { BulkPropertyEditor } from './BulkPropertyEditor.js';

afterEach(() => {
  cleanup();
});

function openDialog(): HTMLElement {
  const container = render(<BulkPropertyEditor />);
  click(container.querySelector('button')!);
  const dialog = document.body.querySelector('[role="dialog"]');
  assert.ok(dialog, 'dialog opens');
  return dialog as HTMLElement;
}

/** Resolves the same way `@testing-library`'s `getByLabelText` does for a `<label for>`. */
function getByLabelText(container: ParentNode, text: string): HTMLElement {
  const label = [...container.querySelectorAll('label')].find((el) => el.textContent?.trim() === text || el.textContent?.startsWith(text));
  assert.ok(label, `no <label> matching "${text}"`);
  const forId = label.getAttribute('for');
  assert.ok(forId, `<label> "${text}" has no htmlFor`);
  const control = container.querySelector(`#${forId}`);
  assert.ok(control, `no element with id "${forId}" for label "${text}"`);
  return control as HTMLElement;
}

describe('BulkPropertyEditor accessibility (#5812)', () => {
  it('the Model selector and target source are reachable while Query is active', () => {
    const dialog = openDialog();
    const modelSelect = getByLabelText(dialog, 'Model');
    assert.equal(modelSelect.getAttribute('role'), 'combobox');
    const targetSource = dialog.querySelector('[role="combobox"][aria-label="Target source"]');
    assert.ok(targetSource, 'the Bulk target source has an accessible name');
  });

  it('exposes the shared group and rule controls in the Query source', () => {
    const dialog = openDialog();
    const buttons = [...dialog.querySelectorAll('button')];
    assert.ok(buttons.some((button) => button.textContent?.includes('Add group')));
    assert.ok(buttons.some((button) => button.textContent?.includes('Add rule')));
  });

  it('the Action Configuration fields are reachable for the default SET_PROPERTY action', () => {
    const dialog = openDialog();
    const actionTypeSelect = getByLabelText(dialog, 'Action Type');
    assert.equal(actionTypeSelect.getAttribute('role'), 'combobox');
    const propertySetInput = getByLabelText(dialog, 'Property Set');
    assert.equal(propertySetInput.tagName, 'INPUT');
    const propertyNameInput = getByLabelText(dialog, 'Property Name');
    assert.equal(propertyNameInput.tagName, 'INPUT');
    const newValueInput = getByLabelText(dialog, 'New Value');
    assert.equal(newValueInput.tagName, 'INPUT');
    const valueTypeSelect = getByLabelText(dialog, 'Value Type');
    assert.equal(valueTypeSelect.getAttribute('role'), 'combobox');
  });

  it('SET_ATTRIBUTE swaps the property field to a labelled Select of exact EXPRESS attribute names', () => {
    const dialog = openDialog();
    const actionTypeSelect = getByLabelText(dialog, 'Action Type');
    click(actionTypeSelect);
    const setAttributeOption = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Set Attribute');
    assert.ok(setAttributeOption);
    click(setAttributeOption);
    const attributeSelect = getByLabelText(dialog, 'Attribute');
    assert.equal(attributeSelect.getAttribute('role'), 'combobox');
  });
});
