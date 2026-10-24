#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
// Actual module-Worker witness for the SMLib browser transport. Stages the
// canonical /smlib bundle from an existing Emscripten build, adds only the
// test page and its fault fixtures, serves it over local HTTP and runs it in a
// real Chromium. Nothing is mocked: the SDK module executes in the Workers.
import http from 'node:http';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { verifyRetainedAssets } from './lib/retained-asset-contract.mjs';
import { stageRetainedBrowserAssets } from './stage-retained-browser-assets.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const BROWSER = resolve(import.meta.dirname, '../native/smlib-adapter/browser');
const TEST_FILES = ['test.html', 'patch-accuracy-contract.mjs', 'tests/patch-accuracy-worker.mjs', 'plane-chain-contract.mjs', 'lifecycle-contract.mjs', 'tests/hung-worker.mjs', 'tests/missing-asset-worker.mjs'];
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

/** Serves each `prefix -> directory` mount; every other path is 404. */
export function serveRoots(mounts) {
  return http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const [prefix, root] = Object.entries(mounts).find(([mount]) => path.startsWith(mount)) ?? [];
    const file = root && normalize(join(root, decodeURIComponent(path.slice(prefix.length))));
    if (!file || !file.startsWith(root + sep)) { response.writeHead(404); response.end(); return; }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
}

/** Stages the canonical /smlib bundle from an existing Emscripten build. */
export async function stageTemporary({ build, sdk, engine, emscripten, inputs }) {
  const temporary = await mkdtemp(join(tmpdir(), 'smlib-worker-probe-'));
  const root = join(temporary, 'smlib');
  try {
    await stageRetainedBrowserAssets({ build, sdk, engine, emscripten, inputs, out: root });
    await verifyRetainedAssets(root, inputs);
    return { temporary, root };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function runWorkerProbe({ build, sdk, engine, emscripten, inputs, timeout = 300_000 }) {
  const { temporary, root } = await stageTemporary({ build, sdk, engine, emscripten, inputs });
  let server, browser;
  try {
    await mkdir(join(root, 'tests'));
    for (const name of TEST_FILES) await copyFile(join(BROWSER, name), join(root, name));
    for (const suffix of ['mjs', 'wasm']) {
      const name = `ifclite_smlib_patch_accuracy_worker.${suffix}`;
      await copyFile(join(build, name), join(root, 'tests', name));
    }
    server = serveRoots({ '/smlib/': root });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/smlib/test.html`);
    await page.waitForFunction(() => window.probeResult !== undefined, null, { timeout });
    const result = await page.evaluate(() => window.probeResult);
    return { ...result, pageErrors: errors };
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
    console.error('Usage: node scripts/smlib-browser-worker-probe.mjs --build ABS --sdk ABS --engine ABS --emscripten ABS --inputs ABS');
    process.exitCode = 2;
  } else {
    runWorkerProbe(options).then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.passed !== true) process.exitCode = 1;
    }, (error) => { console.error(error); process.exitCode = 1; });
  }
}
