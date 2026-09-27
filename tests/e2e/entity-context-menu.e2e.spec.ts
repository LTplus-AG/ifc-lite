/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5819: exercise the Radix menu's actual browser focus and keyboard behavior over an authored IFC. */
import { test, expect, type Page } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_copied_global_id__: string | undefined;
}

async function openWallMenu(page: Page, selectWall = false): Promise<number> {
  return page.evaluate((select) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId, model] = [...state.models][0];
    const entities = model.ifcDataStore!.entities;
    const wall = [...entities.expressId].find((id) => entities.getTypeName(id) === 'IfcWall');
    if (wall == null) throw new Error('authored sample has no IfcWall');
    const globalId = state.toGlobalId(modelId, wall);
    if (select) state.setSelectedEntityIds([globalId]);
    state.openContextMenu(globalId, 320, 240);
    return globalId;
  }, selectWall);
}

async function clickEntityAction(page: Page, label: string, selectWall = false): Promise<number> {
  const globalId = await openWallMenu(page, selectWall);
  const menu = page.getByRole('menu', { name: 'Entity actions' });
  await menu.getByRole('menuitem', { name: label, exact: true }).click();
  await expect(menu).toBeHidden();
  return globalId;
}

test('authored IFC entity menu exposes actions, arrow navigation, submenu and focus return (#5819)', async ({ page }, info) => {
  await page.goto('/?model=/samples/building-architecture.ifc');
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0);
  }, undefined, { timeout: 180_000 });

  await page.getByRole('button', { name: 'Enter edit mode' }).click();

  // The real viewport menu is opened by the picking handler, which has already
  // resolved a renderer ID. Supply that same ID to exercise the shell without
  // depending on a particular camera angle or screen-space wall pixel.
  await page.evaluate(() => {
    const opener = document.createElement('button');
    opener.id = 'context-menu-focus-origin';
    opener.textContent = 'Focus origin';
    document.body.append(opener);
    opener.focus();
  });
  await openWallMenu(page);

  const menu = page.getByRole('menu', { name: 'Entity actions' });
  await expect(menu).toBeVisible();
  const expected = [
    'Frame selection', 'Hide', 'Set Collection', 'Add to Collection',
    'Remove from Collection', 'Save Collection View', 'Select same storey',
    'Copy GlobalId', 'Export anonymized…',
  ];
  for (const label of expected) await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible();

  const frame = menu.getByRole('menuitem', { name: 'Frame selection', exact: true });
  const hintContrast = await frame.locator('span').last().evaluate((hint) => {
    const channels = (color: string) => [...color.matchAll(/[\d.]+/g)].slice(0, 3).map((match) => Number(match[0]) / 255);
    const luminance = (color: string) => {
      const linear = channels(color).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const fg = luminance(getComputedStyle(hint).color);
    const bg = luminance(getComputedStyle(hint.closest('[role="menu"]')!).backgroundColor);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
  expect(hintContrast).toBeGreaterThanOrEqual(4.5);
  await frame.focus();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Hide', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(frame).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();

  const submenu = menu.locator('[role="menuitem"][aria-haspopup="menu"]');
  await expect(submenu).toBeVisible();
  await submenu.focus();
  await page.keyboard.press('ArrowRight');
  const direction = page.getByRole('menuitem', { name: 'Duplicate +X (east)' });
  await expect(direction).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(submenu).toBeFocused();

  await page.screenshot({ path: info.outputPath('entity-context-menu-authored-ifc.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('#context-menu-focus-origin')).toBeFocused();

  await openWallMenu(page);
  await menu.getByRole('menuitem', { name: 'Hide', exact: true }).click();
  await expect(menu).toBeHidden();
  const hidden = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return state.hiddenEntities.size;
  });
  expect(hidden).toBeGreaterThan(0);

  // The canvas variant uses the same Radix shell; Show all must still reach
  // the shared visibility reset after an entity action hid real geometry.
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().openContextMenu(null, 320, 240));
  const canvasMenu = page.getByRole('menu', { name: 'Canvas actions' });
  await canvasMenu.getByRole('menuitem', { name: 'Show all' }).click();
  await expect(canvasMenu).toBeHidden();
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().hiddenEntities.size)).toBe(0);

  // Basket commands must keep their distinct set/add/remove effects after
  // moving from ordinary buttons into Radix menu items.
  await clickEntityAction(page, 'Set Collection', true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pinboardEntities.size)).toBe(1);
  await clickEntityAction(page, 'Remove from Collection', true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pinboardEntities.size)).toBe(0);
  await clickEntityAction(page, 'Add to Collection', true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pinboardEntities.size)).toBe(1);
  // This test covers menu dispatch, not GPU thumbnail capture. In software-GPU
  // CI the device may have been lost by an earlier smoke case, leaving the
  // thumbnail's queue.onSubmittedWorkDone() pending indefinitely. With no
  // viewport canvas, the real save command still creates the collection view.
  const viewportCanvas = await page.locator('canvas[data-viewport="main"]').elementHandle();
  if (!viewportCanvas) throw new Error('authored viewer has no viewport canvas');
  await viewportCanvas.evaluate((canvas) => canvas.removeAttribute('data-viewport'));
  await clickEntityAction(page, 'Save Collection View', true);
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().basketViews.length)).toBeGreaterThan(0);
  await viewportCanvas.evaluate((canvas) => canvas.setAttribute('data-viewport', 'main'));

  await clickEntityAction(page, 'Select all IfcWall');
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityIds.size)).toBeGreaterThan(0);
  await clickEntityAction(page, 'Select same storey');
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityIds.size)).toBeGreaterThan(0);

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => { globalThis.__ifc_lite_copied_global_id__ = value; } },
    });
  });
  await clickEntityAction(page, 'Copy GlobalId');
  expect(await page.evaluate(() => globalThis.__ifc_lite_copied_global_id__?.length ?? 0)).toBeGreaterThan(0);

  const sourceId = await openWallMenu(page);
  // The direct action and the directional submenu both have the accessible
  // name “Duplicate”; pick the button that executes the default action.
  await menu.locator('button[role="menuitem"][aria-label="Duplicate"]').click();
  await expect(menu).toBeHidden();
  const duplicatedId = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId);
  expect(duplicatedId).not.toBeNull();
  expect(duplicatedId).not.toBe(sourceId);
  await openWallMenu(page);
  await menu.locator('[role="menuitem"][aria-haspopup="menu"]').hover();
  await page.getByRole('menuitem', { name: 'Duplicate −X (west)' }).click();
  await expect(menu).toBeHidden();
  const directionalId = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId);
  expect(directionalId).not.toBeNull();
  expect(directionalId).not.toBe(duplicatedId);
  const deletedId = await clickEntityAction(page, 'Delete entity');
  expect(await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().hiddenEntities.has(id), deletedId)).toBe(true);

  await clickEntityAction(page, 'Export anonymized…', true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().anonymizedExportRequested)).toBe(true);
});
