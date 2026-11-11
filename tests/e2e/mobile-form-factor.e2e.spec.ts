/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9718: where the commands sit, per form factor, in real Chrome device
 * emulation: a bar under the viewport on portrait phones (and the cover
 * screen, with nothing scrolling sideways), a rail on the right of a phone on
 * its side, the ribbon on top of a desktop. The landscape case also emulates
 * the iPhone's landscape safe-area insets and checks no control sits under them.
 *
 * And where an open panel sits (PR B): a non-modal pane beside the model on a
 * phone on its side and on a near-tablet, with the model still taking input;
 * in a fold (a CDP device-metrics display feature) the viewport fills one
 * segment exactly and nothing interactive sits on the hinge.
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
    // With a model: the Home/zoom pill mounts with the 3D viewport, not on the empty start screen.
    await openViewer(page, true);
    expect(await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.paddingRight = 'env(safe-area-inset-right)';
      document.body.append(probe);
      const value = getComputedStyle(probe).paddingRight;
      probe.remove();
      return value;
    }), 'the inset override reaches CSS').toBe(`${insets.right}px`);
    await expect(page.locator('[data-command-placement="side-rail"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-mobile-nav-pill]')).toBeVisible({ timeout: 180_000 });
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
    // The cover sheet opens at half of its own area (the viewport above the bar),
    // not of the window, so the model keeps the other half in view.
    await expect.poll(async () => Math.abs(((await sheet.boundingBox())?.height ?? 0) - area.height / 2)).toBeLessThanOrEqual(1);
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
    // Chrome applies a display feature through the device metrics override (setDisplayFeaturesOverride
    // alone leaves one segment), so the metrics Playwright set are restated here with the hinge.
    const metrics = { width: 412, height: 960, deviceScaleFactor: 2.625, mobile: true };
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...metrics, displayFeature: { orientation: 'horizontal', offset: 470, maskLength: 20 } });
    await openViewer(page);
    expect(await page.evaluate(() => (window as Window & { viewport?: { segments: unknown[] | null } }).viewport?.segments?.length ?? 0), 'the browser reports two segments').toBe(2);
    await expect(page.locator('[data-command-surface="mobile"]')).toBeVisible({ timeout: 60_000 });
    const formFactor = () => page.evaluate(() => {
      const store = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): { formFactor: { mode: string; fold?: { orientation: string } } } } }).__ifc_lite_viewer_store__;
      const { mode, fold } = store.getState().formFactor;
      return { mode, fold: fold?.orientation ?? null };
    });
    await expect.poll(formFactor).toEqual({ mode: 'folded', fold: 'tabletop' });
    await attachShot(page, testInfo, 'flip-flex-mode-412x960');
    await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
    // Unfolding fires resize in a real browser; the override alone may not.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect.poll(formFactor).toEqual({ mode: 'phone-portrait', fold: null });
  });
});

type ViewerStore = { getState(): Record<string, unknown> & {
  setLeftPanelCollapsed(v: boolean): void;
  setRightPanelCollapsed(v: boolean): void;
  setSelectedEntityId(id: number | null): void;
  models: Map<string, { geometryResult?: { meshes: Array<{ expressId: number }> } }>;
} };

/** Run against the viewer store in the page. */
async function withStore<T>(page: Page, fn: (store: ViewerStore) => T): Promise<T> {
  return page.evaluate(`(${fn.toString()})(globalThis.__ifc_lite_viewer_store__)`) as Promise<T>;
}

/**
 * Every interactive control's visible box: its rect clipped by every ancestor
 * that clips overflow, so a control scrolled out of its container (the empty
 * state's links below the viewport segment's edge) counts only where a finger
 * can actually reach it. Fully clipped controls drop out.
 */
async function controlBoxes(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="button"], [role="tab"]')]
    .flatMap((el) => {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return [];
      const r = el.getBoundingClientRect();
      let { left, right, top, bottom } = r;
      for (let a = el.parentElement; a; a = a.parentElement) {
        const o = getComputedStyle(a);
        if (o.overflowX === 'visible' && o.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        left = Math.max(left, c.left); right = Math.min(right, c.right);
        top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom);
      }
      if (right - left <= 0 || bottom - top <= 0) return [];
      return [{ label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? el.tagName, left, right, top, bottom }];
    }));
}

