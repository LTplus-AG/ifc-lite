/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Production WebGPU witness for a selected swept-disk directrix (#5778). */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { sweptDiskFixture } from './swept-disk-fixture.js';
import { skipForGpuDeviceLoss, watchGpuDeviceLoss } from './gpu-device-loss.js';

type BrowserState = {
  models: Map<string, { id: string; ifcDataStore?: {
    entityCount: number;
    entities: { getTypeName(id: number): string };
  } | null }>;
  geometryResult?: { meshes: unknown[] };
  toGlobalId(modelId: string, expressId: number): number;
  setSelectedEntity(ref: { modelId: string; expressId: number }): void;
  setSelectedEntityId(id: number): void;
  setSelectedEntityIds(ids: number[]): void;
  setCentrelineOverlayEnabled(enabled: boolean): void;
  cameraCallbacks: { frameEntities?: (ids: number[]) => void };
};
type BrowserStore = { getState(): BrowserState };

/** Compare decoded renderer pixels; GPU shading can drift by a few color levels between frames. */
async function frameChange(
  page: Page, baseline: string, withOverlay: string, threshold: number, afterOff?: string,
): Promise<{ changed: number; restored: number }> {
  return page.evaluate(async ({ baseline, withOverlay, threshold, afterOff }) => {
    const decode = async (source: string): Promise<Uint8ClampedArray> => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Could not decode renderer color frame');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const [before, visible, cleared] = await Promise.all([
      decode(baseline), decode(withOverlay), afterOff ? decode(afterOff) : Promise.resolve(null),
    ]);
    const difference = (a: Uint8ClampedArray, b: Uint8ClampedArray, i: number) =>
      Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    let changed = 0, restored = 0;
    for (let i = 0; i < before.length; i += 4) {
      if (difference(before, visible, i) < threshold) continue;
      changed++;
      if (cleared && difference(before, cleared, i) <= 5) restored++;
    }
    return { changed, restored };
  }, { baseline, withOverlay, threshold, afterOff });
}

test('selected swept-disk bar draws and clears its source centreline (#5778)', async ({ page }, testInfo) => {
  test.skip(!existsSync(sweptDiskFixture.path), `Swept-disk IFC missing at ${sweptDiskFixture.path}; run pnpm fixtures or provide REBAR_IFC`);
  test.setTimeout(600_000);
  const gpu = await watchGpuDeviceLoss(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles(sweptDiskFixture.path);
  await gpu.raceLoss('the model load', () => page.waitForFunction(() => {
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__?: BrowserStore }).__ifc_lite_viewer_store__;
    const state = store?.getState();
    const model = state?.models.values().next().value;
    return state?.models.size === 1 && state.geometryResult?.meshes?.length > 0
      && (model?.ifcDataStore?.entityCount ?? 0) > 0;
  }, undefined, { timeout: 300_000 }));

  const sourceType = await page.evaluate((expressId) => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    if (!model) throw new Error('loaded IFC model is missing');
    const id = state.toGlobalId(model.id, expressId);
    state.setSelectedEntity({ modelId: model.id, expressId });
    state.setSelectedEntityId(id);
    state.setSelectedEntityIds([id]);
    state.cameraCallbacks.frameEntities?.([id]);
    return model.ifcDataStore?.entities.getTypeName(expressId);
  }, sweptDiskFixture.expressId);
  expect(sourceType, 'the loaded IFC contains the authored reinforcing bar').toBe('IfcReinforcingBar');
  await gpu.raceLoss('the colour-frame hook', () => page.waitForFunction(() => Boolean((globalThis as unknown as { __ifc_lite_capture_color_frame__?: unknown }).__ifc_lite_capture_color_frame__)));
  const capture = () => page.evaluate(() => (globalThis as unknown as {
    __ifc_lite_capture_color_frame__: () => Promise<string | null>;
  }).__ifc_lite_capture_color_frame__());
  let before: string | null = null;
  let captureThrew = false;
  try {
    await expect.poll(async () => {
      try {
        before = await capture();
      } catch (error) {
        captureThrew = true;
        throw error;
      }
      return before;
    }, { timeout: 30_000, message: 'renderer produces a baseline color frame' })
      .toMatch(/^data:image\/png;base64,/);
  } catch (error) {
    // Hosted SwiftShader can destroy its device during model load, before this
    // test enables the overlay. The local strict run still requires pixels.
    if (!captureThrew && before === null && gpu.evidence) skipForGpuDeviceLoss('the centreline overlay', gpu.evidence);
    throw error;
  }
  if (!before) throw new Error('renderer produced no baseline color frame');
  await gpu.raceLoss('the model-only frame settling', () => expect.poll(async () => {
    const next = await capture();
    if (!next) return Infinity;
    const changed = (await frameChange(page, before!, next, 10)).changed;
    before = next;
    return changed;
  }, { timeout: 120_000, message: 'the model-only color frame settles before comparing the overlay' })
    .toBeLessThan(20));

  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().setCentrelineOverlayEnabled(true));
  await gpu.raceLoss('the centreline overlay draw', () => expect.poll(async () => {
    const frame = await capture();
    return frame ? (await frameChange(page, before!, frame, 30)).changed : 0;
  }, { timeout: 120_000, message: 'enabling the directrix draws visible source pixels' })
    .toBeGreaterThan(100));
  let visible: string | null = null;
  await expect.poll(async () => {
    visible = await capture();
    return visible;
  }, { timeout: 30_000, message: 'renderer produces an overlay color frame' })
    .toMatch(/^data:image\/png;base64,/);
  if (!visible) throw new Error('renderer produced no overlay color frame');
  const visiblePng = Buffer.from(visible.split(',')[1], 'base64');
  await testInfo.attach(`${sweptDiskFixture.label} selected centreline`, {
    body: visiblePng, contentType: 'image/png',
  });
  if (process.env.CENTRELINE_WITNESS_PNG) writeFileSync(process.env.CENTRELINE_WITNESS_PNG, visiblePng);

  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().setCentrelineOverlayEnabled(false));
  await expect.poll(async () => {
    const frame = await capture();
    if (!frame) return 0;
    const { changed, restored } = await frameChange(page, before!, visible, 30, frame);
    return changed > 100 ? restored / changed : 0;
  }, { timeout: 120_000, message: 'clearing the directrix removes its source pixels' })
    .toBeGreaterThan(0.95);
});
