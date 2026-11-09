/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { render, click, type, advance, cleanup, waitFor } from '@/test/render';
import { EpsgLookupDialog } from './EpsgLookupDialog';
afterEach(cleanup);
// C-7: blank input belongs to the starter list, including after the debounce.
test('C-7 clearing a search keeps the starter results after the debounce', async () => {
  const ui = render(<EpsgLookupDialog onSelect={() => {}} />);
  click(ui.querySelector('button')!);
  await waitFor(() => document.querySelectorAll('[role="dialog"] code').length > 1, 'starter results');
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  type(input, '4326'); await advance(300);
  type(input, '');
  await waitFor(() => document.querySelectorAll('[role="dialog"] code').length > 1, 'restored starter results');
  await advance(300);
  assert.equal(document.querySelectorAll('[role="dialog"] code').length > 1, true, 'blank debounce must not erase starters');
});
