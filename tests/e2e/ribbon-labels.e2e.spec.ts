/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5395: no large ribbon button may clip its label sideways.
 *
 * The large button used to be a fixed 56 px wide, so a single word wider than
 * its ~48 px label box ("Orthographic") could not wrap and was cut off with no
 * ellipsis ("Orthograpl"). Only a real layout engine can see this, so it runs
 * in the browser: every tab of the ribbon is opened and every label is
 * measured. No model is loaded; the ribbon renders its buttons without one.
 */

import { test, expect } from '@playwright/test';

test('#5395: every large ribbon button label fits its button', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  const tabs = page.locator('[role="tablist"] [role="tab"]');
  await expect(tabs.first()).toBeVisible({ timeout: 120000 });

  const tabCount = await tabs.count();
  expect(tabCount).toBeGreaterThan(1);

  const clipped: string[] = [];
  let measured = 0;
  for (let i = 0; i < tabCount; i++) {
    const tab = tabs.nth(i);
    const tabName = (await tab.textContent())?.trim() ?? `#${i}`;
    await tab.click();
    await page.keyboard.press('Escape'); // close a File backstage before measuring
    // The large button's label is the only `data-ribbon-label` element.
    // A tab without large buttons (File opens a backstage) measures nothing.
    await page.waitForTimeout(300);
    const labels = page.locator('[data-ribbon-label]');
    const overflow = await labels.evaluateAll((els) => els.map((el) => ({
      text: el.textContent ?? '',
      // 1 px of slack for sub-pixel rounding of text metrics.
      clipped: el.scrollWidth > el.clientWidth + 1,
    })));
    measured += overflow.length;
    for (const o of overflow) if (o.clipped) clipped.push(`${tabName}: ${o.text}`);
  }

  expect(measured).toBeGreaterThan(0);
  expect(clipped).toEqual([]);
});
