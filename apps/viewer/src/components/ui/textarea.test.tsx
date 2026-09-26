/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Textarea` (#5812): a plain styled `<textarea>` that forwards its ref and
 * every prop, and (via `Field`) can always be labelled.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, createRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Textarea } from './textarea.js';
import { Field } from './field.js';

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

describe('Textarea', () => {
  it('renders a <textarea> and forwards its ref', () => {
    const ref = createRef<HTMLTextAreaElement>();
    const host = render(<Textarea ref={ref} placeholder="Notes" />);
    const el = host.querySelector('textarea')!;
    assert.equal(ref.current, el);
    assert.equal(el.getAttribute('placeholder'), 'Notes');
  });

  it('is reachable by getByLabelText when wrapped in Field', () => {
    const host = render(
      <Field label="Comment">
        <Textarea />
      </Field>,
    );
    const label = host.querySelector('label')!;
    const forId = label.getAttribute('for');
    const control = host.querySelector(`#${forId}`);
    assert.equal(control?.tagName, 'TEXTAREA');
  });

  it('merges a caller className with the default styling', () => {
    const host = render(<Textarea className="custom-class" />);
    const el = host.querySelector('textarea')!;
    assert.ok(el.className.includes('custom-class'));
    assert.ok(el.className.includes('rounded-md'));
  });
});