/** The model area still takes input: what sits at its centre is the canvas, and a tap there reaches it. */
async function expectViewportInteractive(page: Page): Promise<void> {
  const view = await boxOf(page, '[data-mobile-viewport]');
  const cx = view.x + view.width / 2;
  const cy = view.y + view.height / 2;
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName ?? null, [cx, cy]), 'nothing covers the model').toBe('CANVAS');
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-mobile-viewport] canvas')!;
    (window as unknown as { __tapped: boolean }).__tapped = false;
    canvas.addEventListener('pointerdown', () => { (window as unknown as { __tapped: boolean }).__tapped = true; }, { once: true });
  });
  await page.touchscreen.tap(cx, cy);
  expect(await page.evaluate(() => (window as unknown as { __tapped: boolean }).__tapped), 'a tap on the model reaches the canvas').toBe(true);
}

test.describe('Flip main on its side 960x412 with a panel open', () => {
  test.use({ viewport: { width: 960, height: 412 }, isMobile: true, hasTouch: true });

  test('#9718 Properties docks as a pane between the model and the rail; the model stays interactive and the pane follows the selection', async ({ page }, testInfo) => {
    await openViewer(page, true);
    await expect(page.locator('[data-mobile-panels-launcher]')).toBeVisible({ timeout: 180_000 });
    await page.locator('[data-mobile-panels-launcher]').click();
    const list = page.locator('[data-mobile-pane="side-pane"] [data-mobile-panel-list]');
    await expect(list, 'the Panels list opens in the pane, not a sheet').toBeVisible();
    await list.getByRole('button', { name: 'Properties', exact: true }).click();
    const pane = page.locator('[data-mobile-pane="side-pane"]');
    await expect(pane).toBeVisible();
    await expect(page.locator('[data-mobile-sheet]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close panels', exact: true }), 'no scrim').toHaveCount(0);

    const view = await boxOf(page, '[data-mobile-viewport]');
    const paneBox = await boxOf(page, '[data-mobile-pane-slot]');
    const rail = await boxOf(page, '[data-command-surface="mobile"]');
    expect(paneBox.width, 'clamp(280px, 40%, 380px)').toBeCloseTo(380, 0);
    expect(Math.abs(paneBox.x - (view.x + view.width)), 'the pane starts where the model ends').toBeLessThanOrEqual(1);
    expect(Math.abs(rail.x - (paneBox.x + paneBox.width)), 'and the rail where the pane ends').toBeLessThanOrEqual(1);
    expect(view.width, 'the model keeps the rest of the width').toBeGreaterThanOrEqual(960 - 380 - 44 - 1);
    expect(view.height).toBe(412);
    await expectViewportInteractive(page);

    const before = await pane.innerText();
    const selected = await withStore(page, (store) => {
      const model = [...store.getState().models.values()][0];
      const id = model?.geometryResult?.meshes[0]?.expressId ?? null;
      if (id !== null) store.getState().setSelectedEntityId(id);
      return id;
    });
    expect(selected, 'the sample has geometry to select').not.toBeNull();
    await expect.poll(() => pane.innerText(), { message: 'Properties follows the selection live' }).not.toBe(before);
    await attachShot(page, testInfo, 'flip-landscape-960x412-pane');
  });
});

test.describe('Z Fold inner 830x750 (near-tablet) with a panel open', () => {
  test.use({ viewport: { width: 830, height: 750 }, isMobile: true, hasTouch: true });

  test('#9718 Hierarchy docks as a pane right of the model, the bar under both', async ({ page }, testInfo) => {
    await openViewer(page);
    await expect(page.locator('[data-command-placement="bottom-bar"]')).toBeVisible({ timeout: 60_000 });
    await withStore(page, (store) => store.getState().setLeftPanelCollapsed(false));
    await expect(page.locator('[data-mobile-pane="side-pane"]')).toBeVisible();
    await expect(page.locator('[data-mobile-sheet]')).toHaveCount(0);
    const view = await boxOf(page, '[data-mobile-viewport]');
    const paneBox = await boxOf(page, '[data-mobile-pane-slot]');
    const bar = await boxOf(page, '[data-command-surface="mobile"]');
    expect(paneBox.width).toBeCloseTo(360, 0);
    expect(Math.abs(paneBox.x + paneBox.width - 830), 'the pane is on the trailing edge').toBeLessThanOrEqual(1);
    expect(Math.abs(paneBox.x - (view.x + view.width))).toBeLessThanOrEqual(1);
    expect(paneBox.y + paneBox.height, 'above the bar').toBeLessThanOrEqual(bar.y + 1);
    expect(bar.width, 'the bar spans both').toBeGreaterThanOrEqual(829);
    await attachShot(page, testInfo, 'zfold-inner-830x750-pane');
  });
});

