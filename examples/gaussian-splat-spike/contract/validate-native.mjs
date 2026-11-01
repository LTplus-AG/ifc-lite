/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual admitted browser experiment, not production or hardware performance qualification.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { exactRunsPlugin } from './exact-runs-plugin.mjs';
import { publishedRendererHash } from '../depth-patch.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.SPLAT_SPIKE_EVIDENCE ?? '/tmp/ifc-splat-8564-native');
await mkdir(output, { recursive: true });
const evidence = { issue: 8564, mode: 'SwiftShader correctness only', version: '9.4.2', publishedRendererHash,
  productionReady: false, actualViewerIntegrated: false, runs: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
    '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
  for (const exact of [false, true]) {
    const server = await createServer({ root, configFile: false, plugins: [exactRunsPlugin(exact)],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '../..')] } } });
    let page;
    try {
      await server.listen();
      page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}contract/native-witness.html`);
      await page.waitForFunction(() => Boolean(window.nativeWitness), undefined, { timeout: 30000 });
      const witness = await page.evaluate(() => window.nativeWitness);
      evidence.runs.push({ exact, ...witness, errors });
      assert.equal(witness.error, undefined);
      assert.deepEqual(errors, []);
      assert.deepEqual(witness.result.errors, []);
      assert.equal(witness.result.ownershipError, null);
      assert.equal(witness.result.results.length, 16);
      assert.ok(witness.result.intersection.glassFirstDifferentChannels > 0);
      assert.ok(witness.result.intersection.splatsFirstDifferentChannels > 0);
      for (const row of witness.result.results) {
        assert.equal(row.drawRuns, exact ? 96 : 64);
        assert.equal(row.changedPixels === 0, exact, JSON.stringify(row));
        assert.ok(row.referenceCenter[0] + row.referenceCenter[2] > 100, 'reference must not be blank');
      }
    } finally { await page?.close(); await server.close(); }
  }
} catch (error) { evidence.failure = error.stack; process.exitCode = 1; }
finally {
  await browser?.close();
  await writeFile(resolve(output, 'native-result.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence, null, 2));
