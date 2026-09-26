/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BulkPropertyEditor's fields (#5812): every `Input`/`Select` is reachable
 * by `getByLabelText` (a real `<label for>`, via `Field`) or
 * `getByRole(..., { name })` (`aria-label` on the `Select`'s combobox
 * trigger, or directly on a datalist-backed `<input>` — see
 * `bulk-property-editor-action-config.tsx`'s header for why `Select` can't
 * use `Field`'s `htmlFor` directly).
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

function getByLabelText(container: ParentNode, text: string): HTMLElement {
  const label = [...container.querySelectorAll('label')].find((el) => el.textContent?.trim() === text || el.textContent?.startsWith(text));
  assert.ok(label, `no <label> matching "${text}"`);
  const forId = label.getAttribute('for');
  assert.ok(forId, `<label> "${text}" has no htmlFor`);
  const control = container.querySelector(`#${forId}`);
  assert.ok(control, `no element with id "${forId}" for label "${text}"`);
  return control as HTMLElement;
}

function getByRoleName(container: ParentNode, role: string, name: string): HTMLElement {
  const match = [...container.querySelectorAll(`[role="${role}"]`)].find((el) => el.getAttribute('aria-label') === name);
  assert.ok(match, `no [role="${role}"] with accessible name "${name}"`);
  return match as HTMLElement;
}

describe('BulkPropertyEditor accessibility (#5812)', () => {
  it('the Model selector and Name Pattern fields are reachable by getByLabelText/getByRole', () => {
    const dialog = openDialog();
    const modelSelect = getByRoleName(dialog, 'combobox', 'Model');
    assert.ok(modelSelect);
    const namePattern = getByLabelText(dialog, 'Name Pattern (Regex)');
    assert.equal(namePattern.tagName, 'INPUT');
  });

  it('a property-filter row: every field is reachable', () => {
    const dialog = openDialog();
    const addFilter = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.includes('Add Filter'));
    assert.ok(addFilter);
    click(addFilter);

    const psetInput = getByLabelText(dialog, 'Pset (optional)');
    assert.equal(psetInput.tagName, 'INPUT');
    const propInput = getByLabelText(dialog, 'Property name');
    assert.equal(propInput.tagName, 'INPUT');
    const operatorSelect = getByRoleName(dialog, 'combobox', 'Filter operator');
    assert.ok(operatorSelect);
    const valueInput = getByLabelText(dialog, 'Value');
    assert.equal(valueInput.tagName, 'INPUT');
    const removeButton = [...dialog.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Remove property filter');
    assert.ok(removeButton);
  });

  it('the "IS_NULL" operator hides the now-meaningless value field', () => {
    const dialog = openDialog();
    click([...dialog.querySelectorAll('button')].find((b) => b.textContent?.includes('Add Filter'))!);
    const operatorSelect = getByRoleName(dialog, 'combobox', 'Filter operator');
    click(operatorSelect);
    const isEmptyOption = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Is empty');
    assert.ok(isEmptyOption);
    click(isEmptyOption);
    const valueLabel = [...dialog.querySelectorAll('label')].find((el) => el.textContent === 'Value');
    assert.equal(valueLabel, undefined, 'the value field is gone, not just unlabelled');
  });

  it('the Action Configuration fields are reachable for the default SET_PROPERTY action', () => {
    const dialog = openDialog();
    const actionTypeSelect = getByRoleName(dialog, 'combobox', 'Action Type');
    assert.ok(actionTypeSelect);
    const propertySetInput = getByLabelText(dialog, 'Property Set');
    assert.equal(propertySetInput.tagName, 'INPUT');
    assert.equal(propertySetInput.getAttribute('aria-label'), 'Property Set');
    const propertyNameInput = getByLabelText(dialog, 'Property Name');
    assert.equal(propertyNameInput.tagName, 'INPUT');
    const newValueInput = getByLabelText(dialog, 'New Value');
    assert.equal(newValueInput.tagName, 'INPUT');
    const valueTypeSelect = getByRoleName(dialog, 'combobox', 'Value Type');
    assert.ok(valueTypeSelect);
  });

  it('SET_ATTRIBUTE swaps the property field to a labelled Select of exact EXPRESS attribute names', () => {
    const dialog = openDialog();
    const actionTypeSelect = getByRoleName(dialog, 'combobox', 'Action Type');
    click(actionTypeSelect);
    const setAttributeOption = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Set Attribute');
    assert.ok(setAttributeOption);
    click(setAttributeOption);
    const attributeSelect = getByRoleName(dialog, 'combobox', 'Attribute');
    assert.ok(attributeSelect);
  });
});
