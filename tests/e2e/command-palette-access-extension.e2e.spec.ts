/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8947 R1: real .iflx installer → owner-qualified palette dock → QuickJS → renderer.
import { chromium, expect, test as base, type Page } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';
import type { RenderVisibilitySnapshot, SceneOwnerSnapshot } from '../../apps/viewer/src/lib/viewport-debug-hooks';
import { packWitness } from './fixtures/palette-access-extension/pack';
import { visibilityOutputWitness } from './command-palette-extension.rendering';

const OWNER = 'org.ifclite.e2e.palette-access';
const TITLE = 'Palette witness dock';
const DESTINATION = `ext-widget:${encodeURIComponent(JSON.stringify([OWNER, 'dock.right', 'palette-witness.dock']))}`;
const test = base.extend({
  browser: async ({ launchOptions, headless, channel }, use) => {
    const browser = process.env.IFC_GPU_CDP_URL
      ? await chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL)
      : await chromium.launch({ ...launchOptions, headless, channel });
    try { await use(browser); } finally { await browser.close(); }
  },
});
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette', exact: true });
const widget = (page: Page) => page.getByRole('dialog', { name: TITLE, exact: true });
const installedRow = (page: Page) => page.getByRole('listitem').filter({ has: page.getByText(OWNER, { exact: true }) });

async function search(page: Page, query: string) {
  if (!await palette(page).isVisible()) await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await palette(page).getByRole('combobox').fill(query);
}
async function openDestination(page: Page, id: string, query: string) {
  await search(page, query);
  const destination = palette(page).locator(`[data-command-id="${id}"]`);
  await expect(destination).toBeVisible();
  await expect(destination).not.toHaveAttribute('aria-disabled', 'true');
  await destination.click();
  await expect(palette(page)).toBeHidden();
}
async function hidden(page: Page, id: number) {
  return page.evaluate(id => (globalThis as typeof globalThis & {
    __ifc_lite_render_visibility__: () => RenderVisibilitySnapshot;
  }).__ifc_lite_render_visibility__().hiddenIds.includes(id), id);
}
async function refused(page: Page, id: number) {
  await search(page, OWNER);
  await expect(palette(page).locator(`[data-command-id="${DESTINATION}"]`)).toHaveCount(0);
  await expect(palette(page).getByRole('option')).toHaveCount(0);
  await palette(page).getByRole('combobox').press('Enter');
  await expect(widget(page)).toHaveCount(0);
  expect(await hidden(page, id)).toBe(false);
  await page.keyboard.press('Escape');
}

