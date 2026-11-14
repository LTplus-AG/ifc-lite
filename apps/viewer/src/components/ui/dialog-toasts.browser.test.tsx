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
import { positionDialogNotices } from './dialog-notice-layout';

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
    await page.locator('[data-dialog-notices]').evaluate(positionDialogNotices);
    const notice = page.getByRole('dialog').locator('[aria-live="assertive"]');
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
    it(`#9875 B: ${theme} ${width}px modal notices leave actions and inputs unobscured`, async () => {
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
        await shelf.evaluate(positionDialogNotices);
        assert.equal(await receivesPointer(shelf.getByRole('button', { name: 'Dismiss notification' }).first()), true);
        for (const control of [field, exportButton]) {
          await control.scrollIntoViewIfNeeded();
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
    await dialog.locator('[data-dialog-notices]').evaluate(positionDialogNotices);
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

// #9879: apply the DOM update produced by the real mounted components to the
// browser harness, which measures actual Tailwind layout rather than Happy DOM.
for (const layout of ['grid', 'below', 'gridTall', 'scrollBody', 'viewportBounds', 'phoneCap'] as const) {
  it(`#9879 arriving notices preserve ${layout} dialog control coordinates`, async () => {
    render(<Toaster />);
    render(<Dialog open><DialogContent scrollBody={layout === 'scrollBody' || layout === 'viewportBounds' || layout === 'phoneCap'}
      viewportBounds={layout === 'viewportBounds' ? 'height' : undefined}>
      <DialogHeader><DialogTitle>Settings</DialogTitle><DialogDescription>Preferences</DialogDescription></DialogHeader>
      <label>File name<input aria-label="File name" defaultValue="Model.ifc" /></label>
      <div style={{ height: layout === 'grid' || layout === 'below' ? 100 : 1000 }}>Performance</div>
      <DialogFooter><button>Reset Geometry workers</button></DialogFooter>
    </DialogContent></Dialog>);
    const before = document.body.innerHTML;
    act(() => {
      toast.error('Unable to save preferences.');
      toast.info('IFClite stores an action log in this browser.');
    });
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const update = { className: panel.className, shelf: panel.firstElementChild!.outerHTML };
    act(() => {
      for (const button of panel.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')) button.click();
    });
    const dismissed = { shelf: panel.firstElementChild!.outerHTML, overflow: panel.style.overflow };
    await withThemedPage('light', before, async page => {
      const height = layout === 'phoneCap' ? 640 : 900;
      await settle(page, layout === 'phoneCap' ? 320 : 1600, height);
      const dialog = page.getByRole('dialog');
      if (layout === 'below') await dialog.evaluate(element => {
        Object.assign((element as HTMLElement).style, { top: '32px', translate: '-50% 0', transform: 'none' });
      });
      const field = dialog.getByRole('textbox', { name: 'File name' });
      const fieldBounds = await field.boundingBox();
      const button = dialog.getByRole('button', { name: 'Reset Geometry workers' });
      const bounds = await button.boundingBox();
      const panelBounds = await dialog.boundingBox();
      assert.ok(bounds && panelBounds);
      await dialog.evaluate((element, next) => {
        element.setAttribute('class', next.className);
        element.firstElementChild!.outerHTML = next.shelf;
      }, update);
      assert.deepEqual(await field.boundingBox(), fieldBounds, 'inserting the shelf must not move the input');
      assert.equal(await receivesPointer(field), true, 'the initial shelf must not cover the input');
      await dialog.locator('[data-dialog-notices]').evaluate(positionDialogNotices);
      const placement = await dialog.locator('[data-dialog-notices]').getAttribute('data-notice-placement');
      if (layout === 'below') assert.equal(placement, 'below');
      if (layout === 'phoneCap') assert.equal(placement, 'flow');
      if (placement !== 'flow') {
        assert.deepEqual(await button.boundingBox(), bounds, 'an arriving notice must not move a control');
        assert.deepEqual(await field.boundingBox(), fieldBounds, 'an arriving notice must not move the input');
      } else {
        assert.ok(panelBounds.height >= (layout === 'viewportBounds' ? height * 0.85 : height - 32) - 1);
      }
      assert.equal(await receivesPointer(field), true, 'notices must not intercept the input');
      assert.deepEqual(await dialog.boundingBox(), panelBounds, 'an arriving notice must not resize or recenter the dialog');
      assert.ok(panelBounds.height <= (layout === 'viewportBounds' ? height * 0.85 : height - 32) + 1);
      assert.equal(await receivesPointer(dialog.locator('[data-dialog-notices] button').first()), true);
      await dialog.evaluate((element, cleared) => {
        (element as HTMLElement).style.overflow = cleared.overflow;
        element.firstElementChild!.outerHTML = cleared.shelf;
      }, dismissed);
      assert.deepEqual(await field.boundingBox(), fieldBounds, 'dismissal restores the original content layout');
      assert.equal(await receivesPointer(field), true);
    });
  });
}

it('#9879 an overflowing non-scrollBody dialog retains clipping and scrolling when a notice fits above', async () => {
  render(<Toaster />);
  render(<Dialog open><DialogContent viewportBounds="height">
    <DialogHeader><DialogTitle>Long form</DialogTitle><DialogDescription>Review all fields</DialogDescription></DialogHeader>
    <div style={{ height: 1800 }}>Long content</div>
    <button>Last field</button>
  </DialogContent></Dialog>);
  act(() => toast.info('Saved'));
  await withThemedPage('light', document.body.innerHTML, async page => {
    await settle(page, 1600, 1200);
    const panel = page.getByRole('dialog');
    const shelf = panel.locator('[data-dialog-notices]');
    const room = await panel.evaluate(element => element.getBoundingClientRect().top - 24);
    const needed = await shelf.evaluate(element => element.scrollHeight);
    assert.ok(room >= needed, 'the short notice fits above the 85dvh panel');
    await shelf.evaluate(positionDialogNotices);
    const metrics = await panel.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      overflow: getComputedStyle(element).overflowY,
      overflows: element.scrollHeight > element.clientHeight,
    }));
    assert.ok(metrics.height <= 1200 * 0.85 + 1);
    assert.ok(metrics.overflows);
    assert.match(metrics.overflow, /auto|scroll/, 'overflowing content must keep its scroller');
    const spills = await panel.getByText('Long content', { exact: true }).evaluate(element => {
      const bounds = element.closest('[role="dialog"]')!.getBoundingClientRect();
      const y = bounds.bottom + 8;
      if (y >= window.innerHeight) throw new Error('Expected a probe point inside the viewport');
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, y));
    });
    assert.equal(spills, false, 'long content must not paint just below the panel inside the viewport');
    assert.equal(await receivesPointer(panel.getByRole('button', { name: 'Last field' })), false,
      'the overflowing bottom control must not paint outside the panel');
    await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.ok(await panel.evaluate(element => element.scrollTop > 0));
    assert.equal(await receivesPointer(panel.getByRole('button', { name: 'Last field' })), true,
      'scrolling reveals the previously clipped control');
  });
});
