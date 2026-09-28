/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5874: every desktop command remains reachable after retiring the classic bar. */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 1280, height: 900 } });

const TAB_BUTTON_COUNTS = [
  ['File', 18],
  ['Home', 7],
  ['View', 20],
  ['Elements', 16],
  ['Analyze', 17], // 16 commands plus the panel-browser content trigger (#5873)
  ['Author', 9],
] as const;

test('authored IFC keeps all 86 ribbon commands and panel browser reachable at 1280px (#5874, #5778)', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
  });
  await page.goto('/?model=/samples/building-architecture.ifc');
  await page.waitForFunction(() => {
    const store = (globalThis as typeof globalThis & {
      __ifc_lite_viewer_store__?: { getState(): {
        models: Map<string, { ifcDataStore?: unknown }>;
        loading: boolean;
        geometryStreamingActive: boolean;
      } };
    }).__ifc_lite_viewer_store__;
    const state = store?.getState();
    return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore);
  }, undefined, { timeout: 180_000 });

  const visited: Record<string, string[]> = {};
  for (const [tabName, expectedCount] of TAB_BUTTON_COUNTS) {
    await page.getByRole('tab', { name: tabName, exact: true }).click();
    const band = page.getByRole('tabpanel', { name: tabName, exact: true });
    await expect(band).toBeVisible();
    const buttons = band.locator('button');
    await expect(buttons).toHaveCount(expectedCount);
    const names: string[] = [];

    for (let index = 0; index < expectedCount; index++) {
      const button = buttons.nth(index);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toHaveAccessibleName(/\S/);
      const name = (await button.getAttribute('aria-label')) ?? (await button.textContent())?.trim() ?? '';
      names.push(name);

      const bounds = await button.boundingBox();
      const bandBounds = await band.boundingBox();
      expect(bounds, `${tabName} control ${index} has a layout box`).not.toBeNull();
      expect(bandBounds, `${tabName} ribbon band has a layout box`).not.toBeNull();
      expect(bounds!.x, `${tabName}: ${name} starts inside the scrollable band`).toBeGreaterThanOrEqual(bandBounds!.x - 1);
      expect(bounds!.x + bounds!.width, `${tabName}: ${name} ends inside the scrollable band`)
        .toBeLessThanOrEqual(bandBounds!.x + bandBounds!.width + 1);

      // Trial click checks real pointer actionability without running export,
      // edit, or another state-changing command. Dismiss the previous hover
      // tooltip first so it cannot intercept the next adjacent button.
      if (await button.isEnabled()) {
        await page.mouse.move(5, 5);
        await page.keyboard.press('Escape');
        await button.click({ trial: true, timeout: 5_000 });
      }
    }
    visited[tabName] = names;
    await testInfo.attach(`${tabName.toLowerCase()}-ribbon-last-command.png`, {
      body: await band.screenshot(),
      contentType: 'image/png',
    });
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth, `${tabName} must not force a page-wide horizontal scrollbar`).toBeLessThanOrEqual(1281);
  }

  const browserCount = visited.Analyze.filter((name) => name === 'Browse panels').length;
  expect(visited.View, 'View includes the selected-source centreline command (#5778)').toContain('Centreline');
  expect(browserCount, 'Analyze has one panel-browser content trigger').toBe(1);
  expect(Object.values(visited).reduce((total, names) => total + names.length, 0) - browserCount).toBe(86);
  await testInfo.attach('reachable-ribbon-commands.json', {
    body: JSON.stringify(visited, null, 2),
    contentType: 'application/json',
  });
});
