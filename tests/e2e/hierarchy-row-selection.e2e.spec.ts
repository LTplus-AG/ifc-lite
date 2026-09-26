/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5885: real authored IFC rows select; visibility and filter changes need an explicit action. */
import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

const ARCHITECTURE = 'tests/models/buildingsmart/Building-Architecture.ifc';
const HVAC = 'tests/models/buildingsmart/Building-Hvac.ifc';

async function waitForModels(page: Page, count: number): Promise<void> {
  await page.waitForFunction((n) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === n && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0);
  }, count, { timeout: 180_000 });
}

async function selectionState(page: Page) {
  return page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return {
      modelCount: state.models.size,
      selectedGlobalIds: [...state.selectedEntityIds],
      selectedRefs: [...state.selectedEntitiesSet],
      filterGroups: JSON.stringify(state.searchFilter.groups),
      classFilterNull: state.classFilter === null,
      isolatedIds: state.isolatedEntities ? [...state.isolatedEntities] : null,
      levelDisplayMode: state.levelDisplayMode,
      selectedStoreys: [...state.selectedStoreys],
    };
  });
}

test('authored IFC hierarchy rows select across 1/N models; actions alone change visibility (#5885)', async ({ page }, info) => {
  test.skip(!existsSync(ARCHITECTURE) || !existsSync(HVAC), 'buildingSMART fixtures missing — run pnpm fixtures');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.waitForFunction(() => !!globalThis.__ifc_lite_viewer_store__, undefined, { timeout: 120_000 });
  await page.locator('#file-input-open').setInputFiles(ARCHITECTURE);
  await waitForModels(page, 1);

  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setHierarchyMode('type'));
  const classRow = page.locator('[data-hierarchy-node-type="type-group"]').first();
  await expect(classRow).toBeVisible();
  const beforeClass = await selectionState(page);
  await classRow.click();
  const afterClass = await selectionState(page);
  expect(afterClass.modelCount).toBe(1);
  expect(afterClass.selectedGlobalIds.length).toBeGreaterThan(0);
  expect(afterClass.selectedRefs.length).toBeGreaterThan(0);
  expect(afterClass.filterGroups).toBe(beforeClass.filterGroups);
  expect(afterClass.classFilterNull).toBe(true);
  expect(afterClass.isolatedIds).toBeNull();
  await page.screenshot({ path: info.outputPath('hierarchy-class-one-model.png') });

  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setHierarchyMode('material'));
  const materialRow = page.locator('[data-hierarchy-node-type="material-group"]').first();
  await expect(materialRow).toBeVisible();
  const beforeMaterial = await selectionState(page);
  await materialRow.click();
  const afterMaterial = await selectionState(page);
  expect(afterMaterial.selectedGlobalIds.length).toBeGreaterThan(0);
  expect(afterMaterial.isolatedIds).toBeNull();
  expect(afterMaterial.filterGroups).toBe(beforeMaterial.filterGroups);
  await materialRow.hover();
  await materialRow.getByRole('button', { name: /^Isolate / }).click();
  expect((await selectionState(page)).isolatedIds?.length).toBeGreaterThan(0);

  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().clearIsolation());
  await page.locator('#file-input-add').setInputFiles(HVAC);
  await waitForModels(page, 2);
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setHierarchyMode('spatial'));
  const storeyRow = page.locator('[data-hierarchy-node-type="unified-storey"]').first();
  await expect(storeyRow).toBeVisible();
  const beforeStorey = await selectionState(page);
  await storeyRow.click();
  const afterStorey = await selectionState(page);
  expect(afterStorey.modelCount).toBe(2);
  expect(afterStorey.selectedRefs.length).toBeGreaterThan(0);
  expect(afterStorey.levelDisplayMode).toBe(beforeStorey.levelDisplayMode);
  expect(afterStorey.selectedStoreys).toEqual(beforeStorey.selectedStoreys);
  expect(afterStorey.filterGroups).toBe(beforeStorey.filterGroups);
  await page.screenshot({ path: info.outputPath('hierarchy-storey-two-models.png') });

  await storeyRow.hover();
  await storeyRow.getByRole('button', { name: /^Solo storey / }).click();
  expect((await selectionState(page)).levelDisplayMode).toBe('solo');
});
