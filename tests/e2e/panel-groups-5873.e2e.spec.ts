/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';

test('#5873 groups the rail and ribbon panels around an authored IFC model', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const loaded = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[ifc-lite] Added model building-architecture.ifc'),
    timeout: 120000,
  });
  await page.goto('/?model=/samples/building-architecture.ifc');
  await loaded;

  const rail = page.locator('[data-activity-bar]');
  await expect(rail.locator('[data-panel-group="coordinate"]')).toHaveText('Coordinate');
  await expect(rail.locator('[data-panel-group="check"]')).toHaveText('Check');
  await expect(rail.locator('[data-panel-group="quantify"]')).toHaveText('Quantify');
  await expect(rail.locator('[data-panel-group="automate"]')).toHaveText('Automate');
  await expect(rail.locator('[data-panel-group="site"]')).toHaveText('Site');

  await page.getByRole('tab', { name: 'Analyze' }).click();
  const browserButton = page.getByRole('button', { name: 'Browse panels' });
  const icon = browserButton.locator('svg').first();
  await expect(icon).toHaveAttribute('viewBox', '0 0 24 24');
  const paints = await icon.locator('[fill]').evaluateAll((parts) => parts.map((part) => part.getAttribute('fill')));
  expect(paints).toContain('currentColor');
  expect(paints).toContain('var(--viewer-icon-accent)');
  await expect(icon.locator('[stroke-width="2"]')).toHaveCount(0);
  await browserButton.click();
  const menu = page.getByRole('menu');
  await expect(menu.locator('[data-panel-group="coordinate"]')).toHaveText('Coordinate');
  await expect(menu.locator('[data-panel-group="site"]')).toHaveText('Site');
  await page.screenshot({ path: testInfo.outputPath('authored-ifc-panel-browser.png'), fullPage: true });
  await menu.locator('[data-panel-id="pointclouds"]').click();
  await expect(page.getByRole('status').filter({ hasText: 'Load a point cloud' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('authored-ifc-panel-groups.png'), fullPage: true });
});
