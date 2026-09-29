/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6499: real SketchUp model, browser share, fresh guest, CRS and render frame. */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay, relayBinary, type Relay } from './collab/relay';
import { startViewerPreview, viewerDist, type ViewerPreview } from './collab/preview';
import { enableCollab, openViewer, openFileTab } from './collab/viewer-page';
import { loadFile, waitForRoomModels } from './collab/federation-scope';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(ROOT, 'apps/viewer/public/samples/building-architecture.ifc');
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;

// Same real-Chrome SwiftShader WebGPU flags as the viewer smoke lane.
test.use({ launchOptions: { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan',
  '--use-vulkan=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu'] } });

async function fresh(browser: Browser, relay: Relay, url: string) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await enableCollab(context, relay.wsUrl);
  const page = await openViewer(context, url);
  await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__));
  return { context, page };
}
async function facts(page: Page, guest: boolean) {
  return page.evaluate((isGuest) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return [...state.models.values()].map(model => {
      const slot = state.collabRoomModels.get(model.id);
      const ownerRecord = !isGuest && slot ? state.collabSession?.doc.getMap('models').get(slot.slotId) : undefined;
      const context = ownerRecord as { spatialContext?: { georeferencing?: unknown } } | undefined;
      return { slot: slot?.slotId, georeferencing: isGuest ? model.ifcDataStore?.georeferencing : context?.spatialContext?.georeferencing,
        coordinateInfo: model.geometryResult?.coordinateInfo, meshes: model.geometryResult?.meshes.length,
        lengthUnitScale: model.ifcDataStore?.lengthUnitScale };
    });
  }, guest);
}

for (const copies of [1, 2]) test.describe(`georeferencing in a ${copies}-model room (#6499)`, () => {
  let relay: Relay, viewer: ViewerPreview;
  test.beforeAll(async () => {
    test.skip(!existsSync(relayBinary(ROOT)), 'Build collab-server with pnpm build');
    test.skip(!existsSync(viewerDist(ROOT)), 'Build viewer with pnpm build:e2e');
    relay = await startRelay(ROOT);
    viewer = await startViewerPreview(ROOT);
  });
  test.afterAll(async () => { await viewer?.stop(); await relay?.stop(); });

  test('World and the georeferencing card survive sharing and a fresh rejoin', async ({ browser }, info) => {
    const owner = await fresh(browser, relay, `${viewer.url}/`);
    let url: string;
    let expected: Awaited<ReturnType<typeof facts>>;
    try {
      for (let i = 1; i <= copies; i++) await loadFile(owner.page, FIXTURE, i);
      await owner.page.evaluate(() => {
        const state = globalThis.__ifc_lite_viewer_store__.getState();
        state.setActiveModel([...state.models.keys()][0]);
      });
      await owner.page.getByRole('tab', { name: 'View', exact: true }).click();
      await expect(owner.page.getByRole('button', { name: 'World', exact: true })).toBeVisible();
      await openFileTab(owner.page);
      await owner.page.getByRole('button', { name: 'Share', exact: true }).click();
      const dialog = owner.page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Create link' }).click();
      await expect(dialog.locator('#share-link')).toHaveValue(/[?&]room=[^&]+&t=/, { timeout: 300000 });
      url = await dialog.locator('#share-link').inputValue();
      expected = await facts(owner.page, false);
    } finally { await owner.context.close(); }
    for (const phase of ['fresh-guest', 'rejoin']) {
      const guest = await fresh(browser, relay, url!);
      try {
        await waitForRoomModels(guest.page, copies);
        await guest.page.getByRole('tab', { name: 'View', exact: true }).click();
        await expect(guest.page.getByRole('button', { name: 'World', exact: true })).toBeVisible();
        const received = await facts(guest.page, true);
        for (let i = 0; i < copies; i++) {
          const actual = received[i], original = expected![i];
          expect(actual.meshes).toBe(original.meshes);
          expect(actual.coordinateInfo).toEqual(original.coordinateInfo);
          expect(actual.lengthUnitScale).toBe(0.001);
          const geo = actual.georeferencing as { mapConversion: Record<string, unknown>; projectedCRS: Record<string, unknown> };
          const ownerGeo = original.georeferencing as typeof geo;
          expect(geo.projectedCRS).toEqual({ ...ownerGeo.projectedCRS, id: 0 });
          expect(geo.mapConversion).toEqual({ ...ownerGeo.mapConversion, id: 0, sourceCRS: 0, targetCRS: 0 });
          expect(geo.projectedCRS.name).toBe('EPSG:32760');
        }
        // Inspector entry is reached through the real Model panel control.
        if (copies > 1) {
          if (!await guest.page.getByRole('textbox', { name: 'Search hierarchy' }).isVisible()) {
            await guest.page.keyboard.press('Control+k');
            await guest.page.keyboard.type('Hierarchy');
            await guest.page.keyboard.press('Enter');
          }
          await guest.page.getByRole('treeitem').filter({ hasText: 'building-architecture.ifc' }).first().click();
        }
        await guest.page.keyboard.press('Alt+1');
        await expect(guest.page.getByRole('button', { name: 'Projected CRS EPSG:32760', exact: true })).toBeVisible();
        await expect(guest.page.getByText('3D Rendering Failed', { exact: true })).not.toBeVisible();
        await expect(guest.page.getByText('EPSG:32760', { exact: true }).first()).toBeVisible();
        await guest.page.getByRole('button', { name: 'Fit all', exact: true }).click();
        await guest.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const image = await guest.page.screenshot();
        await info.attach(`${copies}-${phase}.png`, { body: image, contentType: 'image/png' });
        if (EVIDENCE_DIR) {
          mkdirSync(EVIDENCE_DIR, { recursive: true });
          writeFileSync(join(EVIDENCE_DIR, `${copies}-${phase}.png`), image);
          writeFileSync(join(EVIDENCE_DIR, `${copies}-${phase}.json`), JSON.stringify({ fixture: 'building-architecture.ifc', expected, received }, null, 2));
        }
      } finally { await guest.context.close(); }
    }
  });
});
