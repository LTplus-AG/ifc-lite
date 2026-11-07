/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Manual SwiftShader correctness witness, not a performance measurement.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { depthPatchPlugin, publishedRendererHash, upstreamCommit } from './depth-patch.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const output = resolve(process.env.SPLAT_SPIKE_EVIDENCE ?? '/tmp/ifc-splat-8140-depth');
await mkdir(output, { recursive: true });
const evidence = { mode: 'SwiftShader correctness only', version: '9.4.2', publishedRendererHash,
  proposalTarget: upstreamCommit, runs: [] };
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
    '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
  for (const patched of [false, true]) {
    const server = await createServer({ root, configFile: false, plugins: [depthPatchPlugin(patched)],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '../..')] } } });
    let page;
    try {
      await server.listen();
      page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}depth-witness.html`);
      await page.waitForFunction(() => Boolean(window.depthWitness), undefined, { timeout: 30000 });
      const witness = await page.evaluate(() => window.depthWitness);
      evidence.runs.push({ patched, ...witness, errors });
      assert.equal(witness.error, undefined);
      assert.deepEqual(errors, []);
      assert.deepEqual(witness.result.errors, []);
      assert.equal(witness.result.results.length, 14);
      for (const row of witness.result.results) {
        const [red, green, blue, alpha] = row.centerPixel;
        const correctOrder = row.name === 'standard-projection' || row.name === 'opaque-depth'
          || (patched && !['source-order', 'standard-convention-only'].includes(row.name));
        assert.equal(red > blue, correctOrder, `${patched ? 'patched' : 'original'} ${row.projection} ${row.name}`);
        assert.equal(green, 0);
        assert.equal(alpha, 255);
        assert.equal(row.visible, 2);
        if (row.name === 'opaque-depth') assert.equal(blue, 0, 'shared opaque depth must reject the far blue splat');
        if (row.name !== 'opaque-depth') assert.deepEqual(row.order, correctOrder ? [1, 0] : [0, 1]);
      }
    } finally { await page?.close(); await server.close(); }
  }
} catch (error) {
  evidence.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  await writeFile(resolve(output, 'depth-result.json'), JSON.stringify(evidence, null, 2) + '\n');
}
console.log(JSON.stringify(evidence, null, 2));
