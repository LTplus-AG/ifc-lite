/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PropertyEditor's dialogs (#5812): every `Input`/`Select`/`Switch`/
 * `ComboInput` field is reachable by `getByLabelText` — including every
 * `Select`, whose `SelectTrigger` (see `ui/select.tsx`) now reads its
 * `id`/`aria-labelledby` back out of `FieldContext` rather than needing a
 * duplicated `aria-label` at each call site (#5812 review).
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, click, type } from '@/test/render.js';
import { NewPropertyDialog, AddQuantityDialog, AddClassificationDialog, AddMaterialDialog, ReassignClassDialog } from './PropertyEditor.js';

afterEach(() => {
  cleanup();
});

function openDialog(host: HTMLElement): HTMLElement {
  const trigger = host.querySelector('button');
  assert.ok(trigger, 'dialog trigger renders');
  click(trigger);
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

describe('PropertyEditor dialogs accessibility (#5812)', () => {
  it('NewPropertyDialog: every field is reachable (custom-name branch)', () => {
    const host = render(<NewPropertyDialog modelId="model" entityId={1} entityType="IfcWall" existingPsets={[]} />);
    const dialog = openDialog(host);
    // Switch to custom pset name via the toggle button beside the "Property Set" label.
    const toggle = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Custom name' || b.textContent === 'Use standard');
    assert.ok(toggle);
    click(toggle);
    const setInput = getByLabelText(dialog, 'Property Set');
    assert.equal(setInput.tagName, 'INPUT');
    const propInput = getByLabelText(dialog, 'Property');
    assert.equal(propInput.tagName, 'INPUT');
    const typeSelect = getByLabelText(dialog, 'Type');
    assert.equal(typeSelect.getAttribute('role'), 'combobox');
    const valueInput = getByLabelText(dialog, 'Value');
    assert.equal(valueInput.tagName, 'INPUT');
  });

  it('NewPropertyDialog: the standard-pset Select is reachable by getByLabelText', () => {
    const host = render(<NewPropertyDialog modelId="model" entityId={1} entityType="IfcWall" existingPsets={[]} schemaVersion="IFC4" />);
    const dialog = openDialog(host);
    const setSelect = getByLabelText(dialog, 'Property Set');
    assert.equal(setSelect.getAttribute('role'), 'combobox');
  });

  it('NewPropertyDialog: the boolean value field renders a labelled Switch', () => {
    const host = render(<NewPropertyDialog modelId="model" entityId={1} entityType="IfcWall" existingPsets={[]} />);
    const dialog = openDialog(host);
    const typeSelect = getByLabelText(dialog, 'Type');
    click(typeSelect);
    const booleanOption = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === 'Boolean');
    assert.ok(booleanOption);
    click(booleanOption);
    const valueSwitch = getByLabelText(dialog, 'Value');
    assert.equal(valueSwitch.getAttribute('role'), 'switch');
  });

  it('AddQuantityDialog: every field is reachable', () => {
    const host = render(<AddQuantityDialog modelId="model" entityId={1} entityType="IfcWall" existingQtos={[]} />);
    const dialog = openDialog(host);
    const setSelect = getByLabelText(dialog, 'Quantity Set');
    assert.equal(setSelect.getAttribute('role'), 'combobox');
    const valueInput = getByLabelText(dialog, 'Value');
    assert.equal(valueInput.tagName, 'INPUT');
  });

  it('AddClassificationDialog: every field is reachable', () => {
    const host = render(<AddClassificationDialog modelId="model" entityId={1} entityType="IfcWall" />);
    const dialog = openDialog(host);
    const systemSelect = getByLabelText(dialog, 'Classification System');
    assert.equal(systemSelect.getAttribute('role'), 'combobox');
    const codeInput = getByLabelText(dialog, 'Identification Code');
    assert.equal(codeInput.tagName, 'INPUT');
    assert.ok(codeInput.getAttribute('aria-describedby'), 'the code field has a description (codeHelp)');
    const nameInput = getByLabelText(dialog, 'Name (optional)');
    assert.equal(nameInput.tagName, 'INPUT');
  });

  it('AddMaterialDialog: every field is reachable', () => {
    const host = render(<AddMaterialDialog modelId="model" entityId={1} entityType="IfcWall" />);
    const dialog = openDialog(host);
    const nameInput = getByLabelText(dialog, 'Material Name');
    assert.equal(nameInput.tagName, 'INPUT');
    const categorySelect = getByLabelText(dialog, 'Category');
    assert.equal(categorySelect.getAttribute('role'), 'combobox');
    const descInput = getByLabelText(dialog, 'Description (optional)');
    assert.equal(descInput.tagName, 'INPUT');
  });

  it('ReassignClassDialog: the ComboInput and predefined-type Select are reachable', () => {
    const host = render(<ReassignClassDialog modelId="model" entityId={1} entityType="IfcWall" />);
    const trigger = host.querySelector('button');
    assert.ok(trigger);
    click(trigger);
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement;
    assert.ok(dialog);
    const targetInput = getByLabelText(dialog, 'Target class');
    assert.equal(targetInput.tagName, 'INPUT');
    type(targetInput as HTMLInputElement, 'IfcColumn');
    const predefinedSelect = getByLabelText(dialog, 'Predefined type (optional)');
    assert.equal(predefinedSelect.getAttribute('role'), 'combobox');
  });
});
