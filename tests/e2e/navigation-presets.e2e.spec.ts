/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const IFC = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

test('trackpad swipe pans the live viewport without zooming; pinch zooms (#5889)', async ({ page }) => {
  test.skip(!existsSync(IFC), `${IFC} missing — run \`pnpm fixtures\``);
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

  const result = await page.evaluate(() => {
    type Point = { x: number; y: number; z: number };
    type Viewpoint = { position: Point; target: Point };
    const store = (globalThis as { __ifc_lite_viewer_store__: {
      getState(): { cameraCallbacks: { getViewpoint(): Viewpoint } };
      setState(value: object): void;
    } }).__ifc_lite_viewer_store__;
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
    if (!canvas) throw new Error('main viewer canvas missing');
    store.setState({ navigationPreset: 'trackpad' });
    const viewpoint = () => store.getState().cameraCallbacks.getViewpoint();
    const distance = (v: Viewpoint) => Math.hypot(
      v.position.x - v.target.x, v.position.y - v.target.y, v.position.z - v.target.z,
    );
    const before = viewpoint();
    const swipe = new WheelEvent('wheel', { deltaX: 30, deltaY: 0, cancelable: true, bubbles: true });
    canvas.dispatchEvent(swipe);
    const afterSwipe = viewpoint();
    const pinch = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, cancelable: true, bubbles: true });
    canvas.dispatchEvent(pinch);
    const afterPinch = viewpoint();
    return {
      swipePrevented: swipe.defaultPrevented,
      pinchPrevented: pinch.defaultPrevented,
      targetBefore: before.target,
      targetAfterSwipe: afterSwipe.target,
      distanceBefore: distance(before),
      distanceAfterSwipe: distance(afterSwipe),
      distanceAfterPinch: distance(afterPinch),
    };
  });

  expect(result.swipePrevented).toBe(true);
  expect(result.targetAfterSwipe).not.toEqual(result.targetBefore);
  expect(result.distanceAfterSwipe).toBeCloseTo(result.distanceBefore, 6);
  expect(result.pinchPrevented).toBe(true);
  expect(result.distanceAfterPinch).not.toBeCloseTo(result.distanceAfterSwipe, 6);
});
