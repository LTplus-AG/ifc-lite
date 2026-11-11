/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9718: where the commands sit, per form factor, in real Chrome device
 * emulation: a bar under the viewport on portrait phones (and the cover
 * screen, with nothing scrolling sideways), a rail on the right of a phone on
 * its side, the ribbon on top of a desktop. The landscape case also emulates
 * the iPhone's landscape safe-area insets and checks no control sits under them.
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';

interface Box { x: number; y: number; width: number; height: number }

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${selector} is laid out`).not.toBeNull();
  return box!;
}

async function openViewer(page: Page, model = false): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
  });
  await page.goto(model ? '/?model=/samples/building-architecture.ifc' : '/');
}

/** Every mobile command button's box, and whether the bar scrolls or the page does. */
async function commandLayout(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('[data-command-surface="mobile"]')!;
    const buttons = [...bar.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { label: b.getAttribute('aria-label') ?? '', left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
    return {
      placement: bar.dataset.commandPlacement ?? null,
      buttons,
      barScrollsX: bar.scrollWidth > bar.clientWidth,
      barScrollsY: bar.scrollHeight > bar.clientHeight,
      pageScrollsX: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(`${name}.png`, { body: await page.screenshot(), contentType: 'image/png' });
}

for (const [device, width, height] of [['flip-main', 412, 960], ['iphone-pro', 402, 874], ['iphone-pro-max', 440, 956]] as const) {
  test.describe(`${device} portrait ${width}x${height}`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true });

    test(`#9718 the command bar sits at the bottom, in one row (${device})`, async ({ page }, testInfo) => {
      await openViewer(page);
      await expect(page.locator('[data-command-placement="bottom-bar"]')).toBeVisible({ timeout: 60_000 });
      const layout = await commandLayout(page);
      expect(layout.placement).toBe('bottom-bar');
      expect(new Set(layout.buttons.map((b) => Math.round(b.top))).size, 'one row').toBe(1);
      for (const b of layout.buttons) {
        expect(b.bottom, `${b.label} is in the bottom 60px`).toBeGreaterThan(height - 60);
        expect(b.right, `${b.label} is on screen`).toBeLessThanOrEqual(width);
      }
      expect(layout.barScrollsX).toBe(false);
      expect(layout.pageScrollsX).toBe(false);
      await expect(page.locator('[data-tour="ribbon-tabs"]')).toHaveCount(0);
      await attachShot(page, testInfo, `${device}-${width}x${height}`);
    });
  });
}

test.describe('Flip main with a model: the nav row', () => {
  test.use({ viewport: { width: 412, height: 960 }, isMobile: true, hasTouch: true });

  test('#9718 the Home/zoom pill and Panels button share the row above the bar without overlapping', async ({ page }, testInfo) => {
    await openViewer(page, true);
    await expect(page.locator('[data-mobile-panels-launcher]')).toBeVisible({ timeout: 180_000 });
    const pill = await boxOf(page, '[data-mobile-nav-pill]');
    const panels = await boxOf(page, '[data-mobile-panels-launcher]');
    const bar = await boxOf(page, '[data-command-surface="mobile"]');
    expect(Math.abs((pill.y + pill.height) - (panels.y + panels.height)), 'same baseline').toBeLessThanOrEqual(1);
    expect(pill.x + pill.width, 'pill left of Panels').toBeLessThan(panels.x);
    expect(panels.y + panels.height, 'row above the bar').toBeLessThanOrEqual(bar.y);
    expect(bar.y + bar.height - 960, 'bar flush with the bottom').toBeLessThanOrEqual(1);
    await attachShot(page, testInfo, 'flip-main-412x960-model');
  });
});

