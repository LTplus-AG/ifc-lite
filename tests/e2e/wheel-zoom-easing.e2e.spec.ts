/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9507 - wheel zoom in the real viewer, measured per frame in Chromium.
 *
 * Zooms OUT throughout: zoom-out never picks a surface (#5393), so each ratio
 * depends only on the wheel path, not on what geometry sits under the cursor.
 * A 100 px notch moves the camera by ~10 % of its distance.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const IFC = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

test('wheel zoom eases a notch, bounds a burst and reads line-mode wheels like pixels (#9507)', async ({ page }) => {
  test.skip(!existsSync(IFC), `${IFC} missing — run \`pnpm fixtures\``);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles(join(process.cwd(), IFC));
  await page.waitForFunction(() => {
    const store = (globalThis as { __ifc_lite_viewer_store__?: { getState(): {
      loading: boolean;
      models: Map<string, unknown>;
      cameraCallbacks: { getViewpoint?: () => unknown };
    } } }).__ifc_lite_viewer_store__;
    const state = store?.getState();
    return !!state && !state.loading && state.models.size === 1 && !!state.cameraCallbacks.getViewpoint?.();
  }, undefined, { timeout: 180_000 });

  const result = await page.evaluate(async () => {
    type Point = { x: number; y: number; z: number };
    type Viewpoint = { position: Point; target: Point };
    const store = (globalThis as { __ifc_lite_viewer_store__: {
      getState(): { cameraCallbacks: { getViewpoint(): Viewpoint } };
    } }).__ifc_lite_viewer_store__;
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
    if (!canvas) throw new Error('main viewer canvas missing');
    const rect = canvas.getBoundingClientRect();
    const distance = () => {
      const v = store.getState().cameraCallbacks.getViewpoint();
      return Math.hypot(v.position.x - v.target.x, v.position.y - v.target.y, v.position.z - v.target.z);
    };
    const wheel = (deltaY: number, deltaMode = 0) => canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY, deltaMode, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      bubbles: true, cancelable: true,
    }));
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 500));

    // One notch, sampled every frame.
    const start = distance();
    wheel(100);
    const inEvent = distance() / start;
    const frames: number[] = [];
    for (let i = 0; i < 20; i++) { await nextFrame(); frames.push(distance() / start); }
    await settle();
    const notch = distance() / start;

    // A fast spin: twenty notches inside one task.
    const burstStart = distance();
    for (let i = 0; i < 20; i++) wheel(100);
    await settle();
    const burst = distance() / burstStart;

    // Firefox line mode: three lines is one notch.
    const lineStart = distance();
    wheel(3, 1);
    await settle();
    const line = distance() / lineStart;

    return { inEvent, frames, notch, burst, line };
  });

  console.log(`[#9507 evidence] ${JSON.stringify(result)}`);
  // The response starts in the event, but it is a slice, not the whole jump.
  expect(result.inEvent).toBeGreaterThan(1);
  expect(result.inEvent).toBeLessThan(1.05);
  // It keeps moving over later frames.
  const moving = result.frames.filter((r, i) => r > (i === 0 ? result.inEvent : result.frames[i - 1]) + 1e-9);
  expect(moving.length).toBeGreaterThanOrEqual(5);
  // And lands at about one notch.
  expect(result.notch).toBeGreaterThan(1.09);
  expect(result.notch).toBeLessThan(1.12);
  // Twenty notches at once queue at most about three; the old per-event cap gave 1.1^20 ≈ 6.7.
  expect(result.burst).toBeLessThan(1.5);
  expect(result.burst).toBeGreaterThan(1.2);
  // A line-mode notch zooms like a pixel-mode one.
  expect(result.line).toBeCloseTo(result.notch, 2);
});
