/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type Point3 = { x: number; y: number; z: number };
type ViewerProbeState = {
  cameraCallbacks: {
    getViewpoint?: () => { position: Point3; target: Point3 } | null;
  };
  getActiveModel(): { loadState: string } | undefined;
};

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerProbeState };
}

const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

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

test('#5843 pinching the model changes camera distance without page zoom', async ({ page }) => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), 'Sample IFC missing — run pnpm fixtures');
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), FIXTURE));
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.getActiveModel()?.loadState === 'complete' &&
      Boolean(state.cameraCallbacks.getViewpoint?.());
  }, null, { timeout: 120_000 });

  const canvas = page.locator('canvas[data-viewport="main"]');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2;
  const y = bounds!.y + bounds!.height / 2;
  const distance = () => page.evaluate(() => {
    const view = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.getViewpoint!()!;
    return Math.hypot(
      view.position.x - view.target.x,
      view.position.y - view.target.y,
      view.position.z - view.target.z,
    );
  });
  const before = await distance();
  const cdp = await page.context().newCDPSession(page);
  try {
    const touchPoints = (radius: number) => [
      { x: x - radius, y, id: 1 },
      { x: x + radius, y, id: 2 },
    ];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPoints(25) });
    for (const radius of [40, 60, 85]) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPoints(radius) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await expect.poll(distance).toBeLessThan(before);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
});
