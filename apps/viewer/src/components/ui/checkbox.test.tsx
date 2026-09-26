/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Checkbox` (#5812): labelled, toggles via keyboard Space, and reports
 * `indeterminate` on the underlying DOM node the way screen readers read it.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Checkbox } from './checkbox.js';

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

function pressSpace(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  });
}

describe('Checkbox', () => {
  it('associates its label so getByLabelText finds it', () => {
    const host = render(<Checkbox label="Heights are ellipsoidal" checked={false} />);
    const label = host.querySelector('label');
    assert.ok(label, 'renders a <label>');
    const forId = label!.getAttribute('for');
    const input = host.querySelector(`#${forId}`);
    assert.ok(input, 'label points at the checkbox by id');
    assert.equal(input!.textContent ?? '', '');
    assert.ok(label!.textContent?.includes('Heights are ellipsoidal'));
  });

  it('toggles via keyboard Space and calls onCheckedChange with the next value', () => {
    let observed: boolean[] = [];
    const host = render(
      <Checkbox label="Enabled" checked={false} onCheckedChange={(v) => observed.push(v)} />,
    );
    const input = host.querySelector('input')!;
    pressSpace(input);
    assert.deepEqual(observed, [true]);
  });

  it('does not toggle a disabled checkbox on Space', () => {
    let observed: boolean[] = [];
    const host = render(
      <Checkbox label="Disabled" checked={false} disabled onCheckedChange={(v) => observed.push(v)} />,
    );
    const input = host.querySelector('input')!;
    pressSpace(input);
    assert.deepEqual(observed, []);
  });

  it('reports indeterminate on the underlying input DOM property', () => {
    const host = render(<Checkbox label="Partially selected" checked={false} indeterminate />);
    const input = host.querySelector('input') as HTMLInputElement;
    assert.equal(input.indeterminate, true);
  });

  it('clears indeterminate when the prop turns false', () => {
    function Harness() {
      const [indeterminate, setIndeterminate] = useState(true);
      return (
        <div>
          <Checkbox label="X" checked={false} indeterminate={indeterminate} />
          <button onClick={() => setIndeterminate(false)}>clear</button>
        </div>
      );
    }
    const host = render(<Harness />);
    const input = host.querySelector('input') as HTMLInputElement;
    assert.equal(input.indeterminate, true);
    act(() => {
      host.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(input.indeterminate, false);
  });

  it('renders a bare, unlabelled input when no label is given (labelling deferred to a surrounding Field or aria-label)', () => {
    const host = render(<Checkbox checked={false} aria-label="Standalone" />);
    assert.equal(host.querySelectorAll('label').length, 0);
    assert.equal(host.querySelector('input')!.getAttribute('aria-label'), 'Standalone');
  });

  it("the accessible name (via aria-labelledby) excludes description, even though both sit inside the same <label>", () => {
    const host = render(
      <Checkbox
        label="Heights are ellipsoidal"
        description="Skip the geoid correction for files whose heights are already ellipsoidal."
        checked={false}
      />,
    );
    const input = host.querySelector('input')!;
    const label = host.querySelector('label')!;
    // Both are visible inside the same clickable <label> ...
    assert.ok(label.textContent?.includes('Heights are ellipsoidal'));
    assert.ok(label.textContent?.includes('Skip the geoid correction'));
    // ... but the accessible NAME (aria-labelledby) resolves to only the
    // label text, not label-wraps-control's default "whole subtree" name,
    // which would otherwise fold the description into it too.
    const labelledBy = input.getAttribute('aria-labelledby');
    assert.ok(labelledBy, 'input has an explicit aria-labelledby');
    const nameSource = document.getElementById(labelledBy);
    assert.equal(nameSource?.textContent, 'Heights are ellipsoidal');
    assert.ok(!nameSource?.textContent?.includes('Skip the geoid correction'));
    // The description is still available as the accessible DESCRIPTION.
    const describedBy = input.getAttribute('aria-describedby');
    assert.ok(describedBy, 'input has an aria-describedby');
    assert.equal(document.getElementById(describedBy)?.textContent, 'Skip the geoid correction for files whose heights are already ellipsoidal.');
  });
});
