/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Explicit manual browser witness, not a CI gate. Runs after two T3 preview
// open failures; no benchmark or production viewer support is claimed.
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const output = resolve(process.env.SPLAT_SPIKE_EVIDENCE ?? '/tmp/ifc-splat-8140-evidence');
await mkdir(output, { recursive: true });
const server = await createServer({ root, configFile: resolve(root, 'vite.config.mjs'), server: { port: 5189, strictPort: true } });
let browser;
const results = [];
async function saveCapture(page, name) {
  const capture = await page.evaluate(() => window.spike.backend.capture());
  await writeFile(resolve(output, name), Buffer.from(capture.png.split(',')[1], 'base64'));
  return { sampledColors: capture.sampledColors };
}
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
    '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
  for (const backend of ['luma', 'playcanvas']) {
    const page = await browser.newPage({ viewport: { width: 1320, height: 1000 } });
    const errors = [], warnings = [];
    page.on('pageerror', error => errors.length < 12 && !errors.includes(error.message) && errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.length < 12 && !errors.includes(message.text()) && errors.push(message.text()); if (message.type() === 'warning') warnings.push(message.text()); });
    const result = { backend, errors, warnings };
    try {
      await page.goto(`http://127.0.0.1:5189/?backend=${backend}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.spike?.ready || window.spike?.error, undefined, { timeout: 90000 });
      result.state = await page.evaluate(() => ({ ready: window.spike.ready, error: window.spike.error }));
      if (!result.state.ready) throw new Error(result.state.error);
      await page.waitForTimeout(1500);
      result.initial = await page.evaluate(() => window.spike.stats());
      result.pixels = await saveCapture(page, `${backend}-mixed.png`);
      if (process.env.SPLAT_SPIKE_E57) {
        await page.locator('#scan').setInputFiles(process.env.SPLAT_SPIKE_E57);
        await page.waitForFunction(() => window.spike?.scan || window.spike?.error, undefined, { timeout: 90000 });
        result.scan = await page.evaluate(() => window.spike.scan ?? { error: window.spike.error });
        result.withScan = await page.evaluate(() => window.spike.stats());
        await page.click('#hide-ifc'); await page.click('#hide-splats');
        const scanOnly = await page.evaluate(() => window.spike.backend.capture());
        await writeFile(resolve(output, `${backend}-scan-only.png`), Buffer.from(scanOnly.png.split(',')[1], 'base64'));
        result.scanOnlyPixels = scanOnly.sampledColors;
        await page.click('#hide-points');
        const empty = await page.evaluate(() => window.spike.backend.capture());
        result.pointToggleChangesPixels = scanOnly.png !== empty.png;
        await page.click('#hide-points'); await page.click('#hide-splats'); await page.click('#hide-ifc');
        result.scanPixels = await saveCapture(page, `${backend}-with-scan.png`);
      }
      const beforeToggle = await page.evaluate(() => window.spike.backend.capture());
      await page.click('#hide-splats'); await page.waitForTimeout(300);
      const hidden = await page.evaluate(() => window.spike.backend.capture());
      await writeFile(resolve(output, `${backend}-no-splats.png`), Buffer.from(hidden.png.split(',')[1], 'base64'));
      result.splatToggleChangesPixels = beforeToggle.png !== hidden.png;
      await page.click('#hide-splats'); await page.click('#move'); await page.waitForTimeout(300);
      await saveCapture(page, `${backend}-moved.png`);
      if (backend === 'luma') result.reverseZProbe = await page.evaluate(() => window.spike.backend.reverseZProbe());
      await page.click('#dispose');
      result.disposed = await page.evaluate(() => window.spike.stats());
    } catch (error) {
      result.failure = error.message;
      await page.screenshot({ path: resolve(output, `${backend}-failure.png`) });
    } finally { results.push(result); await page.close(); }
  }
} finally {
  await browser?.close(); await server.close();
  await writeFile(resolve(output, 'result.json'), JSON.stringify({ mode: 'functional SwiftShader witness; not a performance measurement', results }, null, 2) + '\n');
}
console.log(JSON.stringify({ output, results: results.map(result => ({ backend: result.backend, failure: result.failure, initial: result.initial, pixels: result.pixels, scanPixels: result.scanPixels, scan: result.scan, pointToggleChangesPixels: result.pointToggleChangesPixels, reverseZProbe: result.reverseZProbe, splatToggleChangesPixels: result.splatToggleChangesPixels, errors: result.errors.slice(0, 3) })) }, null, 2));
if (results.some(result => result.failure || result.errors.length || !result.splatToggleChangesPixels || result.pixels?.sampledColors < 2 || (result.scan && !result.pointToggleChangesPixels))) process.exitCode = 1;
