#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Actual-Worker contract for the @ifc-lite/wasm retained engine (pkg-retained):
// stages /smlib from an existing Emscripten adapter build, serves it beside
// the built packages/wasm/pkg-retained and runs rust/wasm-bindings/tests/retained-
// browser/contract.mjs in Chromium. Packaging and contract only; source-only
// displays are never final product geometry.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { serveRoots, stageTemporary } from './smlib-browser-worker-probe.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PAGE = `<!doctype html><meta charset="utf-8"><title>retained browser contract</title>
<script type="module">
try {
  const wasm = await import('/pkg/ifc-lite.js');
  await wasm.default();
  const { runRetainedBrowserContract } = await import('/contract/contract.mjs');
  const fixture = await (await fetch('/fixtures/mapped_instances_synthetic.ifc')).text();
  window.contractResult = await runRetainedBrowserContract(wasm, fixture);
} catch (error) { window.contractResult = { passed: false, error: String(error), stack: error?.stack }; }
</script>`;

export async function runRetainedBrowserContract({ build, sdk, timeout = 300_000 }) {
  const { temporary, root } = await stageTemporary({ build, sdk });
  let server, browser;
  try {
    await writeFile(join(temporary, 'index.html'), PAGE);
    server = serveRoots({
      '/smlib/': root,
      '/pkg/': join(ROOT, 'packages/wasm/pkg-retained'),
      '/contract/': join(ROOT, 'rust/wasm-bindings/tests/retained-browser'),
      '/fixtures/': join(ROOT, 'rust/geometry/tests/fixtures'),
      '/page/': temporary, // index.html only
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/page/index.html`);
    await page.waitForFunction(() => window.contractResult !== undefined, null, { timeout });
    return { ...(await page.evaluate(() => window.contractResult)), pageErrors: errors };
  } finally {
    await browser?.close();
    if (server) await new Promise((done) => server.close(done));
    await rm(temporary, { recursive: true, force: true });
  }
}

if (isMainEntry(import.meta.url)) {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) options[args[i].replace(/^--/, '')] = args[i + 1];
  if (!options.build || !options.sdk) {
    console.error('Usage: node scripts/retained-browser-contract.mjs --build ABS --sdk ABS (after BUILD_RETAINED=1 scripts/build-wasm.sh)');
    process.exitCode = 2;
  } else {
    await readFile(join(ROOT, 'packages/wasm/pkg-retained/ifc-lite_bg.wasm')).catch(() => {
      throw new Error('packages/wasm/pkg-retained is not built: run BUILD_RETAINED=1 bash scripts/build-wasm.sh');
    });
    runRetainedBrowserContract(options).then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.passed !== true) process.exitCode = 1;
    }, (error) => { console.error(error); process.exitCode = 1; });
  }
}
