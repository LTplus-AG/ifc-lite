/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { useState } from 'react';
import { cleanup, press, render } from '@/test/render.js';
import { SegmentedControl } from './segmented-control.js';

afterEach(cleanup);

it('#5815 segmented radio group moves selection and focus with arrows, skipping disabled choices', () => {
  function FormatChoice() {
    const [value, setValue] = useState<'first' | 'middle' | 'last'>('first');
    return (
      <SegmentedControl
        label="Export format"
        value={value}
        options={[
          { value: 'first', label: 'First' },
          { value: 'middle', label: 'Middle', disabled: true },
          { value: 'last', label: 'Last' },
        ]}
        onValueChange={setValue}
      />
    );
  }

  const ui = render(<FormatChoice />);
  assert.ok(ui.querySelector('[role="radiogroup"][aria-label="Export format"]'));
  const first = ui.querySelector<HTMLInputElement>('input[value="first"]');
  const middle = ui.querySelector<HTMLInputElement>('input[value="middle"]');
  const last = ui.querySelector<HTMLInputElement>('input[value="last"]');
  assert.ok(first && middle && last);
  first.focus();
  press(first, 'ArrowRight');
  assert.equal(last.checked, true);
  assert.equal(document.activeElement, last);
  assert.equal(middle.checked, false);
  press(last, 'ArrowRight');
  assert.equal(first.checked, true, 'arrow selection wraps around the enabled options');
  assert.equal(document.activeElement, first);
  press(first, 'End');
  assert.equal(last.checked, true, 'End chooses the last enabled radio');
  press(last, 'Home');
  assert.equal(first.checked, true, 'Home chooses the first enabled radio');
});

it('#5815 arrows advance from the focused radio when the selected value becomes disabled', () => {
  function FormatChoice() {
    const [value, setValue] = useState<'first' | 'middle' | 'last'>('middle');
    return (
      <SegmentedControl
        label="Export format"
        value={value}
        options={[
          { value: 'first', label: 'First' },
          { value: 'middle', label: 'Middle', disabled: true },
          { value: 'last', label: 'Last' },
        ]}
        onValueChange={setValue}
      />
    );
  }

  const ui = render(<FormatChoice />);
  const first = ui.querySelector<HTMLInputElement>('input[value="first"]');
  const last = ui.querySelector<HTMLInputElement>('input[value="last"]');
  assert.ok(first && last);
  first.focus();
  press(first, 'ArrowRight');
  assert.equal(last.checked, true);
  assert.equal(document.activeElement, last);
});
