/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Browser witness for #5783 against authored swept-disk geometry. */
import { test, expect } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { sweptDiskFixture, sweptDiskIsolationPath } from './swept-disk-fixture.js';
import { skipForGpuDeviceLoss, watchGpuDeviceLoss } from './gpu-device-loss.js';

type BrowserState = {
  models: Map<string, { id: string; ifcDataStore?: { entityCount: number } | null }>;
  geometryResult?: { meshes: unknown[] };
  selectedDirectrixSegment?: { expressId: number } | null;
  toGlobalId(modelId: string, expressId: number): number;
  setSelectedEntity(ref: { modelId: string; expressId: number }): void;
  setSelectedEntityId(id: number): void;
  setSelectedEntityIds(ids: number[]): void;
  setIsolatedEntities(ids: Set<number> | null): void;
  setPropertiesActiveTab(tab: 'quantities'): void;
  setRightPanelCollapsed(collapsed: boolean): void;
  toggleWorkspacePanel(panel: 'measurements'): void;
  cameraCallbacks: { frameEntities?: (ids: number[]) => void };
};
type BrowserStore = { getState(): BrowserState };

test('selected swept-disk bar shows exact source geometry and measurement readout (#5783)', async ({ page }, testInfo) => {
  test.skip(!existsSync(sweptDiskIsolationPath), `Swept-disk IFC missing at ${sweptDiskIsolationPath}; run pnpm fixtures or provide REBAR_IFC`);
  test.setTimeout(600_000);
  const gpu = await watchGpuDeviceLoss(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles(sweptDiskIsolationPath);
  await page.waitForFunction(() => {
    const store = (globalThis as unknown as { __ifc_lite_viewer_store__?: BrowserStore }).__ifc_lite_viewer_store__;
    const state = store?.getState();
    const model = state?.models.values().next().value;
    return state?.models.size === 1 && state.geometryResult?.meshes?.length > 0
      && (model?.ifcDataStore?.entityCount ?? 0) > 0;
  }, undefined, { timeout: 300_000 });
  await page.evaluate((expressId) => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    if (!model) throw new Error('loaded IFC model is missing');
    state.setSelectedEntity({ modelId: model.id, expressId });
    const globalId = state.toGlobalId(model.id, expressId);
    state.setSelectedEntityId(globalId);
    state.setSelectedEntityIds([globalId]);
    state.cameraCallbacks.frameEntities?.([globalId]);
    state.setPropertiesActiveTab('quantities');
    state.setRightPanelCollapsed(false);
  }, sweptDiskFixture.expressId);
  const source = page.getByRole('region', { name: 'Derived source geometry' });
  await expect(source.getByRole('region', { name: /IfcSweptDiskSolid/ }).first()).toBeVisible({ timeout: 120_000 });
  await expect(source).toContainText('Total centreline length');
  await expect(source).toContainText(sweptDiskFixture.totalLengthPrefix);
  await expect(source).toContainText(sweptDiskFixture.radiusText);
  await expect(source).toContainText('Bend magnitude');
  await expect(source.getByRole('button', { name: /Segment \d+/ })).toHaveCount(sweptDiskFixture.segmentCount);
  const segment = source.getByRole('button', { name: /Segment 1/ }).first();

  await page.evaluate(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    state.toggleWorkspacePanel('measurements');
  });
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  const measureSource = page.getByRole('region', { name: 'Derived source geometry' });
  await expect(measureSource).toContainText(sweptDiskFixture.totalLengthPrefix);
  const measureScreenshot = testInfo.outputPath('swept-disk-measurements.png');
  await page.screenshot({ path: measureScreenshot, fullPage: true });
  await testInfo.attach(`${sweptDiskFixture.label} source measurements`, { path: measureScreenshot, contentType: 'image/png' });
  await page.evaluate(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    state.toggleWorkspacePanel('measurements');
  });

  await page.waitForFunction(() => Boolean((globalThis as unknown as { __ifc_lite_capture_color_frame__?: unknown }).__ifc_lite_capture_color_frame__));
  const capture = () => page.evaluate(() => (globalThis as unknown as {
    __ifc_lite_capture_color_frame__: () => Promise<string | null>;
  }).__ifc_lite_capture_color_frame__());
  let baseline: string | null = null;
  let captureThrew = false;
  try {
    await expect.poll(async () => {
      try {
        baseline = await capture();
      } catch (error) {
        captureThrew = true;
        throw error;
      }
      return baseline;
    }, { timeout: 30_000, message: 'renderer produces a baseline color frame before segment highlighting' })
      .toMatch(/^data:image\/png;base64,/);
  } catch (error) {
    if (!captureThrew && baseline === null && gpu.evidence) skipForGpuDeviceLoss('segment highlighting', gpu.evidence);
    throw error;
  }
  expect(baseline, 'renderer produced a baseline color frame').toMatch(/^data:image\/png;base64,/);
  await segment.click();
  await expect(segment).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() =>
    (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState().selectedDirectrixSegment?.expressId,
  )).toBe(sweptDiskFixture.expressId);
  await expect.poll(capture, { timeout: 120_000, message: 'selecting a source segment changes the production color frame' })
    .not.toBe(baseline);
  const selectedFrame = await capture();
  expect(selectedFrame).toMatch(/^data:image\/png;base64,/);
  await testInfo.attach(`${sweptDiskFixture.label} selected source segment`, {
    body: Buffer.from(selectedFrame!.split(',')[1], 'base64'), contentType: 'image/png',
  });
  const screenshot = testInfo.outputPath('swept-disk-inspection.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach(`${sweptDiskFixture.label} swept-disk inspection`, { path: screenshot, contentType: 'image/png' });
  if (process.env.INSPECTION_WITNESS_PNG) {
    await page.screenshot({ path: process.env.INSPECTION_WITNESS_PNG, fullPage: true });
  }

  // Keep the source/measurement checks above in the full model. Isolate only
  // for the visual witness so surrounding concrete cannot occlude this bar.
  // The pixel change below is only meaningful when something else is in the
  // model for isolation to remove (see sweptDiskIsolationPath); a lone bar
  // re-frames to the identical image, on any GPU.
  expect(
    await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
      .__ifc_lite_viewer_store__.getState().geometryResult?.meshes.length ?? 0),
    'isolation witness needs an occluder besides the bar',
  ).toBeGreaterThan(1);
  await page.evaluate((expressId) => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    if (!model) throw new Error('loaded IFC model is missing');
    const id = state.toGlobalId(model.id, expressId);
    state.setIsolatedEntities(new Set([id]));
    state.cameraCallbacks.frameEntities?.([id]);
  }, sweptDiskFixture.expressId);
  await expect.poll(capture, { timeout: 120_000, message: 'isolation redraws the selected swept-disk bar' })
    .not.toBe(selectedFrame);
  const isolatedFrame = await capture();
  expect(isolatedFrame).toMatch(/^data:image\/png;base64,/);
  const isolatedScreenshot = testInfo.outputPath('swept-disk-isolated-bar.png');
  writeFileSync(isolatedScreenshot, Buffer.from(isolatedFrame!.split(',')[1], 'base64'));
  await testInfo.attach(`${sweptDiskFixture.label} isolated swept-disk bar`, { path: isolatedScreenshot, contentType: 'image/png' });
});