for (const fold of [
  { name: 'Flex Mode (tabletop)', width: 412, height: 960, feature: { orientation: 'horizontal', offset: 470, maskLength: 20 }, view: { x: 0, y: 0, width: 412, height: 470 }, hinge: { axis: 'y', from: 470, to: 490 } },
  { name: 'half-open Fold (book)', width: 830, height: 750, feature: { orientation: 'vertical', offset: 405, maskLength: 20 }, view: { x: 0, y: 0, width: 405, height: 750 }, hinge: { axis: 'x', from: 405, to: 425 } },
] as const) {
  test.describe(`${fold.name} ${fold.width}x${fold.height}`, () => {
    test.use({ viewport: { width: fold.width, height: fold.height }, isMobile: true, hasTouch: true });

    test(`#9718 the viewport fills one segment, controls and panels the other, nothing on the hinge (${fold.name})`, async ({ page }, testInfo) => {
      const cdp = await page.context().newCDPSession(page);
      // The hinge goes through the device metrics override, as in the Flex Mode test above
      // (setDisplayFeaturesOverride alone leaves one segment in Chrome 153 and Chromium 156).
      const metrics = { width: fold.width, height: fold.height, deviceScaleFactor: 2.625, mobile: true };
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...metrics, displayFeature: fold.feature });
      // Device Posture (Chrome 132+): the classifier keys on the segments, but a folded posture is what a device reports with them.
      const posture = await cdp.send('Emulation.setDevicePostureOverride', { posture: { type: 'folded' } }).then(() => 'set', (e: Error) => `unsupported: ${e.message}`);
      testInfo.annotations.push({ type: 'device-posture', description: posture });
      await openViewer(page);
      const segments = await page.evaluate(() => (window as unknown as { viewport?: { segments?: DOMRect[] } }).viewport?.segments?.length ?? 0);
      expect(segments, 'CDP display features produce window.viewport.segments').toBe(2);
      const viewport = page.locator('[data-mobile-viewport]');
      await expect(page.locator('[data-mobile-shell][data-mobile-panel-host="segment"]')).toBeVisible({ timeout: 60_000 });
      const view = await boxOf(page, '[data-mobile-viewport]');
      expect(view, 'the viewport is exactly the first segment').toEqual(fold.view);

      // No panel open: the Panels list inline in the control segment, no floating button.
      await expect(page.locator('[data-mobile-pane="segment"] [data-mobile-panel-list]')).toBeVisible();
      await expect(page.locator('[data-mobile-panels-launcher]')).toHaveCount(0);
      const offHinge = async () => {
        for (const c of await controlBoxes(page)) {
          const [lo, hi] = fold.hinge.axis === 'y' ? [c.top, c.bottom] : [c.left, c.right];
          expect(hi <= fold.hinge.from || lo >= fold.hinge.to, `${c.label} (${lo}-${hi}) is clear of the hinge`).toBe(true);
        }
      };
      await offHinge();
      await attachShot(page, testInfo, `fold-${fold.feature.orientation}-${fold.width}x${fold.height}-list`);

      await page.locator('[data-mobile-panel-list]').getByRole('button', { name: 'Hierarchy', exact: true }).click();
      await expect(page.locator('[data-mobile-pane="segment"]')).toContainText('Hierarchy');
      expect(await boxOf(page, '[data-mobile-viewport]'), 'opening a panel leaves the viewport segment alone').toEqual(fold.view);
      await offHinge();
      await attachShot(page, testInfo, `fold-${fold.feature.orientation}-${fold.width}x${fold.height}-panel`);

      // Unfold live: the panel stays open, now in the unfolded host.
      await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await expect(page.locator('[data-mobile-shell]')).not.toHaveAttribute('data-mobile-panel-host', 'segment');
      expect(await withStore(page, (store) => store.getState().leftPanelCollapsed), 'unfolding kept the panel open').toBe(false);
      await expect(viewport).toHaveCount(1);
    });
  });
}
