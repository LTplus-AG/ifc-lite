/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Locator, Page } from 'playwright-core';
import { cleanup, render } from '@/test/render.js';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage } from '@/test/contrast/render-harness.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Toaster, toast } from './toast';

before(warmContrastBrowser);
after(closeContrastBrowser);
afterEach(() => {
  for (const button of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')) act(() => button.click());
  cleanup();
});

function openDialog() {
  render(<Dialog open><DialogContent>
    <DialogHeader><DialogTitle>Review changes</DialogTitle><DialogDescription>Confirm the reviewed edits.</DialogDescription></DialogHeader>
    <label>File name<input aria-label="File name" defaultValue="Model.ifc" /></label>
    <DialogFooter><button>Cancel</button><button>Export</button></DialogFooter>
  </DialogContent></Dialog>);
}

async function settle(page: Page, width = 1600, height = 900) {
  await page.setViewportSize({ width, height });
  await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
}

async function receivesPointer(locator: Locator) {
  return locator.evaluate(element => {
    const r = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
}

it('#9875 A: an error raised during a modal is visible and unobscured inside its panel', async () => {
  render(<Toaster />);
  openDialog();
  act(() => toast.error('The reviewed changes could not be saved.'));
  await withThemedPage('light', document.body.innerHTML, async page => {
    await settle(page);
    const notice = page.getByRole('dialog').getByRole('alert');
    assert.match(await notice.innerText(), /could not be saved/);
    assert.equal(await notice.isVisible(), true);
    assert.equal(await receivesPointer(notice), true, 'the scrim must not cover the notice');
    const box = await notice.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 900, 'notice is in the viewport');
    await notice.getByRole('button', { name: 'Dismiss notification' }).click({ timeout: 2000 });
  });
});

for (const width of [1600, 320]) {
  for (const theme of ['light', 'dark'] as const) {
    it(`#9875 B: ${theme} ${width}px modal actions and inputs stay clear of new notices`, async () => {
      render(<Toaster />);
      openDialog();
      act(() => {
        toast.error('Saving failed. Check the values and try again.');
        toast.info('Changes were made since this review opened.');
      });
      await withThemedPage(theme, document.body.innerHTML, async page => {
        await settle(page, width, width === 320 ? 640 : 900);
        const dialog = page.getByRole('dialog');
        const shelf = dialog.locator('[data-dialog-notices]');
        const field = dialog.getByRole('textbox', { name: 'File name' });
        const exportButton = dialog.getByRole('button', { name: 'Export', exact: true });
        for (const control of [field, exportButton]) {
          await control.scrollIntoViewIfNeeded();
          const a = await shelf.boundingBox();
          const b = await control.boundingBox();
          assert.ok(a && b);
          assert.ok(a.y + a.height <= b.y || b.y + b.height <= a.y,
            'notice shelf must occupy its own layout row');
          assert.equal(await receivesPointer(control), true);
        }
        await field.fill('Reviewed.ifc', { timeout: 2000 });
        await exportButton.click({ timeout: 2000 });
      });
    });
  }
}

it('#9875 C: a pre-existing persistent storey notice stays beneath a newly opened modal', async () => {
  render(<Toaster />);
  act(() => toast.success('Level 3 added', { label: 'Draw on', onClick: () => {} }));
  openDialog();
  act(() => toast.error('A new review failure'));
  await withThemedPage('light', document.body.innerHTML, async page => {
    await settle(page);
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByText('Level 3 added').count(), 0);
    assert.equal(await dialog.getByText('A new review failure').isVisible(), true);
    const button = dialog.getByRole('button', { name: 'Export', exact: true });
    const bounds = await button.boundingBox();
    assert.ok(bounds);
    const oldNotice = page.locator('[data-toast-seq]').filter({ hasText: 'Level 3 added' });
    await oldNotice.evaluate((row, position) => {
      const anchor = row.parentElement!.parentElement!;
      Object.assign(anchor.style, { left: `${position.x}px`, top: `${position.y}px`, bottom: 'auto', right: 'auto' });
    }, bounds);
    assert.equal(await receivesPointer(button), true, 'old storey notice must not cover Export');
    assert.equal(await receivesPointer(oldNotice), false, 'old toast stays below the scrim');
    await button.click({ timeout: 2000 });
  });
});
