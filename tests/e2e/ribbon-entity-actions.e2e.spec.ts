/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5870: a selected entity reaches the shared actions menu from the ribbon on an authored IFC. */
import { expect, test } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

test.use({ viewport: { width: 1280, height: 900 } });

test('Elements Actions opens the selected authored IFC wall menu and selects its storey (#5870)', async ({ page }, info) => {
  await page.goto('/?model=/samples/building-architecture.ifc');
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0);
  }, undefined, { timeout: 180_000 });

  const wallId = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId, model] = [...state.models][0];
    const wall = [...model.ifcDataStore!.entities.expressId]
      .find((id) => model.ifcDataStore!.entities.getTypeName(id) === 'IfcWall');
    if (wall == null) throw new Error('authored SketchUp sample has no IfcWall');
    const globalId = state.toGlobalId(modelId, wall);
    state.setSelectedEntityIds([globalId]);
    state.setSelectedEntityId(globalId);
    return globalId;
  });

  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  const actions = page.locator('button[data-command-id="elements:entity-actions"]');
  await expect(actions).toBeVisible();
  await expect(actions).toBeEnabled();
  await expect(actions).toHaveAccessibleName('Entity actions');
  await actions.click();
  const menu = page.getByRole('menu', { name: 'Entity actions' });
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().contextMenu.entityId)).toBe(wallId);
  await expect(menu.getByRole('menuitem', { name: 'Select all IfcWall' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Select same storey' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('ribbon-entity-actions-authored-ifc.png') });
  await menu.getByRole('menuitem', { name: 'Select same storey' }).click();
  await expect(menu).toBeHidden();
  expect(await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityIds.has(id), wallId)).toBe(true);
});
