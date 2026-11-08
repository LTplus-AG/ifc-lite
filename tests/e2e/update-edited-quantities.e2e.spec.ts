/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser witness for "Update quantities of edited elements" (#9026 item 20
 * follow-up) on a third party's file: an ArchiCAD wall of AC20-FZK-Haus, whose
 * `BaseQuantities` the file wrote (4.17 x 0.24 x 2.5 m). Resized through the
 * Model inspector's Height field, read on the Quantities tab with the setting
 * off and on, undone and redone, exported through the File dialog and reopened.
 */
import { test, expect, type Page } from '@playwright/test';
import { copyFileSync, existsSync } from 'node:fs';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

const IFC = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
/** `Wand-Int-ERDG-4`, an IfcWallStandardCase extruded 2.5 m with a `BaseQuantities` set. */
const WALL = 15042;

async function waitForModel(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    const model = state?.models.values().next().value;
    return state?.models.size === 1 && (state.geometryResult?.meshes?.length ?? 0) > 0 && (model?.ifcDataStore?.entityCount ?? 0) > 0;
  }, undefined, { timeout: 300_000 });
  return page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().models.values()][0]!.id);
}

async function selectWall(page: Page, modelId: string): Promise<void> {
  await page.evaluate(({ modelId, expressId }) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setSelectedEntity({ modelId, expressId });
    const globalId = state.toGlobalId(modelId, expressId);
    state.setSelectedEntityId(globalId);
    state.setSelectedEntityIds([globalId]);
    state.setPropertiesActiveTab('quantities');
    state.setRightPanelCollapsed(false);
  }, { modelId, expressId: WALL });
}

/** The wall's `BaseQuantities` card on the Quantities tab. */
const baseQuantities = (page: Page) => page.getByRole('tabpanel').filter({ hasText: 'BaseQuantities' }).first();
/** The tab rounds to at most four places: ArchiCAD's 2.49624 m³ shows as 2.496(2), the refreshed 3.0024 as 3.002(4). */
const FILE_VOLUME = /GrossVolume\s*2[.,]496/;
const REFRESHED_VOLUME = /GrossVolume\s*3[.,]002/;

test('a loaded wall\'s base quantities follow a resize only with the setting on (#9026)', async ({ page }, testInfo) => {
  test.skip(!existsSync(IFC), `${IFC} missing; run pnpm fixtures`);
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles(IFC);
  const modelId = await waitForModel(page);
  await selectWall(page, modelId);

  const tab = baseQuantities(page);
  const toggle = page.locator('#quantities-update-edited');
  await expect(toggle, 'a loaded wall offers the switch').toBeVisible({ timeout: 60_000 });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(tab).toContainText(FILE_VOLUME);

  // Resize through the inspector, the way a person does.
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().enterModelWorkspace())).toBe(true);
  await selectWall(page, modelId);
  const height = page.getByLabel('Height in metres');
  await height.fill('3');
  await height.press('Enter');
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().exitModelWorkspace());
  await selectWall(page, modelId);

  // Off: the file's values stay, unmarked.
  await expect(tab).toContainText(FILE_VOLUME);
  await expect(page.getByText('Updated from geometry')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('off.png'), fullPage: true });

  // On: the set follows the geometry and says so.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Updated from geometry').first()).toBeVisible();
  await expect(tab).toContainText(REFRESHED_VOLUME);
  const refreshedHeight = await page.evaluate(({ modelId, expressId }) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const set = state.mutationViews.get(modelId)!.getQuantitiesForEntity(expressId).find((q) => q.name === 'BaseQuantities');
    return Object.fromEntries(set?.quantities.map((q) => [q.name, q.value]) ?? []);
  }, { modelId, expressId: WALL });
  expect(refreshedHeight.Height).toBe(3);
  // A quantity the resize did not change keeps ArchiCAD's own value, measured its own way.
  expect(refreshedHeight.Length).toBe(4.17);
  expect(refreshedHeight.GrossVolume).toBeCloseTo(3.0024, 6);
  await page.screenshot({ path: testInfo.outputPath('on.png'), fullPage: true });
  await testInfo.attach('refreshed quantities', { path: testInfo.outputPath('on.png'), contentType: 'image/png' });

  // Undo takes the refresh back with the resize; redo brings both.
  await page.evaluate((modelId) => globalThis.__ifc_lite_viewer_store__.getState().undo(modelId), modelId);
  await expect(tab).toContainText(FILE_VOLUME);
  await expect(page.getByText('Updated from geometry')).toHaveCount(0);
  await page.evaluate((modelId) => globalThis.__ifc_lite_viewer_store__.getState().redo(modelId), modelId);
  await expect(page.getByText('Updated from geometry').first()).toBeVisible();

  // The export carries what the tab shows.
  await page.getByRole('tab', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Export IFC (with changes)', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export IFC File' });
  await dialog.waitFor();
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloading;
  const exported = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(exported);
  if (process.env.UPDATE_EDITED_QUANTITIES_EXPORT) copyFileSync(exported, process.env.UPDATE_EDITED_QUANTITIES_EXPORT);

  const reopened = await page.context().newPage();
  await reopened.goto('/');
  await reopened.locator('#file-input-open').setInputFiles(exported);
  const reopenedId = await waitForModel(reopened);
  const fromFile = await reopened.evaluate(({ modelId, expressId }) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const set = state.mutationViews.get(modelId)!.getQuantitiesForEntity(expressId).filter((q) => q.name === 'BaseQuantities');
    return set.map((s) => Object.fromEntries(s.quantities.map((q) => [q.name, q.value])));
  }, { modelId: reopenedId, expressId: WALL });
  expect(fromFile).toEqual([refreshedHeight]);
});
