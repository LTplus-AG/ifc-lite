/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { OpDropdown } from './SearchModal.filter.editors.shared.js';

afterEach(() => {
  cleanup();
  setLocale('en');
});

it('#5892 filter operator label switches with the active locale', () => {
  const container = render(<OpDropdown ops={['eq', 'ne']} value="ne" onChange={() => {}} />);
  assert.equal(container.querySelector('button')?.textContent?.trim(), '≠');

  registerLocale('filter-operator-witness', { 'filterOperators.ne': '[not equal]' });
  act(() => setLocale('filter-operator-witness'));
  assert.equal(container.querySelector('button')?.textContent?.trim(), '[not equal]');
});
