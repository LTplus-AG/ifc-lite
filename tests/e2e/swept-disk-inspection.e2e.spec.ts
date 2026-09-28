/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Browser witness for #5783 against an IFC2X3 Revit Snowdon reinforcement model. */
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = process.env.REBAR_IFC ?? join(process.cwd(), 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc');
type BrowserState = {
  models: Map<string, { id: string; ifcDataStore?: { entityCount: number } | null }>;
  geometryResult?: { meshes: unknown[] };
  selectedDirectrixSegment?: { expressId: number } | null;
  toGlobalId(modelId: string, expressId: number): number;
  setSelectedEntity(ref: { modelId: string; expressId: number }): void;
  setSelectedEntityId(id: number): void;
  setSelectedEntityIds(ids: number[]): void;
  setPropertiesActiveTab(tab: 'quantities'): void;
  setRightPanelCollapsed(collapsed: boolean): void;
  toggleWorkspacePanel(panel: 'measurements'): void;
  cameraCallbacks: { frameEntities?: (ids: number[]) => void };
};
type BrowserStore = { getState(): BrowserState };

test('selected Revit bar shows exact source geometry and measurement readout (#5783)', async ({ page }, testInfo) => {
  test.skip(!existsSync(FIXTURE), `Revit Snowdon IFC missing at ${FIXTURE}; run pnpm fixtures or provide REBAR_IFC`);
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
    const expressId = 132347;
    state.setSelectedEntity({ modelId: model.id, expressId });
    const globalId = state.toGlobalId(model.id, expressId);
    state.setSelectedEntityId(globalId);
    state.setSelectedEntityIds([globalId]);
    state.cameraCallbacks.frameEntities?.([globalId]);
    state.setPropertiesActiveTab('quantities');
    state.setRightPanelCollapsed(false);
  });
  const source = page.getByRole('region', { name: 'Derived source geometry' });
  await expect(source.getByRole('region', { name: /IfcSweptDiskSolid/ }).first()).toBeVisible({ timeout: 120_000 });
  await expect(source).toContainText('Total centreline length');
  await expect(source).toContainText('3.61642');
  await expect(source).toContainText('9.525 mm');
  await expect(source).toContainText('Bend magnitude');
  const segment = source.getByRole('button', { name: /Segment 1/ }).first();
  await page.waitForFunction(() => Boolean((globalThis as unknown as { __ifc_lite_capture_color_frame__?: unknown }).__ifc_lite_capture_color_frame__));
  const capture = () => page.evaluate(() => (globalThis as unknown as {
    __ifc_lite_capture_color_frame__: () => Promise<string | null>;
  }).__ifc_lite_capture_color_frame__());
  const baseline = await capture();
  expect(baseline, 'renderer produced a baseline color frame').toMatch(/^data:image\/png;base64,/);
  await segment.click();
  await expect(segment).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() =>
    (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState().selectedDirectrixSegment?.expressId,
  )).toBe(132347);
  await expect.poll(capture, { timeout: 120_000, message: 'selecting a source segment changes the production color frame' })
    .not.toBe(baseline);
  const selectedFrame = await capture();
  expect(selectedFrame).toMatch(/^data:image\/png;base64,/);
  await testInfo.attach('Snowdon selected source segment', {
    body: Buffer.from(selectedFrame!.split(',')[1], 'base64'), contentType: 'image/png',
  });
  const screenshot = testInfo.outputPath('snowdon-swept-disk-inspection.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('Snowdon swept-disk inspection', { path: screenshot, contentType: 'image/png' });

  await page.evaluate(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    state.toggleWorkspacePanel('measurements');
  });
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  const measureSource = page.getByRole('region', { name: 'Derived source geometry' });
  await expect(measureSource).toContainText('3.61642');
  const measureScreenshot = testInfo.outputPath('snowdon-swept-disk-measurements.png');
  await page.screenshot({ path: measureScreenshot, fullPage: true });
  await testInfo.attach('Snowdon source measurements', { path: measureScreenshot, contentType: 'image/png' });
});
