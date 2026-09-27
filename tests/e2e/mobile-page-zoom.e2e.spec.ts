/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('#5843 mobile page permits browser zoom', async ({ page }) => {
  await page.goto('/');
  const directives = (await page.locator('meta[name="viewport"]').getAttribute('content'))!
    .split(',').map(part => part.trim());
  expect(directives).toContain('width=device-width');
  expect(directives).toContain('initial-scale=1.0');
  expect(directives).toContain('viewport-fit=cover');
  expect(directives).not.toContain('user-scalable=no');
  const maximumScale = directives.find(part => part.startsWith('maximum-scale='));
  if (maximumScale) expect(Number(maximumScale.split('=')[1])).toBeGreaterThanOrEqual(5);
});
