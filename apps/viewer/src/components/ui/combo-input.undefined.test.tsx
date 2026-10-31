/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, cleanup, click, mouseDown } from '@/test/render.js';
import { ComboInput } from './combo-input';

afterEach(cleanup);

// PostHog 5.1.3 trim crash: the original caller remains unidentified.
// Simulate a runtime contract violation, rather than claiming a known caller.
test('an undefined runtime value renders empty and still accepts suggestions', () => {
  const runtimeValue: string = JSON.parse('{}').value;
  function Editor() {
    const [value, setValue] = useState(runtimeValue);
    return <ComboInput value={value} onChange={setValue} options={['Concrete', 'Steel']} />;
  }
  const ui = render(<Editor />);
  const input = ui.querySelector('input');
  assert.ok(input);
  assert.equal(input.value, '');
  click(input);
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(el => el.textContent === 'Steel');
  assert.ok(option);
  mouseDown(option);
  assert.equal(input.value, 'Steel');
  click(input);
  assert.deepEqual(Array.from(document.querySelectorAll('[role="option"]')).map(el => el.textContent), ['Steel']);
});
