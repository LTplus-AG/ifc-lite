/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, type } from '@/test/render.js';
import { ClashBcfExportDialog } from './ClashBcfExportDialog.js';

afterEach(cleanup);

it('#6342 associates the visible BCF topic cap label with its editable number field', () => {
  render(<ClashBcfExportDialog open onOpenChange={() => {}} scope="all" onScopeChange={() => {}} scopeIds={{ selected: new Set(), filtered: new Set() }} />);
  const input = document.body.querySelector<HTMLInputElement>('input[type="number"]');
  assert.ok(input);
  assert.equal(input.labels?.[0]?.textContent?.trim(), 'Max topics');
  type(input, '250');
  assert.equal(input.value, '250', 'the named field still changes the live cap');
});