test.describe('Flip main on its side 960x412', () => {
  test.use({ viewport: { width: 960, height: 412 }, isMobile: true, hasTouch: true });

  test('#9718 the commands are a rail on the right, inside the landscape safe-area insets', async ({ page }, testInfo) => {
    // An iPhone in landscape: the Dynamic Island side and the home indicator.
    const insets = { top: 0, left: 59, right: 59, bottom: 21 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
    await openViewer(page);
    expect(await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.paddingRight = 'env(safe-area-inset-right)';
      document.body.append(probe);
      const value = getComputedStyle(probe).paddingRight;
      probe.remove();
      return value;
    }), 'the inset override reaches CSS').toBe(`${insets.right}px`);
    await expect(page.locator('[data-command-placement="side-rail"]')).toBeVisible({ timeout: 60_000 });
    const layout = await commandLayout(page);
    expect(new Set(layout.buttons.map((b) => Math.round(b.left))).size, 'one column').toBe(1);
    expect(layout.barScrollsY).toBe(false);
    expect(layout.pageScrollsX).toBe(false);
    const { right, bottom } = insets;
    for (const b of layout.buttons) {
      expect(b.left, `${b.label} is on the right edge`).toBeGreaterThan(960 - 44 - right - 8);
      expect(b.right, `${b.label} clears the right inset`).toBeLessThanOrEqual(960 - right);
      expect(b.bottom, `${b.label} clears the bottom inset`).toBeLessThanOrEqual(412 - bottom);
    }
    const pill = await boxOf(page, '[data-mobile-nav-pill]');
    expect(pill.x, 'the Home/zoom pill clears the left inset').toBeGreaterThanOrEqual(insets.left);
    expect(pill.y + pill.height, 'and the bottom inset').toBeLessThanOrEqual(412 - bottom);
    await attachShot(page, testInfo, 'flip-landscape-960x412');
  });
});

test.describe('Flip FlexWindow cover 360x400', () => {
  test.use({ viewport: { width: 360, height: 400 }, isMobile: true, hasTouch: true });

  test('#9718 every command fits with no sideways scroll, and the model keeps half the height with a sheet open', async ({ page }, testInfo) => {
    await openViewer(page);
    await expect(page.locator('[data-command-placement="bottom-bar"]')).toBeVisible({ timeout: 60_000 });
    const layout = await commandLayout(page);
    expect(layout.buttons.length).toBe(7);
    expect(layout.barScrollsX).toBe(false);
    expect(layout.pageScrollsX).toBe(false);
    for (const b of layout.buttons) expect(b.right, `${b.label} is on screen`).toBeLessThanOrEqual(360);
    const area = await boxOf(page, '[data-mobile-shell] > div');
    expect(area.height, 'the model keeps at least half the height').toBeGreaterThanOrEqual(200);
    await attachShot(page, testInfo, 'cover-360x400');

    await page.evaluate(() => {
      const store = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): { setLeftPanelCollapsed(v: boolean): void } } }).__ifc_lite_viewer_store__;
      store.getState().setLeftPanelCollapsed(false);
    });
    const sheet = page.locator('[data-mobile-sheet]');
    await expect(sheet).toBeVisible();
    await expect.poll(async () => Math.round((await sheet.boundingBox())?.height ?? 0)).toBe(200);
    await attachShot(page, testInfo, 'cover-360x400-sheet');
  });
});

test.describe('desktop 1600x1000', () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test('#9718 a mouse desktop keeps the ribbon on top and no mobile bar', async ({ page }, testInfo) => {
    await openViewer(page);
    const ribbon = page.locator('[data-tour="ribbon-tabs"]');
    await expect(ribbon).toBeVisible({ timeout: 60_000 });
    expect((await ribbon.boundingBox())!.y).toBeLessThan(120);
    await expect(page.locator('[data-command-surface="mobile"]')).toHaveCount(0);
    await attachShot(page, testInfo, 'desktop-1600x1000');
  });
});

test.describe('Flip in Flex Mode (half folded, tabletop) 412x960', () => {
  test.use({ viewport: { width: 412, height: 960 }, isMobile: true, hasTouch: true });

  test('#9718 two viewport segments classify as a tabletop fold, and unfolding restores the phone layout', async ({ page }, testInfo) => {
    const cdp = await page.context().newCDPSession(page);
    // A horizontal hinge across the middle: the Viewport Segments API then reports two stacked segments.
    await cdp.send('Emulation.setDisplayFeaturesOverride', { features: [{ orientation: 'horizontal', offset: 470, maskLength: 20 }] });
    await openViewer(page);
    await expect(page.locator('[data-command-surface="mobile"]')).toBeVisible({ timeout: 60_000 });
    const formFactor = () => page.evaluate(() => {
      const store = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): { formFactor: { mode: string; fold?: { orientation: string } } } } }).__ifc_lite_viewer_store__;
      const { mode, fold } = store.getState().formFactor;
      return { mode, fold: fold?.orientation ?? null };
    });
    await expect.poll(formFactor).toEqual({ mode: 'folded', fold: 'tabletop' });
    await attachShot(page, testInfo, 'flip-flex-mode-412x960');
    await cdp.send('Emulation.clearDisplayFeaturesOverride');
    // Unfolding fires resize in a real browser; the override alone may not.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect.poll(formFactor).toEqual({ mode: 'phone-portrait', fold: null });
  });
});
