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
  await page.getByRole('tab', { name: 'View', exact: true }).click({ force: true });
  await page.getByRole('tabpanel', { name: 'View' })
    .getByRole('button', { name: /Theme, toolbar, tooltips/ }).click({ force: true });
  const dialog = page.locator('[data-settings-dialog]');
  await dialog.getByRole('tab', { name: 'Performance' }).click({ force: true });
  await expect(dialog.getByText('Geometry workers: 4')).toBeVisible();
  await expect(dialog.getByText('Saved in this browser', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset Geometry workers' }).click({ force: true });
  await expect(dialog.getByText('Geometry workers: 4')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ifc-lite-geom-workers'))).toBeNull();
});
