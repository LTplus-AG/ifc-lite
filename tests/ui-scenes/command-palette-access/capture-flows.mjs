#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8947 R1: add named actual destinations; capture-contexts and its six scenes stay frozen.
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SCENES } from '../scenes.mjs';
const outIndex = process.argv.indexOf('--out');
if (outIndex < 0 || !process.argv[outIndex + 1]) throw new Error('--out is required');
const out = resolve(process.argv[outIndex + 1]);
await mkdir(out, { recursive: true });
const records = [];
const desktop = { width: 1440, height: 900 };
const narrow = { width: 390, height: 844 };
const fixture = '/samples/building-architecture.ifc';
async function run(page, id, query) {
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Command palette', exact: true });
  const search = dialog.getByRole('combobox');
  await expect(search).toBeFocused();
  await search.fill(query);
  const row = dialog.locator(`[data-command-id="${id}"]`);
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute('aria-disabled', 'true');
  const count = await dialog.getByRole('option').count();
  for (let n = 0; n < count && await row.getAttribute('aria-selected') !== 'true'; n++) await search.press('ArrowDown');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await search.press('Enter');
  await expect(dialog).toBeHidden();
}
function flow(id, title, model, viewport, execute) {
  SCENES.push({ id, title, model, viewport, async run({ page }) {
    const outcome = await execute(page);
    // The common protocol re-homes after scene.run. Preserve the actual tool/camera state first.
    const theme = await page.locator('html').evaluate(el => el.classList.contains('dark') ? 'dark' : 'light');
    const file = `${id}.${theme}.actual.png`;
    await page.screenshot({ path: resolve(out, file) });
    records.push({ id, theme, viewport, file, outcome });
    await writeFile(resolve(out, 'flow-observations.json'), JSON.stringify(records, null, 2) + '\n');
  } });
}
flow('flow-settings-privacy', 'Keyboard → actual Privacy controls', null, desktop, async page => {
  await run(page, 'settings:privacy', 'action log');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('tab', { name: 'Privacy', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(settings.locator('#settings-analytics-opt-out')).toBeVisible();
  return { destination: 'Settings / Privacy' };
});
flow('flow-narrow-display', 'Narrow keyboard → actual Display controls', null, narrow, async page => {
  await run(page, 'settings:display', 'navigation preset');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('tab', { name: 'Display', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(settings.getByText('SpaceMouse', { exact: true }).first()).toBeVisible();
  return { destination: 'Settings / Display' };
});
flow('flow-hidden-wall', 'Selected real IFC wall → hidden renderer owner', fixture, desktop, async page => {
  const id = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...s.models.values()][0];
    const index = model.ifcDataStore.entityIndex.byType;
    const expressId = (index.get('IFCWALL') ?? index.get('IFCWALLSTANDARDCASE'))?.[0];
    if (expressId === undefined) throw new Error('Bundled IFC has no wall');
    const id = s.toGlobalId(model.id, expressId);
    s.setSelectedEntityIds([id]); s.setSelectedEntityId(id);
    return id;
  });
  await run(page, 'vis:hide', 'Hide Selection');
  await expect.poll(() => page.evaluate(id => globalThis.__ifc_lite_render_visibility__().hiddenIds.includes(id), id)).toBe(true);
  return { id, rendererHidden: true };
});
flow('flow-measure-quantities', 'Keyboard → actual measurement Qty body', fixture, desktop, async page => {
  await run(page, 'measure-panel:quantities', 'measurements quantities');
  await expect(page.getByRole('tablist', { name: 'Measurements', exact: true }).getByRole('tab', { name: 'Qty', exact: true })).toHaveAttribute('aria-selected', 'true');
  return { destination: 'Measurements / Qty' };
});
flow('flow-blank-wall', 'New blank → parsed IFC and active wall tool', null, desktop, async page => {
  await run(page, 'file:new-blank', 'New blank model');
  await expect.poll(() => page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return s.models.size === 1 && s.session?.activeCommandId === 'wall.place' &&
      [...s.models.values()].some(m => m.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.length);
  }), { timeout: 180_000 }).toBeTruthy();
  await expect(page.getByRole('navigation', { name: 'Model tools', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Thickness', exact: true })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave the command', exact: true })).toBeVisible();
  return { destination: 'Model / wall.place' };
});
flow('flow-camera-corner', 'Keyboard → actual camera corner before common re-home', fixture, desktop, async page => {
  const before = await page.evaluate(() => globalThis.__ifc_lite_view_projection__());
  await run(page, 'view:orientation:front-right-top', 'front right top');
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_view_projection__())).not.toEqual(before);
  await expect.poll(async () => {
    const a = await page.evaluate(() => globalThis.__ifc_lite_view_projection__());
    await page.waitForTimeout(100);
    const b = await page.evaluate(() => globalThis.__ifc_lite_view_projection__());
    return a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  }).toBe(true);
  return { matrix: await page.evaluate(() => globalThis.__ifc_lite_view_projection__()) };
});
// Appends the unchanged six baseline access contexts and invokes the existing GPU/CDP protocol.
await import('./capture-contexts.mjs');
