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
import { stageRetainedBrowserAssets } from './stage-retained-browser-assets.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const BROWSER = resolve(import.meta.dirname, '../native/smlib-adapter/browser');
const TEST_FILES = ['test.html', 'lifecycle-contract.mjs', 'tests/hung-worker.mjs', 'tests/missing-asset-worker.mjs'];
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

/** Serves `root` under /smlib/ only; every other path is 404. */
export function serveStaged(root) {
  return http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const file = normalize(join(root, decodeURIComponent(path.slice('/smlib/'.length))));
    if (!path.startsWith('/smlib/') || !file.startsWith(root + sep)) { response.writeHead(404); response.end(); return; }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
}

export async function runWorkerProbe({ build, sdk, timeout = 300_000 }) {
  const temporary = await mkdtemp(join(tmpdir(), 'smlib-worker-probe-'));
  const root = join(temporary, 'smlib');
  let server, browser;
  try {
    await stageRetainedBrowserAssets({ build, sdk, out: root });
    await mkdir(join(root, 'tests'));
    for (const name of TEST_FILES) await copyFile(join(BROWSER, name), join(root, name));
    server = serveStaged(root);
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
    console.error('Usage: node scripts/smlib-browser-worker-probe.mjs --build ABS --sdk ABS');
    process.exitCode = 2;
  } else {
    runWorkerProbe(options).then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (result.passed !== true) process.exitCode = 1;
    }, (error) => { console.error(error); process.exitCode = 1; });
  }
}
