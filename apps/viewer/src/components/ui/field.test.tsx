/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Field` (#5812): a control rendered inside `<Field label>` always has a
 * programmatic label, and `error`/`hint` always land in its accessible
 * description.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Field } from './field.js';
import { Input } from './input.js';
import { Textarea } from './textarea.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: ReactNode): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

// A minimal `getByLabelText`: finds the labelled control the way a test
// using @testing-library would, without pulling in the library.
function getByLabelText(host: HTMLElement, text: string): HTMLElement {
  const labels = Array.from(host.querySelectorAll('label'));
  const label = labels.find((el) => el.textContent === text);
  assert.ok(label, `no <label> with text "${text}"`);
  const forId = label.getAttribute('for');
  assert.ok(forId, `<label>"${text}" has no htmlFor`);
  const control = host.querySelector(`#${forId}`);
  assert.ok(control, `no element with id "${forId}"`);
  return control as HTMLElement;
}

describe('Field', () => {
  it('labels an Input so getByLabelText finds it', () => {
    const host = render(
      <Field label="IFC file name">
        <Input />
      </Field>,
    );
    const control = getByLabelText(host, 'IFC file name');
    assert.equal(control.tagName, 'INPUT');
  });

  it('labels a Textarea so getByLabelText finds it', () => {
    const host = render(
      <Field label="Description">
        <Textarea />
      </Field>,
    );
    const control = getByLabelText(host, 'Description');
    assert.equal(control.tagName, 'TEXTAREA');
  });

  it('puts the error text in the control accessible description and sets aria-invalid', () => {
    const host = render(
      <Field label="Scale" error="Must be a positive number">
        <Input />
      </Field>,
    );
    const input = getByLabelText(host, 'Scale');
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    const describedBy = input.getAttribute('aria-describedby');
    assert.ok(describedBy, 'input has an aria-describedby');
    const described = describedBy.split(' ').map((id) => document.getElementById(id)?.textContent);
    assert.ok(described.includes('Must be a positive number'));
  });

  it('puts hint text in the accessible description without marking the control invalid', () => {
    const host = render(
      <Field label="Eastings" hint="In the CRS map unit">
        <Input />
      </Field>,
    );
    const input = getByLabelText(host, 'Eastings');
    assert.equal(input.getAttribute('aria-invalid'), null);
    const describedBy = input.getAttribute('aria-describedby');
    assert.ok(describedBy, 'input has an aria-describedby');
    assert.ok(document.getElementById(describedBy)?.textContent === 'In the CRS map unit');
  });

  it('describes both hint and error together when both are present', () => {
    const host = render(
      <Field label="Northings" hint="In the CRS map unit" error="Required">
        <Input />
      </Field>,
    );
    const input = getByLabelText(host, 'Northings');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    const texts = describedBy.split(' ').map((id) => document.getElementById(id)?.textContent);
    assert.ok(texts.includes('In the CRS map unit'));
    assert.ok(texts.includes('Required'));
  });

  it('preserves an id the control already carries instead of overriding it', () => {
    const host = render(
      <Field label="Named">
        <Input id="explicit-id" />
      </Field>,
    );
    const control = getByLabelText(host, 'Named');
    assert.equal(control.getAttribute('id'), 'explicit-id');
  });

  it('renders labelAction beside the label without adding it to the label text', () => {
    const host = render(
      <Field label="Property Set" labelAction={<button type="button">Use custom name</button>}>
        <Input />
      </Field>,
    );
    const label = [...host.querySelectorAll('label')].find((el) => el.textContent === 'Property Set');
    assert.ok(label, 'the label text stays exactly "Property Set"');
    const action = host.querySelector('button');
    assert.ok(action, 'labelAction renders');
    assert.equal(label!.contains(action), false, 'labelAction is a sibling of the label, not inside it');
  });

  it('labels a Select via FieldContext (a Select.Root renders no DOM node to clone props onto)', () => {
    const host = render(
      <Field label="Category">
        <Select value="a" onValueChange={() => {}}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">A</SelectItem>
          </SelectContent>
        </Select>
      </Field>,
    );
    const trigger = getByLabelText(host, 'Category');
    assert.equal(trigger.getAttribute('role'), 'combobox');
    const label = [...host.querySelectorAll('label')].find((el) => el.textContent === 'Category');
    assert.ok(label, 'renders a <label>');
    assert.equal(trigger.getAttribute('aria-labelledby'), label!.getAttribute('id'), 'named via aria-labelledby, not just htmlFor (a <button> ignores label-for for its accessible name)');
  });

  it('folds error/hint into a Select trigger\'s aria-describedby/aria-invalid via FieldContext', () => {
    const host = render(
      <Field label="Category" error="Required">
        <Select value="" onValueChange={() => {}}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">A</SelectItem>
          </SelectContent>
        </Select>
      </Field>,
    );
    const trigger = getByLabelText(host, 'Category');
    assert.equal(trigger.getAttribute('aria-invalid'), 'true');
    const describedBy = trigger.getAttribute('aria-describedby');
    assert.ok(describedBy, 'trigger has an aria-describedby');
    assert.equal(document.getElementById(describedBy)?.textContent, 'Required');
  });

  it("an explicit id/aria-label on SelectTrigger wins over FieldContext's fallback", () => {
    const host = render(
      <Field label="Category">
        <Select value="a" onValueChange={() => {}}>
          <SelectTrigger id="explicit-trigger-id" aria-labelledby="explicit-labelledby">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">A</SelectItem>
          </SelectContent>
        </Select>
      </Field>,
    );
    const trigger = host.querySelector('[role="combobox"]')!;
    assert.equal(trigger.getAttribute('id'), 'explicit-trigger-id');
    assert.equal(trigger.getAttribute('aria-labelledby'), 'explicit-labelledby');
  });
});
