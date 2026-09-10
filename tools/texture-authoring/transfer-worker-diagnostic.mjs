/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Offline acceptance harness, not a CI gate or product worker. The documented
// experimental runtime always refuses a plan. Five fresh workers plus one
// cancellation trial; no image/model files are downloaded by this tool.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import os from 'node:os';
import { openSync, closeSync, fstatSync, readSync, writeFileSync, constants } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const [rootArg, inputPath, outputPath, dependencyRoot = process.cwd()] = process.argv.slice(2);
if (!rootArg || !inputPath || !outputPath) {
  throw new Error('Usage: node transfer-worker-diagnostic.mjs <diagnostic-worktree> <input.json> <output.json> [dependency-worktree]');
}
const root = resolve(rootArg);
const { chromium } = createRequire(resolve(dependencyRoot, 'package.json'))('@playwright/test');

function readBounded(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
      throw new Error('Diagnostic input must be a regular file at most 64 MiB');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > stat.size) throw new Error('Diagnostic input grew while reading');
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

const workerSource = `
import {initSync, IfcAPI} from '/ifc-lite.js';
const wasm = initSync({module: await (await fetch('/ifc-lite.wasm')).arrayBuffer()});
self.postMessage({phase: 'ready'});
self.onmessage = ({data}) => {
  const start = performance.now(), initialMemory = wasm.memory.buffer.byteLength;
  const api = new IfcAPI();
  try {
    const {request, source, rgba} = JSON.parse(data);
    request.registrationSha256 = JSON.parse(new TextDecoder().decode(
      api.registerScanCorrespondences(JSON.stringify(request.registration))
    )).requestSha256;
    const content = new TextEncoder().encode(source);
    const json = JSON.stringify(request);
    const pixels = Uint8Array.from(atob(rgba), c => c.charCodeAt(0));
    self.postMessage({phase: 'native'});
    const nativeStart = performance.now();
    try {
      api.planMeshTransfer(content, json, pixels);
      self.postMessage({error: 'Unexpected plan response from calculation-only runtime'});
    } catch (error) {
      self.postMessage({
        phase: 'complete', refusal: String(error.message),
        nativeMilliseconds: performance.now() - nativeStart,
        workerMilliseconds: performance.now() - start,
        initialMemory, finalMemory: wasm.memory.buffer.byteLength,
      });
    }
  } finally {
    api.free();
  }
};`;

const routes = new Map([
  ['/ifc-lite.js', [readBounded(root + '/packages/wasm/pkg/ifc-lite.js'), 'text/javascript']],
  ['/ifc-lite.wasm', [readBounded(root + '/packages/wasm/pkg/ifc-lite_bg.wasm'), 'application/wasm']],
  ['/worker.js', [workerSource, 'text/javascript']],
  ['/input.json', [readBounded(inputPath), 'application/json']],
  ['/', ['<!doctype html><title>Bounded scan transfer diagnostic</title>', 'text/html']],
]);
const server = createServer((req, res) => {
  const item = routes.get(req.url);
  if (!item) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': item[1],
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cache-Control': 'no-store',
  });
  res.end(item[0]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing diagnostic server port');
const url = `http://127.0.0.1:${address.port}`;
const results = [];

function processTreeRss(pid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const children = new Map(), memory = new Map();
  for (const [child, parent, rss] of rows) {
    const siblings = children.get(parent) ?? [];
    siblings.push(child);
    children.set(parent, siblings);
    memory.set(child, rss * 1024);
  }
  const pending = [pid], visited = new Set();
  let total = 0;
  while (pending.length) {
    const child = pending.pop();
    if (visited.has(child)) continue;
    visited.add(child);
    total += memory.get(child) ?? 0;
    for (const descendant of children.get(child) ?? []) pending.push(descendant);
  }
  return total;
}

try {
  for (let iteration = 0; iteration < 6; iteration++) {
    let browserServer, browser, context, timer;
    try {
      browserServer = await chromium.launchServer({ headless: true });
      browser = await chromium.connect(browserServer.wsEndpoint());
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url);
      const pid = browserServer.process().pid;
      let peakRss = processTreeRss(pid);
      const baselineRss = peakRss;
      let samplingError;
      timer = setInterval(() => {
        try {
          peakRss = Math.max(peakRss, processTreeRss(pid));
        } catch (error) {
          samplingError = error;
          clearInterval(timer);
        }
      }, 50);
      const run = await page.evaluate(async cancel => {
        const input = await (await fetch('/input.json')).text();
        const start = performance.now();
        let last = performance.now(), maxHeartbeatGap = 0;
        const heartbeat = setInterval(() => {
          const now = performance.now();
          maxHeartbeatGap = Math.max(maxHeartbeatGap, now - last);
          last = now;
        }, 10);
        const worker = new Worker('/worker.js', { type: 'module' });
        try {
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              worker.terminate();
              reject(new Error('60 second diagnostic timeout'));
            }, 60000);
            worker.onerror = event => {
              clearTimeout(timeout);
              reject(new Error(event.message));
            };
            worker.onmessage = ({ data }) => {
              if (data.phase === 'ready') worker.postMessage(input);
              if (data.phase === 'native' && cancel) {
                setTimeout(() => {
                  const requested = performance.now();
                  worker.terminate();
                  clearTimeout(timeout);
                  resolve({
                    cancelled: true, cancelRequestedAfterNativeMilliseconds: 100,
                    terminateCallMilliseconds: performance.now() - requested,
                    roundtripMilliseconds: performance.now() - start, maxHeartbeatGap,
                  });
                }, 100);
              }
              if (data.error) {
                clearTimeout(timeout);
                reject(new Error(data.error));
              }
              if (data.phase === 'complete') {
                clearTimeout(timeout);
                if (!data.refusal.startsWith('PROBE COMPLETE;')) {
                  reject(new Error('Expected calculation-only full traversal diagnostic: ' + data.refusal));
                  return;
                }
                resolve({ ...data, roundtripMilliseconds: performance.now() - start, maxHeartbeatGap });
              }
            };
          });
        } finally {
          clearInterval(heartbeat);
          worker.terminate();
        }
      }, iteration === 5);
      if (samplingError) throw samplingError;
      peakRss = Math.max(peakRss, processTreeRss(pid));
      results.push({
        iteration, browserVersion: browser.version(), ...run,
        browserTreeBaselineRssBytes: baselineRss, browserTreeSampledPeakRssBytes: peakRss,
      });
    } finally {
      clearInterval(timer);
      try {
        await context?.close();
      } finally {
        try { await browser?.close(); }
        finally { await browserServer?.close(); }
      }
    }
  }
  writeFileSync(outputPath, JSON.stringify({
    platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(),
    browser: 'Playwright Chromium fresh browser/context/module worker each run',
    rssSamplingMilliseconds: 50, results,
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
}
