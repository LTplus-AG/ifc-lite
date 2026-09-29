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
import { collabRenderedWitness } from './collab-georeference.rendering';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_NAME = process.env.E2E_GEOREFERENCED_SAMPLE ?? 'building-architecture.ifc';
const FIXTURE = join(ROOT, 'apps/viewer/public/samples', FIXTURE_NAME);
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
        lengthUnitScale: model.ifcDataStore?.lengthUnitScale,
        geometryClasses: model.geometryResult?.meshes.map(mesh => mesh.geometryClass ?? 0),
        meshPoints: model.geometryResult?.meshes.map(mesh => [0, 1, 2]
          .map(axis => mesh.positions[axis] + (mesh.origin?.[axis] ?? 0))).sort((a, b) =>
            a[0] - b[0] || a[1] - b[1] || a[2] - b[2]),
        instancedShards: model.geometryResult?.instancedShards?.length ?? 0 };
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
      // One-model raster/pick proof; the two-slot case proves the independent
      // coordinate facts and resident mesh points without conflating duplicate
      // model visibility behavior with spatial metadata transport.
      const ownerWitness = copies === 1 ? await collabRenderedWitness(owner.page) : undefined;
      if (ownerWitness) await info.attach(`${copies}-owner-renderer.png`, { body: ownerWitness.png, contentType: 'image/png' });
      await openFileTab(owner.page);
      await owner.page.getByRole('button', { name: 'Share', exact: true }).click();
      const dialog = owner.page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Create link' }).click();
      await expect(dialog.locator('#share-link')).toHaveValue(/[?&]room=[^&]+&t=/, { timeout: 300000 });
      url = await dialog.locator('#share-link').inputValue();
      expected = await facts(owner.page, false);
      for (const phase of ['fresh-guest', 'rejoin']) {
        const guest = await fresh(browser, relay, url!);
        try {
          await waitForRoomModels(guest.page, copies);
          await guest.page.getByRole('tab', { name: 'View', exact: true }).click();
          await expect(guest.page.getByRole('button', { name: 'World', exact: true })).toBeVisible();
          if (phase === 'fresh-guest') {
            const entities = await guest.page.evaluate(() => JSON.stringify(globalThis.__ifc_lite_viewer_store__.getState().collabSession?.doc.getMap('entities').toJSON()));
            const geo = expected![0].georeferencing as { mapConversion: { eastings: number } };
            const edited = geo.mapConversion.eastings + 2500;
            await owner.page.evaluate(({ before, after }) => {
              const state = globalThis.__ifc_lite_viewer_store__.getState();
              state.setEditEnabled(true);
              state.setGeorefField([...state.models.keys()][0], 'mapConversion', 'eastings', after, before);
            }, { before: geo.mapConversion.eastings, after: edited });
            await guest.page.waitForFunction(value => [...globalThis.__ifc_lite_viewer_store__.getState().models.values()][0]?.ifcDataStore?.georeferencing?.mapConversion?.eastings === value, edited);
            expect(await guest.page.evaluate(() => JSON.stringify(globalThis.__ifc_lite_viewer_store__.getState().collabSession?.doc.getMap('entities').toJSON()))).toBe(entities);
            expected = await facts(owner.page, false);
          }
          const received = await facts(guest.page, true);
          for (let i = 0; i < copies; i++) {
            const actual = received[i], original = expected![i];
            expect(actual.meshes).toBe(original.meshes);
            expect(actual.coordinateInfo).toEqual(original.coordinateInfo);
            expect(actual.meshPoints).toEqual(original.meshPoints);
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
            await guest.page.getByRole('treeitem').filter({ hasText: FIXTURE_NAME }).first().click();
          }
          await guest.page.keyboard.press('Alt+1');
          await expect(guest.page.getByRole('button', { name: 'Projected CRS EPSG:32760', exact: true })).toBeVisible();
          await expect(guest.page.getByText('3D Rendering Failed', { exact: true })).not.toBeVisible();
          await expect(guest.page.getByText('EPSG:32760', { exact: true }).first()).toBeVisible();
          await guest.page.getByRole('button', { name: 'Fit all', exact: true }).click();
          await guest.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const image = await guest.page.screenshot();
          await info.attach(`${copies}-${phase}.png`, { body: image, contentType: 'image/png' });
          const guestWitness = copies === 1 ? await collabRenderedWitness(guest.page) : undefined;
          if (guestWitness) await info.attach(`${copies}-${phase}-renderer.png`, { body: guestWitness.png, contentType: 'image/png' });
          if (EVIDENCE_DIR) {
            mkdirSync(EVIDENCE_DIR, { recursive: true });
            writeFileSync(join(EVIDENCE_DIR, `${copies}-${phase}.png`), image);
            if (guestWitness) writeFileSync(join(EVIDENCE_DIR, `${copies}-${phase}-renderer.png`), guestWitness.png);
            if (ownerWitness) writeFileSync(join(EVIDENCE_DIR, `${copies}-owner-renderer.png`), ownerWitness.png);
            writeFileSync(join(EVIDENCE_DIR, `${copies}-${phase}.json`), JSON.stringify({ fixture: FIXTURE_NAME, expected, received,
              ownerRendered: ownerWitness?.rendered, guestRendered: guestWitness?.rendered }, null, 2));
          }
        } finally { await guest.context.close(); }
      }
    } finally { await owner.context.close(); }
  });
});
