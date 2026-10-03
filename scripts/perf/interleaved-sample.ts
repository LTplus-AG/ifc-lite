/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chromium } from '@playwright/test';
import { writeFileSync, readFileSync } from 'node:fs';
import { ViewerBenchmarkPage } from '../../tests/benchmark/viewer-benchmark-page.js';
import { captureIdentity } from './interleaved-identity.mjs';
import { LIMITS } from './interleaved-plan.mjs';

const sample = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const output = process.argv[3];
const row: Record<string, unknown> = { ...sample, status: 'started', startedAt: new Date().toISOString() };
const logs: string[] = [], errors: string[] = [];
const responseWitness: Array<{ url: string; status: number }> = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let identityTimer: ReturnType<typeof setTimeout> | undefined;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
    '--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
  ] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('console', message => logs.push(message.text()));
  page.on('pageerror', error => errors.push(String(error)));
  page.on('crash', () => errors.push('Browser page crashed'));
  page.on('response', response => {
    if (/\.wasm(?:[?#]|$)/.test(response.url())) responseWitness.push({ url: response.url(), status: response.status() });
  });
  const benchmark = new ViewerBenchmarkPage(page, sample.origin);
  // Fresh process/context; there are no environment overrides or URL switches.
  await benchmark.setup();
  const runtime = await page.evaluate(() => ({
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  }));
  if (!runtime.crossOriginIsolated || !runtime.sharedArrayBuffer) throw new Error('REFUSE: default isolated SAB runtime unavailable');
  await benchmark.loadFile(sample.file, false);
  await benchmark.waitForCompletion(sample.timeoutMs, true);
  // Freeze all measured milestones BEFORE hashes, model/property reads or frames.
  const metrics = benchmark.getMetrics();
  row.readyAtMs = Date.now();
  const readyLogs = benchmark.getConsoleLogs();
  const workerIds = [...new Set([...readyLogs.join('\n').matchAll(/\[stream\] worker\[(\d+)\]/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
  const poolStarts = [...readyLogs.join('\n').matchAll(/processParallel start, fileSizeMB=[\d.]+ workerCount=(\d+)/g)];
  const workerCount = poolStarts.length === 1 ? Number(poolStarts[0]![1]) : null;
  row.metrics = metrics;
  row.runtime = { ...runtime, browserVersion: browser.version(), workerIds, workerCount,
    renderer: 'headless Chrome SwiftShader', workerPool: 'unmodified default',
    shardedLogs: readyLogs.filter(line => /shard|shared|SAB|pre.?pass|worker.*(?:count|pool)/i.test(line)) };
  writeFileSync(output, JSON.stringify(row, null, 2));
  if (!metrics.streamCompleteMs || !metrics.metadataCompleteMs || errors.length || !workerCount || workerIds.length !== workerCount) {
    throw new Error('REFUSE: incomplete milestones, errors or missing worker census');
  }
  const identity = await Promise.race([
    page.evaluate(captureIdentity, LIMITS),
    new Promise<never>((_resolve, reject) => {
      identityTimer = setTimeout(() => reject(new Error('REFUSE: post-readiness identity timeout')), LIMITS.identityMs);
    }),
  ]);
  clearTimeout(identityTimer);
  row.identity = identity;
  // Renderer-owned evidence, no native-GPU/FPS/pixel-identity verdict.
  const colorFrame = await page.evaluate(async () => {
    const hook = (globalThis as Record<string, unknown>).__ifc_lite_capture_color_frame__;
    return typeof hook === 'function' ? await hook() as string | null : null;
  });
  if (colorFrame?.startsWith('data:image/png;base64,')) {
    writeFileSync(`${output}.color.png`, Buffer.from(colorFrame.split(',')[1]!, 'base64'));
    row.colorFrame = `${sample.id}.json.color.png`;
  } else row.colorFrame = null;
  if (!responseWitness.some(response => {
    const url = new URL(response.url);
    return response.status === 200 && url.origin === sample.origin && sample.defaultWasmPaths.includes(url.pathname);
  }) || responseWitness.some(response => response.status !== 200 || new URL(response.url).origin !== sample.origin)) {
    throw new Error('REFUSE: source-built runtime WASM response witness absent/failed/foreign');
  }
  if (errors.length) throw new Error('REFUSE: post-readiness page errors');
  row.status = 'complete';
} catch (error) {
  row.status = 'refused'; row.reason = String(error); process.exitCode = 1;
} finally {
  clearTimeout(identityTimer);
  row.logs = logs; row.errors = errors; row.wasmResponses = responseWitness;
  // Write before teardown, so a close failure cannot erase the actual sample.
  writeFileSync(output, JSON.stringify(row, null, 2));
  if (browser) {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([browser.close(), new Promise<never>((_resolve, reject) => {
        closeTimer = setTimeout(() => reject(new Error('REFUSE: browser close timeout')), LIMITS.teardownMs);
      })]);
      row.teardown = 'complete';
    } catch (error) {
      row.status = 'refused'; row.teardown = String(error); process.exitCode = 1;
    } finally { clearTimeout(closeTimer); }
  }
  row.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(row, null, 2));
}
