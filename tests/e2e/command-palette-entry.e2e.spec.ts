/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Palette entry does not need a GPU. Software WebGPU adapter discovery can
  // stall on CI hosts, so present the browser's unsupported-GPU path here.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  });
});

test('#5862 ribbon Commands button opens the command palette', async ({ page }) => {
  await page.goto('/');
  const entry = page.getByRole('button', { name: /Commands… Ctrl\+K/ });
  await expect(entry).toBeVisible();
  // Software WebGPU keeps the viewer canvas repainting on CI; the button's
  // click handler is the behavior under test, independent of that animation.
  await entry.click({ force: true });
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.getByPlaceholder('What do you need?').fill('cost');
  await expect(palette.getByRole('option', { name: 'Cost', exact: true })).toBeVisible();
});

test.describe('mobile command entry', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('#5862 More actions opens the same command palette', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'More actions' }).click({ force: true });
    await page.getByRole('menuitem', { name: 'Commands…' }).click({ force: true });
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  });
});
