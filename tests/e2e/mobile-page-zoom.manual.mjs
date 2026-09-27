/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #5843 headed Chrome walkthrough. Start the viewer with
// `pnpm --filter @ifc-lite/viewer dev`, then run under a desktop or Xvfb:
//   PAGE_ZOOM_BASE=http://localhost:5173 node tests/e2e/mobile-page-zoom.manual.mjs
// The canvas TouchEvents exercise the viewer's pinch handler. Synthetic events
// cannot verify Chrome's native pinch behavior outside the canvas.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(process.env.PAGE_ZOOM_BASE ?? 'http://localhost:5173');
  await page.getByRole('button', { name: 'Load demo project' }).first().click();
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state && !state.loading && !state.geometryStreamingActive && state.models.size === 1
      && [...state.models.values()].every(model => model.ifcDataStore && model.geometryResult && model.loadState === 'complete');
  }, null, { timeout: 120_000 });

  const snapshot = () => page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const { position, target } = state.cameraCallbacks.getViewpoint();
    const canvas = [...document.querySelectorAll('canvas')]
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    return {
      model: [...state.models.values()][0].name,
      meshes: [...state.models.values()][0].geometryResult.meshes.length,
      cameraDistance: Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z),
      pageScale: visualViewport.scale,
      canvasTouchAction: getComputedStyle(canvas).touchAction,
    };
  });
  const dispatch = (type, spread) => page.evaluate(({ type, spread }) => {
    const canvas = [...document.querySelectorAll('canvas')]
      .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const touch = (identifier, dx) => new Touch({ identifier, target: canvas, clientX: x + dx, clientY: y });
    const touches = spread === null ? [] : [touch(1, -spread), touch(2, spread)];
    const event = new TouchEvent(type, {
      touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true,
    });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, spread });

  const before = await snapshot();
  assert.equal(before.pageScale, 1);
  assert.equal(before.canvasTouchAction, 'none');
  assert.equal(await dispatch('touchstart', 20), true);
  for (let spread = 40; spread <= 160; spread += 20) {
    assert.equal(await dispatch('touchmove', spread), true);
  }
  assert.equal(await dispatch('touchend', null), true);
  const after = await snapshot();
  assert.ok(after.cameraDistance < before.cameraDistance, 'canvas pinch must move the camera closer');
  assert.equal(after.pageScale, 1, 'canvas pinch must leave page scale at 1');

  const screenshot = process.env.PAGE_ZOOM_SCREENSHOT ?? join(tmpdir(), 'ifc-lite-5843-pinch.png');
  await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({ before, after, screenshot }, null, 2));
} finally {
  await browser.close();
}
