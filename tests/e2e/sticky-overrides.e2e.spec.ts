/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';

test('#5860 saved worker override is visible and resettable in Settings', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('ifc-lite-geom-workers', '4');
    // Settings rendering does not need a GPU; avoid software-adapter stalls.
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  });
  await page.goto('/');
  // #5857: preferences remain reachable without opening View, even collapsed.
  await page.getByRole('button', { name: 'Collapse the ribbon', exact: true }).click({ force: true });
  const settings = page.locator('button[data-command-id="pref:settings"]');
  await expect(settings).toBeVisible();
  await expect(settings).toHaveAccessibleName('Settings');
  await settings.hover();
  await expect(page.getByRole('tooltip')).toContainText('Theme, tooltips, navigation devices and other preferences');
  await settings.click({ force: true });
  const dialog = page.locator('[data-settings-dialog]');
  await dialog.getByRole('tab', { name: 'Performance' }).click({ force: true });
  await expect(dialog.getByText('Geometry workers: 4')).toBeVisible();
  await expect(dialog.getByText('Saved in this browser', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset Geometry workers' }).click({ force: true });
  await expect(dialog.getByText('Geometry workers: 4')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ifc-lite-geom-workers'))).toBeNull();
});

// #5857: the mobile entry must expose choices without clipping at large text sizes.
test('mobile Settings navigation choices fit the dialog at increased text size', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.locator('[data-command-id="pref:settings"]').click();
  const dialog = page.locator('[data-settings-dialog]');
  await dialog.getByRole('tab', { name: 'Display', exact: true }).click();
  await page.addStyleTag({ content: 'html { font-size: 32px; }' });
  const choices = dialog.locator('#settings-navigation-preset');
  await choices.scrollIntoViewIfNeeded();
  await expect(choices.getByRole('radio')).toHaveCount(3);
  const bounds = await choices.boundingBox();
  const dialogBounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(dialogBounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(dialogBounds!.x);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(dialogBounds!.x + dialogBounds!.width);
  expect(await choices.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
