/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';

test('the pivot marker is visible mid-orbit on building-architecture.ifc (#5891)', async ({ page }, testInfo) => {
  test.skip(process.env.E2E_GPU_STRICT === '0', 'pivot screenshot needs the headed GPU lane; CI uses unstable SwiftShader');
  test.setTimeout(90_000);
  const modelLoaded = page.waitForEvent('console', {
    predicate: (message) => message.text().includes('[ifc-lite] Added model building-architecture.ifc'),
    timeout: 45_000,
  });
  await page.goto('/?model=/samples/building-architecture.ifc');
  await modelLoaded;

  const canvas = page.locator('canvas[data-viewport="main"]');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width * 0.55;
  const y = box!.y + box!.height * 0.45;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + 70, y + 35, { steps: 6 });
    const marker = page.locator('[data-orbit-pivot-marker]');
    await expect(marker).toHaveClass(/opacity-100/);
    await expect(marker).toHaveCSS('pointer-events', 'none');
    await expect(marker).toHaveAttribute('aria-hidden', 'true');
    const position = await marker.boundingBox();
    expect(position).not.toBeNull();
    expect(position!.x).toBeGreaterThanOrEqual(box!.x);
    expect(position!.x).toBeLessThan(box!.x + box!.width);
    expect(position!.y).toBeGreaterThanOrEqual(box!.y);
    expect(position!.y).toBeLessThan(box!.y + box!.height);
    await testInfo.attach('building-architecture-mid-orbit.png', {
      body: await page.screenshot(), contentType: 'image/png',
    });
  } finally {
    await page.mouse.up();
  }
  await expect(page.locator('[data-orbit-pivot-marker]')).toHaveClass(/opacity-0/);
});
