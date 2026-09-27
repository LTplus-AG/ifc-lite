/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6233: the Add Element dimension fields.
 *  - Clearing a field and typing a new value used to fail: every keystroke
 *    below `min` ("", "0", "0.") was dropped, so the old digits stayed and
 *    replacing 0.15 with 0.3 produced "0.1503".
 *  - `step=0.05` with `min=0.01` marked defaults like 0.2 and 3 invalid.
 *  - The id came from the label text, so two "Height (m)" fields collided.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { blur, cleanup, press, render, type } from '@/test/render.js';
import { NumberField } from './add-element-number-field.js';

function Host({ initial, min, onCommit }: { initial: number; min: number; onCommit: (v: number) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <NumberField
      label="Height (m)"
      value={value}
      min={min}
      onChange={(v) => { setValue(v); onCommit(v); }}
    />
  );
}

function input(root: HTMLElement, index = 0): HTMLInputElement {
  const found = root.querySelectorAll('input')[index];
  assert.ok(found, 'number input rendered');
  return found as HTMLInputElement;
}

afterEach(() => cleanup());

describe('Add Element NumberField (#6233)', () => {
  it('types a new value from an emptied field through intermediate text below min', () => {
    const commits: number[] = [];
    const ui = render(<Host initial={0.15} min={0.01} onCommit={(v) => commits.push(v)} />);
    const field = input(ui);
    for (const text of ['', '0', '0.', '0.3']) {
      type(field, text);
      assert.equal(field.value, text, `the field shows "${text}" while typing`);
    }
    assert.deepEqual(commits, [0.3], 'only the valid value commits');
    blur(field);
    assert.equal(field.value, '0.3');
  });

  it('Enter or blur on an invalid draft shows the last good value again', () => {
    const commits: number[] = [];
    const ui = render(<Host initial={0.2} min={0.01} onCommit={(v) => commits.push(v)} />);
    const field = input(ui);
    type(field, '');
    assert.equal(field.getAttribute('aria-invalid'), 'true');
    press(field, 'Enter');
    assert.equal(field.value, '0.2');
    type(field, '0');
    blur(field);
    assert.equal(field.value, '0.2');
    assert.equal(field.getAttribute('aria-invalid'), null);
    assert.deepEqual(commits, []);
  });

  it('accepts the defaults without a step mismatch', () => {
    for (const initial of [0.2, 3, 0.005]) {
      const ui = render(<Host initial={initial} min={0.01} onCommit={() => undefined} />);
      const field = input(ui);
      assert.equal(field.getAttribute('step'), 'any');
      assert.equal(field.validity.stepMismatch, false, `${initial} must not be a step mismatch`);
      cleanup();
    }
  });

  it('gives fields with the same label unique ids that their labels point at', () => {
    const ui = render(
      <>
        <Host initial={3} min={0.01} onCommit={() => undefined} />
        <Host initial={2.5} min={0.01} onCommit={() => undefined} />
      </>,
    );
    const [first, second] = [input(ui, 0), input(ui, 1)];
    assert.ok(first.id && second.id);
    assert.notEqual(first.id, second.id);
    assert.doesNotMatch(first.id, /\s/, 'ids must not contain spaces');
    const labels = [...ui.querySelectorAll('label')].map((label) => label.getAttribute('for'));
    assert.deepEqual(labels, [first.id, second.id]);
  });
});
