/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `confirmDialog` / `promptDialog` (#5813): the in-app replacements for
 * `window.confirm` / `window.prompt`.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, press } from '@/test/render.js';
import { answerDialog, mountDialogHost, openDialog } from '@/test/dialogs.js';
import { confirmDialog, promptDialog } from './confirm-dialog.js';

afterEach(async () => {
  // Settle anything a failing test left open so the queue starts empty.
  while (openDialog()) await answerDialog(false);
  cleanup();
});

describe('confirmDialog', () => {
  it('shows the question in an alertdialog and resolves true on confirm', async () => {
    mountDialogHost();
    const answer = confirmDialog({ title: 'Clear all measurements?', destructive: true });
    const title = await answerDialog(true);
    assert.equal(title, 'Clear all measurements?');
    assert.equal(await answer, true);
    assert.equal(openDialog(), null, 'the dialog closes once answered');
  });

  it('resolves false on cancel', async () => {
    mountDialogHost();
    const answer = confirmDialog({ title: 'Delete flow?' });
    await answerDialog(false);
    assert.equal(await answer, false);
  });

  it('resolves false on Escape, and the dialog is role=alertdialog with focus inside it', async () => {
    mountDialogHost();
    const answer = confirmDialog({ title: 'Uninstall?' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const dialog = openDialog();
    assert.equal(dialog?.getAttribute('role'), 'alertdialog');
    assert.ok(dialog?.contains(document.activeElement), 'focus moves into the dialog');
    press(document.activeElement ?? document.body, 'Escape');
    assert.equal(await answer, false);
  });

  it('queues a second request until the first is answered', async () => {
    mountDialogHost();
    const first = confirmDialog({ title: 'First?' });
    const second = confirmDialog({ title: 'Second?' });
    assert.equal(await answerDialog(true), 'First?');
    assert.equal(await answerDialog(false), 'Second?');
    assert.deepEqual([await first, await second], [true, false]);
  });

  it('never hangs when no host is mounted: it resolves false and says why', async () => {
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      assert.equal(await confirmDialog({ title: 'Anyone there?' }), false);
    } finally {
      console.error = original;
    }
    assert.match(String(errors[0]?.[0]), /no <DialogHost \/> is mounted/);
  });
});

describe('promptDialog', () => {
  it('pre-fills the default value and resolves the typed text', async () => {
    mountDialogHost();
    const answer = promptDialog({ title: 'Rename cut', defaultValue: 'Before' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const input = openDialog()?.querySelector('input');
    assert.equal(input?.value, 'Before');
    assert.ok(input?.labels?.length, 'the text field is labelled');
    assert.equal(document.activeElement, input, 'focus starts in the text field');
    await answerDialog('After');
    assert.equal(await answer, 'After');
  });

  it('resolves null when cancelled', async () => {
    mountDialogHost();
    const answer = promptDialog({ title: 'New flow name' });
    await answerDialog(null);
    assert.equal(await answer, null);
  });
});
