/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8946: browser layout, native focus traversal and canonical command execution. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// English labels below: pin the browser language the viewer's Auto locale follows (#9061).
test.use({ locale: 'en-US' });

const sizes = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
  { name: 'short', width: 800, height: 400 },
] as const;

function controls(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
  return {
    dialog,
    search: dialog.getByRole('combobox', { name: 'Search commands', exact: true }),
    list: dialog.getByRole('listbox', { name: 'Search commands', exact: true }),
    close: dialog.getByRole('button', { name: 'Close', exact: true }),
    options: dialog.getByRole('option'),
  };
}

async function openPalette(page: Page) {
  // Wait for a real entry control so the shortcut cannot race React hydration.
  await expect(page.getByRole('button', { name: /Commands…|More actions/ }).first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const ui = controls(page);
  await expect(ui.dialog).toBeVisible();
  await expect(ui.search).toBeFocused();
  await expect(ui.search).toHaveValue('');
  return ui;
}

async function expectWithinViewport(locator: Locator) {
  await expect.poll(() => locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
      && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1;
  }), { message: 'rendered control fits within the viewport' }).toBe(true);
}

async function expectSearchTop(search: Locator, initialTop: number) {
  await expect.poll(async () => {
    const rect = await search.boundingBox();
    return rect ? Math.abs(rect.y - initialTop) : Number.POSITIVE_INFINITY;
  }, { message: 'filtering does not move the search field vertically' }).toBeLessThanOrEqual(1);
}

async function expectActiveVisible(page: Page) {
  const { search, list, options } = controls(page);
  await expect(search).toBeFocused();
  const selected = options.and(page.locator('[aria-selected="true"]'));
  await expect(selected).toHaveCount(1);
  await expect(search).toHaveAttribute('aria-activedescendant', (await selected.getAttribute('id'))!);
  // toBeVisible alone also passes for an offscreen option inside a scrollbox.
  await expect.poll(async () => {
    const [row, viewport] = await Promise.all([selected.boundingBox(), list.boundingBox()]);
    return !!row && !!viewport && row.y >= viewport.y - 1
      && row.y + row.height <= viewport.y + viewport.height + 1;
  }, { message: 'active descendant is fully visible inside the result scrollport' }).toBe(true);
}

async function openSettingsWithEnter(page: Page) {
  const { dialog, search } = controls(page);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  await search.fill('Settings');
  const settings = dialog.getByRole('option', { name: 'Settings…', exact: true });
  await expect(settings).toHaveAttribute('aria-selected', 'true');
  await expect(search).toHaveAttribute('aria-activedescendant', (await settings.getAttribute('id'))!);
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  // Check the destination UI, rather than a store flag or a mocked command.
  const destination = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(destination).toBeVisible();
  await expect(destination.getByRole('tab', { name: 'General', exact: true })).toBeVisible();
}

