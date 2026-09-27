/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real Revit IFC and production WebGPU witness for the selected directrix (#5778). */
import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = process.env.REBAR_IFC ?? join(process.cwd(), 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc');

type BrowserState = {
  models: Map<string, { id: string; ifcDataStore?: { entityCount: number } | null }>;
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

test('selected Revit bar draws and clears its source centreline (#5778)', async ({ page }, testInfo) => {
  test.skip(!existsSync(FIXTURE), `Revit Snowdon IFC missing at ${FIXTURE}; provide REBAR_IFC for this uncatalogued fixture`);
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles(FIXTURE);
  await page.waitForFunction(() => {
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__?: BrowserStore }).__ifc_lite_viewer_store__;
    const state = store?.getState();
    const model = state?.models.values().next().value;
    return state?.models.size === 1 && state.geometryResult?.meshes?.length > 0
      && (model?.ifcDataStore?.entityCount ?? 0) > 0;
  }, undefined, { timeout: 300_000 });

  await page.evaluate(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    if (!model) throw new Error('loaded IFC model is missing');
    const id = state.toGlobalId(model.id, 132347);
    state.setSelectedEntity({ modelId: model.id, expressId: 132347 });
    state.setSelectedEntityId(id);
    state.setSelectedEntityIds([id]);
    state.cameraCallbacks.frameEntities?.([id]);
  });
  await page.waitForFunction(() => Boolean((globalThis as unknown as { __ifc_lite_capture_color_frame__?: unknown }).__ifc_lite_capture_color_frame__));
  const capture = () => page.evaluate(() => (globalThis as unknown as {
    __ifc_lite_capture_color_frame__: () => Promise<string | null>;
  }).__ifc_lite_capture_color_frame__());
  let before = await capture();
  expect(before, 'renderer produced a baseline color frame').toMatch(/^data:image\/png;base64,/);
  if (!before) throw new Error('renderer produced no baseline color frame');
  await expect.poll(async () => {
    const next = await capture();
    if (!next) return Infinity;
    const changed = (await frameChange(page, before!, next, 10)).changed;
    before = next;
    return changed;
  }, { timeout: 120_000, message: 'the model-only color frame settles before comparing the overlay' })
    .toBeLessThan(20);

  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().setCentrelineOverlayEnabled(true));
  await expect.poll(async () => {
    const frame = await capture();
    return frame ? (await frameChange(page, before!, frame, 30)).changed : 0;
  }, { timeout: 120_000, message: 'enabling the directrix draws visible source pixels' })
    .toBeGreaterThan(100);
  const visible = await capture();
  expect(visible).toMatch(/^data:image\/png;base64,/);
  if (!visible) throw new Error('renderer produced no overlay color frame');
  await testInfo.attach('Snowdon selected centreline', {
    body: Buffer.from(visible.split(',')[1], 'base64'), contentType: 'image/png',
  });

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
