/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { click, cleanup, press, render, type as typeInput, waitFor } from '@/test/render.js';
import { loadDialogs } from '@/test/dialog-host.js';

afterEach(cleanup);

async function mount() {
  const { ConfirmDialogHost } = await loadDialogs();
  const host = render(<><button>Open dialog</button><ConfirmDialogHost /></>);
  const opener = host.querySelector('button')!;
  opener.focus();
  return opener;
}

it('#5813 confirm resolves true on confirm and returns focus to its opener', async () => {
  const { confirmDialog } = await loadDialogs();
  const opener = await mount();
  let answer: Promise<boolean>;
  act(() => { answer = confirmDialog({ description: 'Delete the saved item?', destructive: true }); });
  const dialog = document.querySelector('[role="alertdialog"]');
  assert.ok(dialog);
  const buttons = dialog.querySelectorAll('button');
  assert.equal(document.activeElement, buttons[0], 'destructive confirmation starts on Cancel');
  click(buttons[1]);
  assert.equal(await answer!, true);
  await waitFor(() => document.activeElement === opener, 'focus returns to the opener');
});

it('#5813 cancel and Escape each resolve false', async () => {
  const { confirmDialog } = await loadDialogs();
  await mount();
  let cancelled: Promise<boolean>;
  act(() => { cancelled = confirmDialog({ description: 'Clear measurements?' }); });
  click(document.querySelector('[role="alertdialog"] button')!);
  assert.equal(await cancelled!, false);

  let escaped: Promise<boolean>;
  act(() => { escaped = confirmDialog({ description: 'Clear measurements?' }); });
  press(document.activeElement!, 'Escape');
  assert.equal(await escaped!, false);
});

it('#5813 prompt returns its edited value and null on cancellation', async () => {
  const { promptDialog } = await loadDialogs();
  await mount();
  let answer: Promise<string | null>;
  act(() => { answer = promptDialog({ description: 'Name this view', defaultValue: 'View 1' }); });
  const input = document.querySelector<HTMLInputElement>('#viewer-prompt-value')!;
  assert.equal(input.value, 'View 1');
  typeInput(input, 'View 2');
  click(document.querySelector<HTMLButtonElement>('[role="alertdialog"] button[type="submit"]')!);
  assert.equal(await answer!, 'View 2');

  let cancelled: Promise<string | null>;
  act(() => { cancelled = promptDialog({ description: 'Name this view' }); });
  click(document.querySelector('[role="alertdialog"] button')!);
  assert.equal(await cancelled!, null);
});

it('#5813 requests from separate surfaces are shown in order', async () => {
  const { confirmDialog, promptDialog } = await loadDialogs();
  await mount();
  let first: Promise<boolean>;
  let second: Promise<string | null>;
  act(() => {
    first = confirmDialog({ description: 'Delete the view?', destructive: true });
    second = promptDialog({ description: 'Name the replacement', defaultValue: 'New view' });
  });
  let dialog = document.querySelector('[role="alertdialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent ?? '', /Delete the view\?/);
  click(dialog.querySelectorAll('button')[1]);
  assert.equal(await first!, true);

  dialog = document.querySelector('[role="alertdialog"]');
  assert.ok(dialog);
  assert.match(dialog.textContent ?? '', /Name the replacement/);
  assert.equal(document.activeElement, dialog.querySelector('input'));
  click(dialog.querySelector('button')!);
  assert.equal(await second!, null);
});
