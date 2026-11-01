/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5874: a returning classic-toolbar user starts in the sole desktop ribbon. */
import { expect, test } from '@playwright/test';

test('#5874 clears a stored classic choice during startup and opens the ribbon', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    // This runs before the viewer's modules, unlike a helper call after mount.
    localStorage.setItem('ifc-lite-toolbar-style', 'classic');
    sessionStorage.setItem('ifc-lite:e2e-classic-seeded', 'yes');
  });

  await page.goto('/');
  expect(await page.evaluate(() => sessionStorage.getItem('ifc-lite:e2e-classic-seeded'))).toBe('yes');
  await expect(page.locator('[data-tour="ribbon-tabs"]')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ifc-lite-toolbar-style'))).toBeNull();
});