test('installed extension dock runs QuickJS on real IFC; UI disable and uninstall retire destination (#8947)', async ({ page }, info) => {
  const pageerrors: string[] = [];
  const commandErrors: string[] = [];
  page.on('console', message => {
    if (message.text().includes('[ExtensionDockHost] command failed:')) commandErrors.push(message.text());
  });
  page.on('pageerror', error => pageerrors.push(error.message));
  try {
    const packed = await packWitness();
    await info.attach('installed-bundle.json', { body: JSON.stringify({ owner: OWNER, sha256: packed.sha256, bytes: packed.bytes }), contentType: 'application/json' });
    await info.attach('palette-access-witness.iflx', { body: packed.upload.buffer, contentType: 'application/octet-stream' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('ifc-lite-theme', 'light');
      localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
      localStorage.setItem('ifc-lite:tours:v1', JSON.stringify({ inviteDismissedAt: '2026-01-01T00:00:00Z', tours: {} }));
    });
    await page.goto('/?lang=en&model=/samples/building-architecture.ifc');
    await page.waitForFunction(() => {
      const state = (globalThis as typeof globalThis & {
        __ifc_lite_viewer_store__?: { getState(): ViewerState };
      }).__ifc_lite_viewer_store__?.getState();
      return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
        [...state.models.values()].every(model => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0);
    }, undefined, { timeout: 180_000 });

    // Only selection setup: parsed IFC + canonical selection actions. Never seed contributions.
    const id = await page.evaluate(() => {
      const state = (globalThis as typeof globalThis & {
        __ifc_lite_viewer_store__: { getState(): ViewerState };
      }).__ifc_lite_viewer_store__.getState();
      const model = [...state.models.values()][0];
      const index = model.ifcDataStore!.entityIndex.byType;
      const expressId = (index.get('IFCWALL') ?? index.get('IFCWALLSTANDARDCASE'))?.[0];
      if (expressId === undefined) throw new Error('Bundled IFC has no wall');
      const globalId = state.toGlobalId(model.id, expressId);
      state.setSelectedEntityIds([globalId]); state.setSelectedEntityId(globalId);
      return globalId;
    });
    const owner = await page.evaluate(id => (globalThis as typeof globalThis & {
      __ifc_lite_scene_owner__: (id: number) => SceneOwnerSnapshot;
    }).__ifc_lite_scene_owner__(id), id);
    expect(!!owner.flat?.length || owner.instance, 'wall has actual resident geometry').toBe(true);
    expect(await hidden(page, id)).toBe(false);
    await info.attach('resident-wall.json', { body: JSON.stringify({ id, residentFlatParts: owner.flat?.length ?? 0, instance: owner.instance, initiallyHidden: false }), contentType: 'application/json' });

    await openDestination(page, 'panel:extensions', 'Extensions');
    await expect(installedRow(page)).toHaveCount(0);
    // ExtensionsPanel always uses this real file input, even with File System Access present.
    // Upload bytes work on Windows Chrome CDP too; no WSL path is passed to its chooser.
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const chooser = await chooserPromise;
    await expect(chooser.element()).toHaveAttribute('accept', '.iflx');
    await chooser.setFiles(packed.upload);
    const consent = page.getByRole('dialog', { name: `Install ${OWNER} v1.0.0?`, exact: true });
    await expect(consent).toBeVisible();
    for (const capability of ['model.read', 'viewer.read', 'viewer.isolate']) {
      const grant = consent.getByRole('checkbox', { name: `Grant capability ${capability}`, exact: true });
      await grant.uncheck(); await expect(grant).not.toBeChecked();
      await grant.check(); await expect(grant).toBeChecked();
    }
    await info.attach('capability-consent.png', { body: await page.screenshot(), contentType: 'image/png' });
    await consent.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(consent).toBeHidden();
    await expect(installedRow(page).getByRole('switch', { name: 'Disable extension', exact: true })).toBeChecked();

    // Only this installed owner's dock row can open the dialog used below.
    await openDestination(page, DESTINATION, TITLE);
    await expect(widget(page)).toContainText(OWNER);
    await expect(widget(page)).toContainText('Installed QuickJS visibility witness');
    // Canonical scene setup only. The extension alone changes the wall's hide state.
    // Isolate and frame its real geometry so unchanged draw submission cannot pass.
    await page.evaluate(id => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      state.isolateEntities([id]);
      if (state.typeVisibility.ifcGrid) state.toggleTypeVisibility('ifcGrid');
      if (!state.cameraCallbacks.frameSelection) throw new Error('Real frame-selection controller is missing');
      state.cameraCallbacks.frameSelection(0);
    }, id);
    const exerciseVisibility = async (name: string) => visibilityOutputWitness(page, info, name, async () => {
      await widget(page).getByRole('button', { name: 'Hide selected IFC elements', exact: true }).click();
      await expect.poll(() => hidden(page, id)).toBe(true);
    }, async () => {
      await widget(page).getByRole('button', { name: 'Show selected IFC elements', exact: true }).click();
      await expect.poll(() => hidden(page, id)).toBe(false);
    });
    await exerciseVisibility('initial-activation');
    await page.keyboard.press('Escape');
    await expect(widget(page)).toBeHidden();

    await openDestination(page, 'panel:extensions', 'Extensions');
    await installedRow(page).getByRole('switch', { name: 'Disable extension', exact: true }).click();
    await expect(installedRow(page).getByRole('switch', { name: 'Enable extension', exact: true })).not.toBeChecked();
    await refused(page, id);
    await info.attach('disabled-owner.png', { body: await page.screenshot(), contentType: 'image/png' });

    await openDestination(page, 'panel:extensions', 'Extensions');
    await installedRow(page).getByRole('switch', { name: 'Enable extension', exact: true }).click();
    await expect(installedRow(page).getByRole('switch', { name: 'Disable extension', exact: true })).toBeChecked();
    await openDestination(page, DESTINATION, TITLE);
    await expect(widget(page).getByRole('button', { name: 'Hide selected IFC elements', exact: true })).toBeVisible();
    await exerciseVisibility('reenabled-activation');
    await page.keyboard.press('Escape');
    await openDestination(page, 'panel:extensions', 'Extensions');
    await installedRow(page).getByRole('button', { name: `Uninstall ${OWNER}`, exact: true }).click();
    const confirmation = page.getByRole('alertdialog').filter({ hasText: `Uninstall ${OWNER}?` });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(installedRow(page)).toHaveCount(0);
    await refused(page, id);
    await info.attach('uninstalled-owner.png', { body: await page.screenshot(), contentType: 'image/png' });
  } finally {
    await info.attach('actual-state.png', { body: await page.screenshot(), contentType: 'image/png' });
    await info.attach('pageerrors.json', { body: JSON.stringify(pageerrors), contentType: 'application/json' });
    await info.attach('command-errors.json', { body: JSON.stringify(commandErrors), contentType: 'application/json' });
    expect(commandErrors, 'caught widget command failures, including reactivation').toEqual([]);
    expect(pageerrors, 'uncaught browser errors, also retained on failure').toEqual([]);
  }
});