test.describe('#8946 unloaded palette UX', () => {
  test.beforeEach(async ({ page }) => {
    // Same no-GPU path as command-palette-entry; these tests exercise UI only.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
      localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
    });
  });

  for (const size of sizes) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${size.name} ${theme}: bounded dialog and stable search across result heights`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.addInitScript(value => localStorage.setItem('ifc-lite-theme', value), theme);
        await page.goto('/');
        if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
        else await expect(page.locator('html')).not.toHaveClass(/\b(dark|colorful)\b/);
        const { dialog, search, options } = await openPalette(page);
        await expect(options.first()).toBeVisible();
        // A semantic leading stripe remains visible in both light and dark themes.
        const indicator = await options.first().evaluate(element => {
          const style = getComputedStyle(element, '::before');
          return { width: parseFloat(style.width), color: style.backgroundColor };
        });
        expect(indicator.width).toBeGreaterThanOrEqual(2);
        expect(indicator.color).not.toBe('rgba(0, 0, 0, 0)');
        const initial = await search.boundingBox();
        expect(initial).not.toBeNull();
        const initialCount = await options.count();
        expect(initialCount, 'browse offers a long command list').toBeGreaterThan(10);
        await expectWithinViewport(dialog);
        await expectWithinViewport(search);
        await testInfo.attach('browse.png', { body: await page.screenshot(), contentType: 'image/png' });

        await search.fill('annot');
        // #8962 adds the canonical class filter, whose real controls include annotations.
        const annotationCommands = [
          ['tool:annotate', 'Annotate'],
          ['vis:ifcAnnotations', 'Annotations'],
          ['elements:class-filter', 'Filter'],
        ] as const;
        await expect(options).toHaveCount(annotationCommands.length);
        for (const [index, [id, label]] of annotationCommands.entries()) {
          await expect(options.nth(index)).toHaveAttribute('data-command-id', id);
          await expect(options.nth(index)).toHaveAttribute('aria-label', label);
        }
        await expectSearchTop(search, initial!.y);
        await search.fill('secton');
        await expect(options.first()).toContainText('Section');
        await expectSearchTop(search, initial!.y);

        await search.fill('Settings');
        await expect(dialog.getByRole('option', { name: 'Settings…', exact: true })).toBeVisible();
        await expect.poll(() => options.count()).toBeLessThan(initialCount);
        await expectWithinViewport(dialog);
        await expectSearchTop(search, initial!.y);

        await search.fill('zzzz-no-palette-command-8946');
        await expect(options).toHaveCount(0);
        await expect(dialog.getByRole('status')).toHaveText('No results');
        await expect(dialog.getByText('navigate', { exact: false })).toHaveCount(0);
        await expect(dialog.getByText('run', { exact: false })).toHaveCount(0);
        await expectWithinViewport(dialog);
        await expectWithinViewport(dialog.getByRole('button', { name: 'Clear search', exact: true }));
        await expectSearchTop(search, initial!.y);
        await testInfo.attach('empty.png', { body: await page.screenshot(), contentType: 'image/png' });

        await dialog.getByRole('button', { name: 'Clear search', exact: true }).click();
        await expect(search).toHaveValue('');
        await expect(search).toBeFocused();
        await expect.poll(() => options.count()).toBeGreaterThan(10);
        await expect(options.first()).toHaveAttribute('aria-selected', 'true');
        await expectSearchTop(search, initial!.y);
        await expectWithinViewport(dialog);
      });
    }
  }

  test('native Tab and Shift+Tab stay in the dialog and skip result options', async ({ page }) => {
    await page.goto('/');
    const { search, close, dialog } = await openPalette(page);
    // Two complete cycles catch both a leaked focus trap and tabbable rows.
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(search).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(close).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(search).toBeFocused();
    }

    await search.fill('zzzz-no-palette-command-8946');
    const clear = dialog.getByRole('button', { name: 'Clear search', exact: true });
    await expect(clear).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(clear).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(search).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(clear).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('');
  });

  test('short viewport: arrow keys scroll the active row into view without moving focus', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 800, height: 400 });
    await page.goto('/');
    const { options, list, search } = await openPalette(page);
    const count = await options.count();
    expect(count).toBeGreaterThan(10);
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    for (let i = 1; i < count; i++) await page.keyboard.press('ArrowDown');
    await expect(options.last()).toHaveAttribute('aria-selected', 'true');
    await expectActiveVisible(page);
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await testInfo.attach('scrolled-active-row.png', { body: await page.screenshot(), contentType: 'image/png' });
    for (let i = 1; i < count; i++) await page.keyboard.press('ArrowUp');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expectActiveVisible(page);
    await expectWithinViewport(search);
  });

  test('Escape/reopen resets query and active row; Enter opens the canonical Settings UI', async ({ page }, testInfo) => {
    await page.goto('/');
    const { dialog, search, options } = await openPalette(page);
    await search.fill('view');
    await expect.poll(() => options.count()).toBeGreaterThan(1);
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await openPalette(page);
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expectActiveVisible(page);
    await openSettingsWithEnter(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeHidden();
    await openPalette(page);
    await expect(options.first()).toHaveAttribute('aria-label', 'Settings…');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expectActiveVisible(page);
    await testInfo.attach('recent-settings-selected.png', { body: await page.screenshot(), contentType: 'image/png' });
  });
});

test('#8946 loaded bundled IFC: keyboard command reaches real Settings UI', async ({ page }, testInfo) => {
  const sample = 'apps/viewer/public/samples/building-architecture.ifc';
  test.skip(!existsSync(join(process.cwd(), sample)), `${sample} missing — restore the bundled sample (pnpm fixtures for external models)`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
  });
  // Do not disable WebGPU here: this must traverse the actual sample loader.
  await page.goto('/?model=/samples/building-architecture.ifc');
  await expect.poll(() => page.evaluate(() => {
    // Read-only readiness signal used by the existing authored-model specs.
    const store = (globalThis as typeof globalThis & {
      __ifc_lite_viewer_store__?: { getState(): {
        models: Map<string, { ifcDataStore?: { entities: { count: number } } }>;
        loading: boolean; geometryStreamingActive: boolean;
      } };
    }).__ifc_lite_viewer_store__;
    const state = store?.getState();
    return !!state && state.models.size === 1 && !state.loading && !state.geometryStreamingActive
      && ([...state.models.values()][0].ifcDataStore?.entities.count ?? 0) > 0;
  }), { timeout: 180_000, message: 'bundled IFC finishes loading and geometry streaming' }).toBe(true);
  await expect(page.locator('canvas').first()).toBeVisible();
  await openPalette(page);
  await expectWithinViewport(controls(page).dialog);
  await testInfo.attach('loaded-palette.png', { body: await page.screenshot(), contentType: 'image/png' });
  await openSettingsWithEnter(page);
});

// Separate from the acknowledged-disclosure fixtures above: reproduce the real
// first-visit toast and test rendered stacking, rather than just z-index values.
test('#8946 short viewport: privacy notice stays below palette and survives close', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 400 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    localStorage.removeItem('ifclite.extensions.privacy-disclosure.v2');
  });
  await page.goto('/');
  const notice = page.locator('[data-toast-seq]').filter({ hasText: 'IFClite stores an action log' });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  const noticeSequence = await notice.getAttribute('data-toast-seq');
  // The disclosure hook records its own timestamp when shown; palette actions
  // must neither acknowledge it again nor dismiss the pending notification.
  const acknowledgement = await page.evaluate(() => localStorage.getItem('ifclite.extensions.privacy-disclosure.v2'));
  const { dialog, search, options } = await openPalette(page);
  for (const query of ['', 'annot', 'zzzz-no-palette-command-8946']) {
    await search.fill(query);
    if (query.startsWith('zzzz')) await expect(options).toHaveCount(0);
    else await expect(options.first()).toBeVisible();
    const footer = dialog.locator('div').filter({ has: page.locator('kbd') }).last();
    await expectWithinViewport(footer);
    expect(await footer.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return [0.1, 0.5, 0.9].every(fraction => {
        const hit = document.elementFromPoint(rect.left + rect.width * fraction, rect.top + rect.height / 2);
        return !!hit && element.contains(hit);
      });
    }), 'footer remains above the toast at every result height').toBe(true);
    expect(await notice.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !!hit && !element.contains(hit);
    }), 'palette scrim/content covers the notice').toBe(true);
  }
  await testInfo.attach('unacknowledged-notice-palette.png', { body: await page.screenshot(), contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-toast-seq', noticeSequence!);
  expect(await page.evaluate(() => localStorage.getItem('ifclite.extensions.privacy-disclosure.v2'))).toBe(acknowledgement);
  expect(await notice.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!hit && element.contains(hit);
  }), 'original notice is exposed again after closing').toBe(true);
});
