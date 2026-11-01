/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5853: authored IFC on a phone reaches registry panels and clears stale sheets. */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('mobile Panels opens Clash and direct Properties after dismissing Lists (#5853)', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
  });
  await page.goto('/?model=/samples/building-architecture.ifc');
  await expect(page.getByRole('button', { name: 'Open the panel list' })).toBeVisible({ timeout: 180_000 });

  await page.getByRole('button', { name: 'Open the panel list' }).click();
  const list = page.locator('ul').filter({ has: page.getByRole('button', { name: 'Clash detection', exact: true }) });
  expect(await list.locator(':scope > li > button').count()).toBeGreaterThan(10);
  await list.getByRole('button', { name: 'Clash detection', exact: true }).click();
  await expect(page.locator('div.absolute.inset-x-0').getByText('Clash detection', { exact: true }).first()).toBeVisible();
  await testInfo.attach('mobile-panels-clash.png', { body: await page.screenshot(), contentType: 'image/png' });

  await page.getByRole('button', { name: 'Close panels', exact: true }).click({ position: { x: 190, y: 30 } });
  await page.getByRole('button', { name: 'Open the panel list' }).click();
  await page.locator('ul').filter({ has: page.getByRole('button', { name: 'Lists', exact: true }) })
    .getByRole('button', { name: 'Lists', exact: true }).click();
  await expect(page.locator('div.absolute.inset-x-0').getByText('Lists', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Close panels', exact: true }).click({ position: { x: 190, y: 30 } });
  await page.getByRole('button', { name: 'Open Properties', exact: true }).click();
  await expect(page.locator('div.absolute.inset-x-0').getByText('Properties', { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__: { getState(): {
      rightPanelCollapsed: boolean; sidebarActivePanel: string; listPanelVisible: boolean;
    } } }).__ifc_lite_viewer_store__;
    const { rightPanelCollapsed, sidebarActivePanel, listPanelVisible } = store.getState();
    return { rightPanelCollapsed, sidebarActivePanel, listPanelVisible };
  })).toEqual({ rightPanelCollapsed: false, sidebarActivePanel: 'properties', listPanelVisible: false });
});
