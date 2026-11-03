/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8566: production file admission and CPU lifecycle; no pixel/pick-pass oracle. */
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { loadThroughViewer } from './federation-control-triplet.helpers';

const IFC = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const CAPTURE = 'tests/models/gaussian/plant.splat';
const COUNT = 113_648; // Licensed, manifest-pinned Marcel Padilla plant capture.

test('Gaussian capture load → inspect → clip → select → save/reopen → remove (#8566)', async ({ page }, info) => {
  for (const file of [IFC, CAPTURE]) {
    expect(existsSync(file), `Required Gaussian journey fixture missing: ${file}. Run pnpm fixtures; this journey must not skip.`).toBe(true);
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Observe the real worker, preserving its decoding and transfer behavior.
  await page.addInitScript(() => {
    const counts = { started: 0, terminated: 0 };
    Object.assign(globalThis, { __gaussianJourneyWorkers: counts });
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class extends NativeWorker {
      private gaussian: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.gaussian = String(url).includes('gaussianDecode');
        if (this.gaussian) counts.started++;
      }
      terminate() {
        if (this.gaussian) { counts.terminated++; this.gaussian = false; }
        super.terminate();
      }
    };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const gpu = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    return { available: Boolean(adapter), info: adapter ? { vendor: adapter.info.vendor, device: adapter.info.device, description: adapter.info.description } : null };
  });
  await info.attach('webgpu', { body: JSON.stringify(gpu), contentType: 'application/json' });
  expect(gpu.available, 'Gaussian journey requires WebGPU (Chrome/SwiftShader in viewer-e2e-ci); unavailable adapters are a failure, never a skip.').toBe(true);
  await loadThroughViewer(page, IFC, 1, 120_000);
  const ifcId = await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().models.keys()][0]);
  await page.locator('#file-input-add').setInputFiles(CAPTURE);
  await expect.poll(() => page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return !s.loading && s.models.size === 2 && [...s.models.values()].some((m) => m.gaussianSplat?.count === 113_648);
  }), { timeout: 60_000, message: 'Capture must load through Add (including on software WebGPU); check admission/device errors.' }).toBe(true);

  const capture = await page.evaluate(() => {
    const m = [...globalThis.__ifc_lite_viewer_store__.getState().models.values()].find((m) => m.gaussianSplat)!;
    return { id: m.id, count: m.gaussianSplat!.count, format: m.gaussianSplat!.format,
      entities: m.ifcDataStore?.entities.count, meshes: m.geometryResult?.meshes.length };
  });
  expect(capture).toMatchObject({ count: COUNT, format: 'splat', entities: 0, meshes: 0 });
  expect(capture.id).not.toBe(ifcId);
  const stats = () => page.evaluate(() => {
    const host = globalThis as typeof globalThis & { __ifc_lite_render_stats__(): { gaussianSplats: { assets: number; splats: number; cpuBytes: number; visibleAssetSplats: number } } };
    return host.__ifc_lite_render_stats__().gaussianSplats;
  });
  await expect.poll(async () => (await stats()).assets).toBe(1);
  expect((await stats()).splats).toBe(COUNT);
  const workers = () => page.evaluate(() => (globalThis as typeof globalThis & { __gaussianJourneyWorkers: { started: number; terminated: number } }).__gaussianJourneyWorkers);
  expect(await workers()).toEqual({ started: 1, terminated: 1 });

  const row = page.getByRole('treeitem').filter({ has: page.getByRole('button', { name: 'Remove model plant.splat', exact: true }) });
  await expect(row).toBeVisible();
  await row.click();
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedModelId)).toBe(capture.id);
  const metadata = page.getByTestId('gaussian-capture-metadata');
  await expect(metadata).toBeVisible();
  for (const text of ['.splat', '113,648', 'Limitations', 'no section caps', 'Not pickable', 'no metric scale']) {
    await expect(metadata).toContainText(text);
  }
  // CPU clip contract: no assertion about pixels or whole-Gaussian culling.
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setSectionBox({ min: [-1, -1, -1], max: [1, 1, 1] }));
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().sectionPlane.enabled)).toBe(true);
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setSectionPlaneEnabled(false));
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().sectionPlane.enabled)).toBe(false);
  await page.getByRole('button', { name: 'Hide model plant.splat', exact: true }).click();
  expect(await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().models.get(id)?.visible, capture.id)).toBe(false);
  await expect.poll(async () => (await stats()).visibleAssetSplats).toBe(0);
  await page.getByRole('button', { name: 'Show model plant.splat', exact: true }).click();
  expect(await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().models.get(id)?.visible, capture.id)).toBe(true);
  await expect.poll(async () => (await stats()).visibleAssetSplats).toBe(COUNT);
  await row.click();
  // Select a real IFC row through the hierarchy; GPU picking is outside this lane.
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setHierarchyMode('type'));
  const group = page.locator('[data-hierarchy-node-type="type-group"]').filter({ hasText: 'IfcWall' }).first();
  await group.getByRole('button', { name: /^Expand / }).click();
  await page.locator('[data-hierarchy-node-type="element"]').first().click();
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityIds.size)).toBe(1);
  expect(await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().selectedEntitiesSet])).toEqual([expect.stringContaining(ifcId)]);

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => window.dispatchEvent(new Event('ifc-lite:save-federation-setup')));
  const download = await downloadPromise;
  const saved = info.outputPath('journey.federation.json');
  await download.saveAs(saved);
  // Fresh page proves reopening from the saved setup and sources, not retained state.
  await page.reload();
  await expect(page.locator('#file-input-open')).toBeAttached();
  const setupChooser = page.waitForEvent('filechooser');
  await page.evaluate(() => window.dispatchEvent(new Event('ifc-lite:open-federation-setup')));
  const sourceChooser = page.waitForEvent('filechooser');
  await (await setupChooser).setFiles(saved);
  await (await sourceChooser).setFiles([IFC, CAPTURE]);
  await page.getByRole('button', { name: 'Restore federation', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return !s.loading && s.models.size === 2 && [...s.models.values()].some((m) => m.gaussianSplat?.count === 113_648);
  }), { timeout: 120_000 }).toBe(true);
  await expect.poll(async () => (await stats()).assets).toBe(1);
  expect(await workers()).toEqual({ started: 1, terminated: 1 });
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setHierarchyMode('spatial'));
  await page.getByRole('button', { name: 'Remove model plant.splat', exact: true }).click();
  await expect.poll(async () => (await stats()).assets).toBe(0);
  expect((await stats()).splats).toBe(0);
  expect((await stats()).cpuBytes).toBe(0);
  expect(await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return { models: s.models.size, captures: [...s.models.values()].filter((m) => m.gaussianSplat).length };
  })).toEqual({ models: 1, captures: 0 });
  expect(errors, 'No uncaught page errors during the complete journey').toEqual([]);
});
