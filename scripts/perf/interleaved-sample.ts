/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chromium, type Page } from '@playwright/test';
import { guardViewerCompletion } from '../../tests/benchmark/metadata-render-readiness.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ViewerBenchmarkPage } from '../../tests/benchmark/viewer-benchmark-page.js';
import { captureIdentity } from './interleaved-identity.mjs';
import { LIMITS, immutableRef, FIXTURES, requireGraphicsProfile } from './interleaved-plan.mjs';
import type { SampleConfig, SampleResult } from './interleaved-types.js';
import { isAbsolute } from 'node:path';
import { boundedDiagnostic, diagnosticEvent, frozenBeforeTeardown, passiveRendererWitness,
  refusedRendererSnapshot, writeAtomicEvidence, type DiagnosticEvent } from './interleaved-diagnostics.js';

function sampleConfig(value: unknown): SampleConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('REFUSE: invalid sample configuration');
  const fields = value as Record<string, unknown>;
  const string = (key: string): string => {
    const result = fields[key];
    if (typeof result !== 'string' || !result) throw new Error(`REFUSE: invalid sample ${key}`);
    return result;
  };
  const integer = (key: string): number => {
    const result = fields[key];
    if (typeof result !== 'number' || !Number.isInteger(result) || result < 0) throw new Error(`REFUSE: invalid sample ${key}`);
    return result;
  };
  const arm = fields.arm, kind = fields.kind;
  if ((arm !== 'base' && arm !== 'candidate') || (kind !== 'AA' && kind !== 'AB')) throw new Error('REFUSE: invalid arm/control');
  const family = string('family'), path = string('path'), timeoutMs = integer('timeoutMs');
  if (!FIXTURES.some(fixture => fixture.family === family && fixture.path === path && fixture.timeoutMs === timeoutMs)) throw new Error('REFUSE: non-protocol fixture');
  const pair = integer('pair'), slot = integer('slot'), id = string('id'), file = string('file'), origin = string('origin');
  if (pair > 5 || slot > 1 || kind !== (pair === 0 ? 'AA' : 'AB') || id !== `${family}-${pair}-${slot}-${arm}` || !isAbsolute(file)) throw new Error('REFUSE: invalid sample identity');
  const expectedArm = pair === 0 ? 'base' : pair % 2 ? (slot === 0 ? 'base' : 'candidate') : (slot === 0 ? 'candidate' : 'base');
  if (arm !== expectedArm) throw new Error('REFUSE: sample arm departs from fixed schedule');
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash) throw new Error('REFUSE: invalid frozen origin');
  const rawPaths: unknown = fields.defaultWasmPaths;
  if (!Array.isArray(rawPaths) || !rawPaths.length) throw new Error('REFUSE: missing default WASM paths');
  const defaultWasmPaths = rawPaths.map((item: unknown) => {
    if (typeof item !== 'string' || !item.startsWith('/') || !item.endsWith('.wasm')) throw new Error('REFUSE: invalid WASM path');
    return item;
  });
  const host = fields.hostBefore;
  if (!host || typeof host !== 'object' || !('loadavg' in host) || typeof host.loadavg !== 'string') throw new Error('REFUSE: missing host receipt');
  return { arm, kind, family, path, timeoutMs, pair, slot, id, file, origin,
    revision: immutableRef(fields.revision), defaultWasmPaths, hostBefore: { loadavg: host.loadavg },
    graphics: requireGraphicsProfile(fields.graphics) };
}
const input: unknown = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sample = sampleConfig(input);
const output = process.argv[3];
const row: SampleResult = { ...sample, status: 'started', startedAt: new Date().toISOString() };
const logs: string[] = [], errors: string[] = [];
const diagnosticEvents: DiagnosticEvent[] = [];
const diagnosticStartedMs = Date.now();
let phase = 'setup';
const responseWitness: Array<{ url: string; status: number }> = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
let passiveObservation: Promise<void> | undefined;
let identityTimer: ReturnType<typeof setTimeout> | undefined;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...sample.graphics.flags] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('console', message => {
    logs.push(message.text());
    diagnosticEvents.push({ ...diagnosticEvent('console', message.text(), phase, diagnosticStartedMs),
      level: message.type(), url: message.location().url });
  });
  page.on('pageerror', error => {
    errors.push(String(error));
    diagnosticEvents.push(diagnosticEvent('pageerror', String(error), phase, diagnosticStartedMs));
  });
  page.on('crash', () => {
    errors.push('Browser page crashed');
    diagnosticEvents.push(diagnosticEvent('crash', 'Browser page crashed', phase, diagnosticStartedMs));
  });
  page.on('response', response => {
    if (/\.wasm(?:[?#]|$)/.test(response.url())) responseWitness.push({ url: response.url(), status: response.status() });
  });
  const benchmark = new ViewerBenchmarkPage(page, sample.origin);
  // Fresh process/context; there are no environment overrides or URL switches.
  await benchmark.setup();
  await benchmark.installSceneReadinessObserver();
  const runtime = await page.evaluate(() => ({
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  }));
  if (!runtime.crossOriginIsolated || !runtime.sharedArrayBuffer) throw new Error('REFUSE: default isolated SAB runtime unavailable');
  // One passive read, not a renderer-ready wait. Preserve the cold upload boundary.
  row.passiveRendererWitness = { issuedUTC: new Date().toISOString() };
  passiveObservation = boundedDiagnostic(page.evaluate(passiveRendererWitness), 2000).then(result => {
    if (row.passiveRendererWitness) row.passiveRendererWitness.result = result;
  });
  phase = 'load-and-readiness';
  await benchmark.loadFile(sample.file, false);
  await benchmark.waitForCompletion(sample.timeoutMs, true);
  // Freeze all measured milestones BEFORE hashes, model/property reads or frames.
  const metrics = benchmark.getMetrics();
  phase = 'post-readiness';
  row.readyAtMs = Date.now();
  const readyLogs = benchmark.getConsoleLogs();
  const workerIds = [...new Set([...readyLogs.join('\n').matchAll(/\[stream\] worker\[(\d+)\]/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
  const poolStarts = [...readyLogs.join('\n').matchAll(/processParallel start, fileSizeMB=[\d.]+ workerCount=(\d+)/g)];
  const workerCount = poolStarts.length === 1 ? Number(poolStarts[0]![1]) : null;
  row.metrics = metrics;
  row.runtime = { ...runtime, browserVersion: browser.version(), workerIds, workerCount,
    renderer: 'headless Chrome; requested SwiftShader/Vulkan profile', workerPool: 'unmodified default',
    shardedLogs: readyLogs.filter(line => /shard|shared|SAB|pre.?pass|worker.*(?:count|pool)/i.test(line)) };
  writeAtomicEvidence(output, JSON.stringify(row, null, 2));
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
    const result: unknown = typeof hook === 'function' ? await hook() : null;
    if (result !== null && typeof result !== 'string') throw new Error('REFUSE: unsupported color-frame callback result');
    return result;
  });
  if (colorFrame?.startsWith('data:image/png;base64,')) {
    writeAtomicEvidence(`${output}.color.png`, Buffer.from(colorFrame.split(',')[1]!, 'base64'));
    row.colorFrame = `${sample.id}.json.color.png`;
  } else row.colorFrame = null;
  if (!responseWitness.some(response => {
    const url = new URL(response.url);
    return response.status === 200 && url.origin === sample.origin && sample.defaultWasmPaths.includes(url.pathname);
  }) || responseWitness.some(response => response.status !== 200 || new URL(response.url).origin !== sample.origin)) {
    throw new Error('REFUSE: source-built runtime WASM response witness absent/failed/foreign');
  }
  if (errors.length) throw new Error('REFUSE: post-readiness page errors');
  guardViewerCompletion(logs, () => { row.status = 'complete'; }, error => { throw error; });
} catch (error) {
  row.status = 'refused'; row.reason = String(error); process.exitCode = 1;
} finally {
  clearTimeout(identityTimer);
  if (row.status === 'complete') {
    guardViewerCompletion(logs, () => undefined, error => {
      row.status = 'refused'; row.reason = String(error); process.exitCode = 1;
    });
  }
  row.logs = logs; row.errors = errors; row.wasmResponses = responseWitness;
  row.diagnosticEvents = diagnosticEvents;
  try {
    // Guard this initial write too: a disk failure must still reach browser close.
    writeAtomicEvidence(output, JSON.stringify(row, null, 2));
    if (passiveObservation) await passiveObservation;
    // A fault may be delivered during that final bounded observation too.
    if (row.status === 'complete') {
      guardViewerCompletion(logs, () => undefined, error => {
        row.status = 'refused'; row.reason = String(error); process.exitCode = 1;
      });
    }
    if (row.status === 'refused' && page) {
      phase = 'refusal-diagnostics';
      const state = await boundedDiagnostic(page.evaluate(refusedRendererSnapshot), 2000);
      const screenshot = await boundedDiagnostic(page.screenshot({ type: 'png', timeout: 3000 }), 3000);
      let image: unknown = screenshot;
      if (screenshot.status === 'observed') {
        if (screenshot.value.byteLength <= 16 * 1024 ** 2) {
          const path = `${output}.refused.png`;
          writeAtomicEvidence(path, screenshot.value);
          image = { status: 'observed', path, bytes: screenshot.value.byteLength,
            sha256: createHash('sha256').update(screenshot.value).digest('hex') };
        } else image = { status: 'unavailable', reason: 'diagnostic screenshot 16MiB bound' };
      }
      row.refusalDiagnostics = { state, screenshot: image };
    }
    const snapshot = frozenBeforeTeardown(row, diagnosticEvents, {
      passiveRendererWitness: row.passiveRendererWitness, refusalDiagnostics: row.refusalDiagnostics,
    });
    const snapshotPath = `${output}.pre-teardown.json`;
    writeAtomicEvidence(snapshotPath, snapshot.captured);
    row.preTeardown = { path: snapshotPath, sha256: snapshot.sha256, status: row.status };
    writeAtomicEvidence(output, JSON.stringify(row, null, 2));
  } catch (error) {
    // Diagnostics must not bypass the owned browser close on a disk/page failure.
    console.error('Pre-teardown diagnostic capture failed:', error);
    row.refusalDiagnostics = { status: 'unavailable', reason: String(error), previous: row.refusalDiagnostics };
  }
  phase = 'teardown';
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
  try { writeAtomicEvidence(output, JSON.stringify(row, null, 2)); }
  catch (error) {
    console.error('Final sample receipt write failed; prior atomic receipt retained:', error);
    process.exitCode = 1;
  }
}
