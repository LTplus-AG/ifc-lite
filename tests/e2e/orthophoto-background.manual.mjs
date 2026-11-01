/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8552: real file-picker + WebGPU witness. Run against this checkout's built
// viewer under ifc-gpu-check; ORTHOPHOTO_IMAGE and its sidecars are a licensed
// orthophoto covering the fixture (see the evidence receipt for source URL).
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const out = process.env.ORTHOPHOTO_EVIDENCE ?? '/tmp/orthophoto-8552';
await mkdir(out, { recursive: true });
const browser = process.env.IFC_GPU_CDP_URL
  ? await chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL)
  : await chromium.launch({ headless: true, channel: 'chrome', args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
    '--use-angle=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const file = async (path, mimeType) => ({ name: basename(path), mimeType, buffer: await readFile(path) });
try {
  await page.goto(process.env.ORTHOPHOTO_BASE ?? 'http://localhost:5184');
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__);
  const input = page.locator('input[type=file][accept*=".ifc"]').first();
  const model = resolve('tests/models/georeferencer/MiniBIM-3.1-DO_01_VORM.ifc');
  await input.setInputFiles(await file(model, 'application/x-step'));
  await page.waitForFunction(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return !s.loading && !s.geometryStreamingActive && s.models.size === 1
      && [...s.models.values()].every(m => m.geometryResult && m.loadState === 'complete');
  }, null, { timeout: 120000 });
  const before = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return [...s.models.values()].map(m => ({ id: m.id, triangles: m.geometryResult.totalTriangles }));
  });
  const image = process.env.ORTHOPHOTO_IMAGE;
  assert.ok(image, 'Set ORTHOPHOTO_IMAGE to the licensed Schiehaven orthophoto or its GeoTIFF derivative.');
  const files = [await file(image, image.endsWith('.tif') ? 'image/tiff' : 'image/jpeg')];
  if (!image.endsWith('.tif')) {
    files.push(await file(image.replace(/\.jpg$/, '.jgw'), 'text/plain'));
    files.push(await file(image.replace(/\.jpg$/, '.prj'), 'text/plain'));
  }
  await input.setInputFiles(files);
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().appearanceReferences.size === 1,
    null, { timeout: 60000 });
  await page.getByRole('heading', { name: 'Registered drawings' }).waitFor();
  const after = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return [...s.models.values()].map(m => ({ id: m.id, triangles: m.geometryResult.totalTriangles }));
  });
  assert.deepEqual(after, before, 'imagery never replaces or remeshes the IFC');
  await page.evaluate(async () => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    s.cameraCallbacks.setPresetDirection({ x: 1, y: 1.2, z: 1 });
    for (let i = 0; i < 3; i++) s.cameraCallbacks.zoomOut();
  });
  for (const notice of await page.getByRole('button', { name: 'Dismiss notification', exact: true }).all()) await notice.click();
  await page.waitForTimeout(1800); // Allow the untimed camera animation and GPU upload to settle.
  await page.screenshot({ path: `${out}/rotterdam-background.png` });
  const hide = page.getByRole('button', { name: /^Hide .*pdok-schiehaven/ });
  await hide.click();
  assert.equal(await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().appearanceReferences.values()][0].visible), false);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/rotterdam-hidden.png` });
  await page.getByRole('button', { name: /^Show .*pdok-schiehaven/ }).click();
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.setPresetView('top'));
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/rotterdam-plan.png` });
  const opacity = page.getByRole('spinbutton', { name: /Opacity/ });
  await opacity.fill('45');
  await opacity.press('Enter');
  assert.equal(await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().appearanceReferences.values()][0].opacity), 0.45);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/rotterdam-opacity.png` });
  const beforeEdit = await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().appearanceReferences.values()][0].cornersIfcWorld);
  await page.getByRole('button', { name: /^Edit .*pdok-schiehaven/ }).click();
  const elevation = page.getByRole('spinbutton', { name: 'Point A · Z (m)', exact: true });
  await elevation.fill(String(beforeEdit[0][2] + 1));
  await elevation.press('Tab');
  await page.getByRole('button', { name: 'Save registration', exact: true }).click({ timeout: 30000 });
  const afterEdit = await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().appearanceReferences.values()][0].cornersIfcWorld);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(afterEdit[i][0] - beforeEdit[i][0]) < 1e-7);
    assert.ok(Math.abs(afterEdit[i][1] - beforeEdit[i][1]) < 1e-7);
    assert.ok(Math.abs(afterEdit[i][2] - beforeEdit[i][2] - 1) < 1e-7);
  }
  await page.getByRole('button', { name: /^Remove .*pdok-schiehaven/ }).click();
  assert.equal(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().appearanceReferences.size), 0);
  assert.deepEqual(errors, []);
  await writeFile(`${out}/result.json`, JSON.stringify({ model, image, before, after, errors, visibilityOpacityElevationAndRemoval: 'pass' }, null, 2));
  console.log(`Orthophoto file-picker, model preservation, visibility and removal passed. Evidence: ${out}`);
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` });
  await writeFile(`${out}/failure.txt`, `${error.stack}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`);
  throw error;
} finally {
  await context.close();
  await browser.close();
}
