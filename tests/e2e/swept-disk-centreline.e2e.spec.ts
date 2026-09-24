/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real Revit IFC and production WebGPU witness for the selected directrix (#5778). */
import { expect, test } from '@playwright/test';
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
  const before = await capture();
  expect(before, 'renderer produced a baseline color frame').toMatch(/^data:image\/png;base64,/);

  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().setCentrelineOverlayEnabled(true));
  await expect.poll(capture, { timeout: 120_000, message: 'enabling the directrix changes the production color frame' })
    .not.toBe(before);
  const visible = await capture();
  expect(visible).toMatch(/^data:image\/png;base64,/);
  await testInfo.attach('Snowdon selected centreline', {
    body: Buffer.from(visible!.split(',')[1], 'base64'), contentType: 'image/png',
  });

  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().setCentrelineOverlayEnabled(false));
  await expect.poll(capture, { timeout: 120_000, message: 'clearing the directrix restores the baseline frame' })
    .toBe(before);
});
