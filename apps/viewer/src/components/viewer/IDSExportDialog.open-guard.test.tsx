/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5605: the IDS dialog derived "exporting" solely from the parent's
 * `progress`, so while `onExport` was still in its async setup (no progress
 * published yet) Escape and Cancel could close the dialog mid-export.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { IDSExportDialog } from './IDSExportDialog.js';

afterEach(cleanup);

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(found, `button "${label}" must render`);
  return found;
}

describe('IDSExportDialog open guard (#5605)', () => {
  it('stays open on Escape and disables Cancel while onExport runs before any progress', async () => {
    const openChanges: boolean[] = [];
    render(
      <IDSExportDialog
        open
        onOpenChange={(next) => openChanges.push(next)}
        hasReport
        failedCount={1}
        onExport={() => new Promise<void>(() => {})}
        progress={null}
      />,
    );

    await act(async () => {
      button('Export BCF').click();
    });
    assert.equal(button('Cancel').disabled, true, 'Cancel must be disabled while onExport is in flight');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    assert.deepEqual(openChanges, [], 'Escape must not request a close while onExport is in flight');
  });
});
