/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5859: a real finger hold opens the picked entity menu on authored IFC. */
import { expect, test } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';
import type { SceneFaceHitSnapshot } from '../../apps/viewer/src/lib/viewport-debug-hooks';
import { watchGpuDeviceLoss } from './gpu-device-loss';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_scene_face_hits__: (globalId: number) => SceneFaceHitSnapshot[];
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('long press on an authored element opens its context menu once (#5859)', async ({ page }, info) => {
  // Every step past the load needs the renderer's resident scene: a hosted
  // software device lost mid-load never uploads it (#6232 F3).
  const gpu = await watchGpuDeviceLoss(page);
  await page.addInitScript(() => {
    window.localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
  });
  await page.goto('/?model=/samples/building-architecture.ifc');
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0) &&
      typeof globalThis.__ifc_lite_scene_face_hits__ === 'function';
  }, undefined, { timeout: 180_000 });

  const target = await gpu.requireLiveGpu('visible-face search', () => page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId, model] = [...state.models][0];
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
    if (!canvas) throw new Error('viewer canvas is missing');
    const rect = canvas.getBoundingClientRect();
    for (const mesh of model.geometryResult!.meshes) {
      const globalId = state.toGlobalId(modelId, mesh.expressId);
      const hit = globalThis.__ifc_lite_scene_face_hits__(globalId).find(({ screen }) =>
        screen.x > rect.left + 20 && screen.x < rect.right - 20 &&
        screen.y > rect.top + 20 && screen.y < rect.bottom - 20);
      if (hit) return { globalId, ...hit.screen };
    }
    throw new Error('no visible authored element face was found for a long press');
  }));

  const device = await page.context().newCDPSession(page);
  await device.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, id: 1 }] });
  try {
    await gpu.requireLiveGpu('long-press menu', () =>
      expect(page.getByRole('menu', { name: 'Entity actions' })).toBeVisible({ timeout: 10_000 }));
    await gpu.requireLiveGpu('long-press entity pick', () =>
      expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().contextMenu.entityId))
        .toBe(target.globalId));
    await info.attach('mobile-long-press-entity-menu.png', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    await device.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await device.detach();
  }
});
