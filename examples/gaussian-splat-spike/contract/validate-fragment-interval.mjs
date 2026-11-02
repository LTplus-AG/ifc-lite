/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual GPU correctness run through fleet admission + ifc-gpu-check.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { fragmentIntervalPlugin } from './fragment-interval-plugin.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.SPLAT_SPIKE_EVIDENCE ?? '/tmp/ifc-splat-8564-interval');
await mkdir(output, { recursive: true });
const evidence = { issue: 8564, mode: 'SwiftShader correctness only', productionReady: false, runs: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
    '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
  for (const filter of [true, false]) {
    const server = await createServer({ root, configFile: false, plugins: [fragmentIntervalPlugin(filter)],
      optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '../..')] } } });
    let page;
    try {
      await server.listen(); page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}contract/fragment-interval-witness.html`);
      await page.waitForFunction(() => Boolean(window.intervalWitness), undefined, { timeout: 30000 });
      const witness = await page.evaluate(() => window.intervalWitness);
      evidence.runs.push({ filter, ...witness, errors });
      assert.equal(witness.error, undefined); assert.deepEqual(errors, []); assert.deepEqual(witness.result.errors, []);
      assert.equal(witness.result.cases.length, 4);
      for (const row of witness.result.cases) {
        assert.ok(row.referenceNonzero);
        assert.equal(row.differentChannels === 0, filter, JSON.stringify(row));
      }
    } finally { await page?.close(); await server.close(); }
  }
} catch (error) { evidence.failure = error.stack; process.exitCode = 1; }
finally { await browser?.close(); await writeFile(resolve(output, 'fragment-interval-result.json'), JSON.stringify(evidence, null, 2) + '\n'); }
console.log(JSON.stringify(evidence, null, 2));
