/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drive the shared confirm/prompt dialogs (`components/ui/confirm-dialog.tsx`,
 * #5813) from a test the way a user would: mount the one `<DialogHost />`,
 * then answer the dialog that opens by clicking its buttons or typing into
 * its field. This replaces stubbing `window.confirm` / `window.prompt`, which
 * the viewer no longer calls.
 *
 * Import `./setup-dom.js` FIRST in the test file, as for `./render.js`.
 */

import { act } from 'react';
import assert from 'node:assert/strict';
import { DialogHost } from '@/components/ui/confirm-dialog';
import { render } from './render.js';

/** Mount the dialog host; unmounted by `cleanup()` from `./render.js`. */
export function mountDialogHost(): void {
  render(<DialogHost />);
}

/** The open confirm (`alertdialog`) or prompt (`dialog`), or null. Only the
 *  host's own dialog: a panel under test may be a Radix dialog itself. */
export function openDialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-dialog-host]');
}

async function waitForDialog(): Promise<HTMLElement> {
  for (let i = 0; i < 20; i += 1) {
    const dialog = openDialog();
    if (dialog) return dialog;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  assert.fail('expected a confirm/prompt dialog to open');
}

/**
 * Answer the dialog that is open (or about to open). `true`/`false` press
 * confirm/cancel on a confirmation; a string types it into a prompt and
 * submits; `null` cancels a prompt. Returns the dialog's title text so a test
 * can assert what the user was asked.
 */
export async function answerDialog(answer: boolean | string | null): Promise<string> {
  const dialog = await waitForDialog();
  const title = dialog.querySelector('h2')?.textContent ?? '';
  const buttons = [...dialog.querySelectorAll('button')];
  const cancel = buttons[0];
  const confirm = buttons[buttons.length - 1];
  if (typeof answer === 'string') {
    const input = dialog.querySelector('input');
    assert.ok(input, 'a prompt dialog has a text field');
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setValue?.call(input, answer);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => {
      confirm.click();
    });
  } else {
    await act(async () => {
      (answer ? confirm : cancel).click();
    });
  }
  return title;
}
