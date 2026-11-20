/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { ContentStorageNotice } from './ContentStorageNotice';

afterEach(cleanup);

async function openNotice(storage?: Partial<StorageManager>) {
  Object.defineProperty(navigator, 'storage', { configurable: true, value: storage });
  const ui = render(<ContentStorageNotice status={{ phase: 'ready', items: {}, recovered: false }}
    retry={async () => true} restore={async () => true} />);
  const details = ui.querySelector('details');
  assert.ok(details);
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  return details;
}

test('shows unsupported storage and a backup hint without a request button', async () => {
  const details = await openNotice();
  assert.match(details.textContent ?? '', /Persistent storage is unavailable here.*Download a library backup/);
  assert.doesNotMatch(details.textContent ?? '', /Protect browser storage/);
});

test('shows best-effort storage and origin usage, then updates after explicit protection', async () => {
  let prompts = 0;
  let persisted = false;
  const details = await openNotice({
    persisted: async () => persisted,
    persist: async () => { prompts++; persisted = true; return true; },
    estimate: async () => ({ usage: 2 * 1024 ** 2, quota: 8 * 1024 ** 2 }),
  });
  assert.equal(prompts, 0);
  assert.match(details.textContent ?? '', /Best-effort storage.*Download a library backup/);
  assert.match(details.textContent ?? '', /uses about 2\.0 MiB/);
  assert.match(details.textContent ?? '', /quota is 8\.0 MiB/);
  const protect = [...details.querySelectorAll('button')].find(button => button.textContent === 'Protect browser storage');
  assert.ok(protect);
  await act(async () => { click(protect); });
  assert.equal(prompts, 1);
  assert.match(details.textContent ?? '', /Persistent storage is enabled/);
  assert.doesNotMatch(details.textContent ?? '', /Protect browser storage/);
});
