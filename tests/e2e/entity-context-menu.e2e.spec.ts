/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5819: exercise the Radix menu's actual browser focus and keyboard behavior over an authored IFC. */
import { test, expect, type Page } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

async function openWallMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId, model] = [...state.models][0];
    const entities = model.ifcDataStore!.entities;
    const wall = [...entities.expressId].find((id) => entities.getTypeName(id) === 'IfcWall');
    if (wall == null) throw new Error('authored sample has no IfcWall');
    state.openContextMenu(state.toGlobalId(modelId, wall), 320, 240);
  });
}

test('authored IFC entity menu exposes actions, arrow navigation, submenu and focus return (#5819)', async ({ page }, info) => {
  await page.goto('/?model=/samples/building-architecture.ifc');
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0);
  }, undefined, { timeout: 180_000 });

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
});
