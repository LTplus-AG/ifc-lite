/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { loadDialogs } from '@/test/dialog-host.js';
import { createLocalIfcAdmission } from './confirmLocalIfcAdmission';

afterEach(cleanup);
it('#10264 approval covers only that load and cannot bypass the wasm32 limit', async () => {
  const { ConfirmDialogHost } = await loadDialogs(); render(<ConfirmDialogHost />);
  const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
  Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
  try {
    const options = { tryServer: async () => false, isCurrent: () => true, onCancel: () => {}, signal: new AbortController().signal };
    const admit = createLocalIfcAdmission(options);
    let pending: Promise<boolean> | undefined;
    await act(async () => { pending = admit(1.05e9); });
    await waitFor(() => !!document.querySelector('[role="alertdialog"]'), 'first load needs consent');
    click(document.querySelectorAll('[role="alertdialog"] button')[1]);
    assert.equal(await pending, true);
    assert.equal(await admit(1.05e9), true, 'the repeated pre-allocation checks share this load decision');
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
    await assert.rejects(admit(2 ** 31), /source must be smaller/);
    const next = createLocalIfcAdmission(options);
    await act(async () => { pending = next(1.05e9); });
    await waitFor(() => !!document.querySelector('[role="alertdialog"]'), 'another load needs a new decision');
    click(document.querySelector('[role="alertdialog"] button')!);
    assert.equal(await pending, false);
  } finally {
    if (memory) Object.defineProperty(navigator, 'deviceMemory', memory);
    else Reflect.deleteProperty(navigator, 'deviceMemory');
  }
});
