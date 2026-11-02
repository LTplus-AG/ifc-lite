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
import { execFileSync } from 'node:child_process';
import { exactRunsPlugin } from './exact-runs-plugin.mjs';
import { compareIntervalPixels, assertIntervalAccepted } from './fragment-interval-acceptance.mjs';
import { fragmentIntervalPlugin } from './fragment-interval-plugin.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.SPLAT_SPIKE_EVIDENCE ?? '/tmp/ifc-splat-8564-interval');
await mkdir(output, { recursive: true });
const evidence = { issue: 8564, mode: 'SwiftShader correctness only', productionReady: false, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), runs: [] };
let browser;
try {
  browser = await chromium.launch({ headless: true, args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
    '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
  let reference;
  for (const filter of ['reference', true, false, 'discard-all']) {
    const server = await createServer({ root, configFile: false, plugins: [filter === 'reference' ? exactRunsPlugin(true) : fragmentIntervalPlugin(filter)],
      optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(root, '../..')] } } });
    let page;
    try {
      await server.listen(); page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.resolvedUrls.local[0]}contract/fragment-interval-witness.html?mode=${filter === 'reference' ? 'reference' : 'interval'}`);
      await page.waitForFunction(() => Boolean(window.intervalWitness), undefined, { timeout: 30000 });
      const witness = await page.evaluate(() => window.intervalWitness);
      const run = { filter, errors };
      evidence.runs.push(run);
      assert.equal(witness.error, undefined); assert.deepEqual(errors, []); assert.deepEqual(witness.result.errors, []);
      assert.equal(witness.result.cases.length, 4);
      if (filter === 'reference') reference = witness.result.cases;
      run.cases = witness.result.cases.map((row, i) => {
        const { pixels, ...scene } = row;
        assert.deepEqual(scene, Object.fromEntries(Object.entries(reference[i]).filter(([key]) => key !== 'pixels')));
        const comparison = compareIntervalPixels(reference[i].pixels, pixels);
        if (filter === 'reference' || filter === true) assertIntervalAccepted(comparison);
        else {
          assert.throws(() => assertIntervalAccepted(comparison));
          assert.ok(comparison.referenceSplatPixels > 0);
          assert.ok(comparison.differentChannels > 0);
          if (filter === 'discard-all') assert.equal(comparison.candidateSplatPixels, 0);
          else assert.ok(comparison.candidateSplatPixels > 0);
        }
        return { ...scene, ...comparison };
      });
    } finally { await page?.close(); await server.close(); }
  }
} catch (error) { evidence.failure = error.stack; process.exitCode = 1; }
finally { await browser?.close(); await writeFile(resolve(output, 'fragment-interval-result.json'), JSON.stringify(evidence, null, 2) + '\n'); }
console.log(JSON.stringify(evidence, null, 2));
