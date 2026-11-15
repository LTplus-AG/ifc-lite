/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Locator, Page } from 'playwright-core';
import { cleanup, render } from '@/test/render.js';
import { CONTRAST_BROWSER_SKIP, closeContrastBrowser, warmContrastBrowser, withThemedPage } from '@/test/contrast/render-harness.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Toaster, toast } from './toast';
import { positionDialogNotices } from './dialog-notice-layout';
import { liveDialogBundle, paintDialog, type FixtureWindow } from '@/test/dialog-toast-live';

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

it('#9875 A: an error raised during a modal is visible and unobscured in its modal scope', { skip: CONTRAST_BROWSER_SKIP }, async () => {
  render(<Toaster />);
  openDialog();
  act(() => toast.error('The reviewed changes could not be saved.'));
  await withThemedPage('light', document.body.innerHTML, async page => {
    await settle(page);
    await page.locator('[data-dialog-notices]').evaluate(positionDialogNotices);
    const notice = page.locator('[data-dialog-notices] [aria-live="assertive"]');
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
    it(`#9875 B: ${theme} ${width}px modal notices leave actions and inputs unobscured`, { skip: CONTRAST_BROWSER_SKIP }, async () => {
      render(<Toaster />);
      openDialog();
      act(() => {
        toast.error('Saving failed. Check the values and try again.');
        toast.info('Changes were made since this review opened.');
      });
      await withThemedPage(theme, document.body.innerHTML, async page => {
        await settle(page, width, width === 320 ? 640 : 900);
        const dialog = page.getByRole('dialog');
        const shelf = page.locator('[data-dialog-notices]');
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

it('#9875 C: a pre-existing persistent storey notice stays beneath a newly opened modal', { skip: CONTRAST_BROWSER_SKIP }, async () => {
  render(<Toaster />);
  act(() => toast.success('Level 3 added', { label: 'Draw on', onClick: () => {} }));
  openDialog();
  act(() => toast.error('A new review failure'));
  await withThemedPage('light', document.body.innerHTML, async page => {
    await settle(page);
    const dialog = page.getByRole('dialog');
    await page.locator('[data-dialog-notices]').evaluate(positionDialogNotices);
    assert.equal(await page.locator('[data-notice-shelf]').getByText('Level 3 added').count(), 0,
      'the old app notice must not migrate into the modal scope');
    assert.equal(await page.locator('[data-notice-shelf]').getByText('A new review failure').isVisible(), true);
    const button = dialog.getByRole('button', { name: 'Export', exact: true });
    const bounds = await button.boundingBox();
    assert.ok(bounds);
    const oldNotice = page.locator('[data-toast-seq]').filter({ hasText: 'Level 3 added' });
    assert.equal(await oldNotice.count(), 1, 'the app notice must still exist');
    await oldNotice.evaluate((row, position) => {
      const anchor = row.parentElement!.parentElement!;
      Object.assign(anchor.style, { left: `${position.x}px`, top: `${position.y}px`, bottom: 'auto', right: 'auto' });
    }, bounds);
    assert.equal(await receivesPointer(button), true, 'old storey notice must not cover Export');
    assert.equal(await receivesPointer(oldNotice), false, 'old toast stays below the scrim');
    await button.click({ timeout: 2000 });
  });
});

// #9879: mount React in Chromium so dismissal executes the product's effects.
for (const layout of ['grid', 'below', 'gridTall', 'scrollBody', 'viewportBounds', 'phoneCap'] as const) {
  it(`#9879 live ${layout} notices restore padding and coordinates when dismissed`, { skip: CONTRAST_BROWSER_SKIP }, async () => {
    const bundle = await liveDialogBundle();
    await withThemedPage('light', '<div id="live-dialog-fixture"></div>', async page => {
      const height = layout === 'phoneCap' ? 640 : 900;
      await settle(page, layout === 'phoneCap' ? 320 : 1600, height);
      await page.addScriptTag({ content: bundle });
      await page.evaluate(layout => (window as unknown as FixtureWindow).DialogToastFixture.mountDialog(layout), layout);
      await paintDialog(page);
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      const field = dialog.getByRole('textbox', { name: 'File name' });
      const button = dialog.getByRole('button', { name: 'Reset Geometry workers' });
      const fieldBounds = await field.boundingBox();
      const buttonBounds = await button.boundingBox();
      const panelBounds = await dialog.boundingBox();
      const padding = await dialog.evaluate(element => ({
        inline: (element as HTMLElement).style.paddingTop, computed: getComputedStyle(element).paddingTop,
      }));
      assert.ok(fieldBounds && buttonBounds && panelBounds);
      await page.evaluate(() => (window as unknown as FixtureWindow).DialogToastFixture.raiseNotices());
      await paintDialog(page);
      const shelf = page.locator('[data-notice-shelf]');
      const dismiss = shelf.getByRole('button', { name: 'Dismiss notification', exact: true });
      assert.equal(await dismiss.count(), 2, 'both real dismiss controls must exist');
      const placement = await shelf.getAttribute('data-notice-placement');
      if (layout === 'below') assert.equal(placement, 'below');
      if (layout === 'phoneCap') assert.equal(placement, 'flow');
      if (placement !== 'flow') {
        assert.deepEqual(await field.boundingBox(), fieldBounds, 'new notices must not move the input');
        assert.deepEqual(await button.boundingBox(), buttonBounds, 'new notices must not move actions');
      } else {
        assert.ok(await dialog.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingTop))
          > Number.parseFloat(padding.computed), 'the fallback must actually apply the product inset');
      }
      assert.equal(await receivesPointer(field), true, 'notices must not cover the input');
      assert.deepEqual(await dialog.boundingBox(), panelBounds, 'notices must not resize the panel');
      assert.ok(panelBounds.height <= (layout === 'viewportBounds' ? height * 0.85 : height - 32) + 1);
      for (let remaining = 2; remaining > 0; remaining--) {
        await dismiss.first().click();
        assert.equal(await dismiss.count(), remaining - 1, 'each real click dismisses one notice');
      }
      await paintDialog(page);
      assert.equal(await shelf.locator('[data-toast-seq]').count(), 0);
      assert.deepEqual(await dialog.evaluate(element => ({
        inline: (element as HTMLElement).style.paddingTop, computed: getComputedStyle(element).paddingTop,
      })), padding, 'the product must restore its own padding after dismissal');
      assert.deepEqual(await field.boundingBox(), fieldBounds, 'the product must restore the input coordinates');
      assert.deepEqual(await button.boundingBox(), buttonBounds, 'the product must restore action coordinates');
      assert.equal(await receivesPointer(field), true);
    });
  });
}

it('#9879 portal selects and popovers escape a capped dialog', { skip: CONTRAST_BROWSER_SKIP }, async () => {
  const bundle = await liveDialogBundle();
  await withThemedPage('light', '<div id="live-dialog-fixture"></div>', async page => {
    await settle(page);
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => (window as unknown as FixtureWindow).DialogToastFixture.mountDialog('portalControls'));
    await paintDialog(page);
    // Radix temporarily aria-hides the parent while a select popup owns focus.
    const dialog = page.locator('[data-dialog-panel]');
    const select = dialog.getByRole('combobox', { name: 'Portal select' });
    await select.scrollIntoViewIfNeeded();
    await select.click();
    const list = page.getByRole('listbox');
    assert.equal(await list.evaluate(element => element.closest('[data-dialog-panel]') === null), true);
    const listBounds = await list.boundingBox();
    const dialogBounds = await dialog.boundingBox();
    assert.ok(listBounds && dialogBounds && listBounds.y + listBounds.height > dialogBounds.y + dialogBounds.height);
    const option = list.getByRole('option', { name: 'Portal option B' });
    assert.equal(await receivesPointer(option), true);
    await option.click();
    assert.match(await select.innerText(), /Portal option B/);
    const trigger = dialog.getByRole('button', { name: 'Portal popover', exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const popover = page.locator('[data-portal-popover]');
    assert.equal(await popover.evaluate(element => element.closest('[data-dialog-panel]') === null), true);
    const popupBounds = await popover.boundingBox();
    const panelBounds = await dialog.boundingBox();
    assert.ok(popupBounds && panelBounds && popupBounds.y + popupBounds.height > panelBounds.y + panelBounds.height);
    const action = popover.getByRole('button', { name: 'Popover action' });
    assert.equal(await receivesPointer(action), true);
    await action.click();
    assert.equal(await dialog.isVisible(), true);
  });
});

it('#9879 an overflowing non-scrollBody dialog retains clipping and scrolling when a notice fits above', { skip: CONTRAST_BROWSER_SKIP }, async () => {
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
    const shelf = page.locator('[data-dialog-notices]');
    const room = await panel.evaluate(element => element.getBoundingClientRect().top - 24);
    const needed = await shelf.evaluate(element => {
      const panel = element.parentElement!.querySelector('[data-dialog-panel]')!;
      (element as HTMLElement).style.width = `${panel.getBoundingClientRect().width}px`;
      return element.scrollHeight;
    });
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

it('#9879 content growth after a notice preserves panel overflow and clipping', { skip: CONTRAST_BROWSER_SKIP }, async () => {
  render(<Toaster />);
  render(<Dialog open><DialogContent viewportBounds="height" style={{ height: '85dvh' }}>
    <DialogHeader><DialogTitle>Growing form</DialogTitle><DialogDescription>Edit fields</DialogDescription></DialogHeader>
    <div data-growing-content style={{ height: 100 }}>Form rows</div>
    <button>Save fields</button>
  </DialogContent></Dialog>);
  act(() => toast.info('Saved'));
  await withThemedPage('light', document.body.innerHTML, async page => {
    await settle(page, 1600, 1200);
    const panel = page.getByRole('dialog');
    const before = await panel.evaluate(element => {
      (element as HTMLElement).style.overflow = '';
      return getComputedStyle(element).overflowY;
    });
    await page.locator('[data-dialog-notices]').evaluate(positionDialogNotices);
    await panel.locator('[data-growing-content]').evaluate(element => { (element as HTMLElement).style.height = '1800px'; });
    assert.equal(await panel.evaluate(element => getComputedStyle(element).overflowY), before,
      'notice placement must never change the panel overflow, including after content growth');
    assert.equal(await panel.evaluate(element => element.scrollHeight > element.clientHeight), true);
    const spills = await panel.locator('[data-growing-content]').evaluate(element => {
      const bounds = element.closest('[role="dialog"]')!.getBoundingClientRect();
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom + 8));
    });
    assert.equal(spills, false);
    await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.ok(await panel.evaluate(element => element.scrollTop > 0));
  });
});

it('#9879 remeasuring the capped fallback preserves the panel scroll position', { skip: CONTRAST_BROWSER_SKIP }, async () => {
  render(<Toaster />);
  render(<Dialog open><DialogContent><DialogTitle>Long form</DialogTitle><DialogDescription>Edit rows</DialogDescription>
    <div style={{ height: 1800 }}>Many rows</div><button>Last row</button>
  </DialogContent></Dialog>);
  act(() => toast.info('Saved'));
  await withThemedPage('light', document.body.innerHTML, async page => {
    await settle(page);
    const panel = page.getByRole('dialog');
    const shelf = page.locator('[data-dialog-notices]');
    await shelf.evaluate(positionDialogNotices);
    assert.equal(await shelf.getAttribute('data-notice-placement'), 'flow');
    const before = await panel.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
    assert.ok(before > 0);
    await shelf.evaluate(positionDialogNotices);
    assert.equal(await panel.evaluate(element => element.scrollTop), before);
    assert.equal(await receivesPointer(shelf.getByRole('button', { name: 'Dismiss notification' })), true,
      'a fallback notice must remain visible and dismissible when the form is scrolled to its last field');
  });
});


it('#9879 keyboard dismissal keeps focus inside the modal while another notice survives', { skip: CONTRAST_BROWSER_SKIP }, async () => {
  const bundle = await liveDialogBundle();
  await withThemedPage('light', '<div id="live-dialog-fixture"></div>', async page => {
    await settle(page);
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => (window as unknown as FixtureWindow).DialogToastFixture.mountDialog('grid'));
    await paintDialog(page);
    await page.evaluate(() => (window as unknown as FixtureWindow).DialogToastFixture.raiseNotices());
    await paintDialog(page);
    const dismiss = page.locator('[data-notice-shelf]').getByRole('button', { name: 'Dismiss notification', exact: true });
    assert.equal(await dismiss.count(), 2);
    await dismiss.first().focus();
    await page.keyboard.press('Enter');
    assert.equal(await dismiss.count(), 1);
    assert.equal(await dismiss.first().evaluate(element => document.activeElement === element), true,
      'keyboard dismissal must focus the surviving notice instead of body');
    await page.keyboard.press('Enter');
    assert.equal(await dismiss.count(), 0);
    assert.equal(await page.getByRole('dialog', { name: 'Settings', exact: true })
      .evaluate(element => document.activeElement === element), true, 'the final dismissal restores panel focus');
  });
});

it('#9879 fallback shelf padding does not intercept the dialog Close button', { skip: CONTRAST_BROWSER_SKIP }, async () => {
  const bundle = await liveDialogBundle();
  await withThemedPage('light', '<div id="live-dialog-fixture"></div>', async page => {
    await settle(page, 320, 640);
    await page.addScriptTag({ content: bundle });
    await page.evaluate(() => (window as unknown as FixtureWindow).DialogToastFixture.mountDialog('phoneCap'));
    await paintDialog(page);
    await page.evaluate(() => (window as unknown as FixtureWindow).DialogToastFixture.raiseNotices());
    await paintDialog(page);
    assert.equal(await page.locator('[data-notice-shelf]').getAttribute('data-notice-placement'), 'flow');
    const close = page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close', exact: true });
    assert.equal(await close.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('button') === element;
    }), true, 'the Close button centre must hit Close, including through transparent shelf padding');
    await close.click();
    assert.equal(await page.getByRole('dialog', { name: 'Settings', exact: true }).count(), 0);
  });
});
