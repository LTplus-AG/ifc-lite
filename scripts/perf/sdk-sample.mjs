/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { limits, requireDiagnostics, poolCensus } from './sdk-plan.mjs';
import { fileHash } from './interleaved-assets.mjs';
import { canonicalSemanticWarning, canonicalConsumerSummary } from './sdk-semantic-warnings.mjs';
const [inputPath, resultPath] = process.argv.slice(2);
if (!inputPath || !resultPath) throw new Error('sample input/output required');
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const row = { ...input.sample, status: 'started', logs: [], errors: [], requests: [], requestFinished: [], responses: [], semanticWarnings: [] };
let browser, page, phase = 'loading', abortReason, records = 0, recordBytes = 0, rejectAbort;
const abortPromise = new Promise((_accept, reject) => { rejectAbort = reject; });
abortPromise.catch(error => { row.abortWitness = String(error); });
const abort = reason => { abortReason ??= String(reason); rejectAbort(new Error(abortReason)); };
const signalHandlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => abort(`received ${signal}`)]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
const persist = () => writeFileSync(resultPath, JSON.stringify(row, null, 2));
function append(target, value) {
  const record = { at: Date.now(), phase, ...value }, cost = Buffer.byteLength(JSON.stringify(record));
  if (++records > limits.records || (recordBytes += cost) > limits.recordBytes) { abort('capture record/byte bound'); return; }
  target.push(record);
}
async function bounded(operation, ms, label, includeAbort = true) {
  let timer;
  try { return await Promise.race([operation, ...(includeAbort ? [abortPromise] : []), new Promise((_accept, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline`)), Math.max(1, ms));
  })]); } finally { clearTimeout(timer); }
}
persist();
try {
  for (const key of Object.keys(process.env)) if (key.startsWith('VIEWER_BENCHMARK_')) throw new Error('default override refused');
  browser = await bounded(chromium.launch({ executablePath: input.chromeExecutable, headless: true, timeout: 30000, args: [] }), 30000, 'fresh Chrome');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const assetFor = url => {
    if (!URL.canParse(url)) return undefined;
    const parsed = new URL(url);
    return parsed.origin === input.origin ? input.assets.find(asset => asset.path === (parsed.pathname.slice(1) || 'index.html')) : undefined;
  };
  context.on('console', message => {
    const text = message.text(), type = message.type(), location = message.location();
    append(row.logs, { text, type, location });
    const asset = assetFor(location.url), worker = asset?.path.includes('geometry.worker'), consumer = /^assets\/index-[^/]+\.js$/.test(asset?.path ?? '');
    const semantic = type === 'warning' && worker ? canonicalSemanticWarning(text) : null;
    const summary = type === 'warning' && consumer ? canonicalConsumerSummary(text) : null;
    if (semantic || summary) { append(row.semanticWarnings, { text, location, ...(semantic ?? summary) }); return; }
    if (['warning', 'error'].includes(type) || /retry|recover|fallback|replac|restart|panic|trap/i.test(text)
      || !['log', 'info', 'debug'].includes(type) || (!worker && !consumer)) abort(`console source/type/execution refusal: ${text}`);
  });
  context.on('page', tab => {
    tab.on('pageerror', error => { append(row.errors, { message: String(error), stack: error.stack }); abort(`page error: ${error}`); });
    tab.on('crash', () => abort('page crash'));
  });
  context.on('request', request => append(row.requests, { url: request.url(), method: request.method() }));
  context.on('requestfinished', request => append(row.requestFinished, { url: request.url() }));
  context.on('requestfailed', request => { append(row.errors, { url: request.url(), failure: request.failure() }); abort(`request failed: ${request.url()}`); });
  context.on('response', response => {
    append(row.responses, { url: response.url(), status: response.status() });
    if (!assetFor(response.url()) || response.status() !== 200) abort('unqualified asset response');
  });
  page = await bounded(context.newPage(), 30000, 'fresh page');
  await bounded(page.goto(input.origin, { waitUntil: 'load', timeout: 30000 }), 30000, 'endpoint load');
  await bounded(page.waitForFunction(() => Boolean(window.__canonicalPoolEndpoint), undefined, { timeout: 30000 }), 30000, 'endpoint API');
  row.runtime = await page.evaluate(() => ({ hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null, sab: typeof SharedArrayBuffer !== 'undefined', crossOriginIsolated,
    overrides: Object.getOwnPropertyNames(globalThis).filter(key => key.startsWith('__IFC_LITE_')) }));
  row.runtime.browserVersion = browser.version();
  if (!row.runtime.sab || !row.runtime.crossOriginIsolated || row.runtime.hardwareConcurrency < 2 || row.runtime.overrides.length
    || !input.chromeVersion.includes(row.runtime.browserVersion)) throw new Error('default web runtime mismatch');
  if (await fileHash(input.file) !== input.sample.sha256) throw new Error('fixture changed before prepare');
  await bounded(page.locator('#fixture').setInputFiles(input.file), 60000, 'upload outside geometry timer');
  await bounded(page.evaluate(async family => {
    const input = document.querySelector('#fixture');
    if (!(input instanceof HTMLInputElement) || !input.files?.[0]) throw new Error('uploaded first File absent');
    await window.__canonicalPoolEndpoint.prepare(input.files[0], family);
  }, input.sample.family), 60000, 'prepare outside geometry timer');
  row.preparedUTC = new Date().toISOString(); phase = 'geometry-and-posthash';
  row.receipt = await bounded(page.evaluate(() => window.__canonicalPoolEndpoint.run()), input.sample.timeoutMs + 120000 + limits.cleanupMs, 'canonical stream drain');
  row.drainedUTC = new Date().toISOString();
  if (row.receipt.status !== 'supported-output' || !row.receipt.generatorDone || !row.receipt.processorDisposed
    || !/^[a-f0-9]{64}$/.test(row.receipt.identity?.sha256 ?? '') || !Number.isFinite(row.receipt.elapsedMs) || row.receipt.elapsedMs <= 0) throw new Error(`endpoint refusal: ${row.receipt.error ?? row.receipt.cleanupError ?? row.receipt.status}`);
  requireDiagnostics(row.receipt.complete?.diagnostics);
  if ((row.receipt.complete.coordinateInfo.boundsRecoveryFallbackCount ?? 0) > 0) throw new Error('bounds recovery refused');
  const starts = row.logs.flatMap(record => [...record.text.matchAll(/processParallel start, fileSizeMB=[\d.]+ workerCount=(\d+)/g)]);
  if (starts.length !== 1) throw new Error('one actual default pool-start log required');
  row.workerCount = Number(starts[0][1]); row.workerIds = poolCensus(row.workerCount, row.receipt.workerMemory);
  phase = 'postdrain-asset-verification'; row.responseIdentity = [];
  const observed = new Set(row.responses.map(item => item.url));
  for (const asset of input.assets) {
    const url = `${input.origin}/${asset.path}`;
    if (!observed.has(url)) continue;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (response.status !== 200 || response.url !== url || !response.body || response.headers.get('content-length') !== String(asset.size)) throw new Error('immutable-origin refetch response mismatch');
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > asset.size) throw new Error('refetch size bound'); hash.update(chunk); }
      const digest = hash.digest('hex');
      if (bytes !== asset.size || digest !== asset.sha256) throw new Error('immutable-origin refetch bytes mismatch');
      row.responseIdentity.push({ path: asset.path, bytes, sha256: digest, requestFinishedCount: row.requestFinished.filter(item => item.url === url).length });
    } finally { clearTimeout(timer); controller.abort(); }
  }
  if (!row.responseIdentity.some(item => item.path.endsWith('.wasm')) || !row.responseIdentity.some(item => item.path.includes('geometry.worker'))
    || !row.responseIdentity.some(item => /^assets\/index-.*\.js$/.test(item.path))) throw new Error('loaded WASM/worker/consumer witness missing');
  row.status = 'pending-cleanup';
} catch (error) { row.status = 'refused'; row.reason = String(error); }
finally {
  const preTeardownPath = `${resultPath}.pre-teardown.json`;
  const captured = JSON.stringify({ capturedUTC: new Date().toISOString(), status: row.status,
    reason: row.reason, logs: row.logs, errors: row.errors, responses: row.responses, abortReason }, null, 2);
  writeFileSync(preTeardownPath, captured);
  row.preTeardown = { path: preTeardownPath, sha256: createHash('sha256').update(captured).digest('hex'),
    logs: row.logs.length, errors: row.errors.length, status: row.status }; persist();
  phase = 'teardown';
  try { if (browser) await bounded(browser.close(), limits.cleanupMs, 'browser teardown', false); row.teardown = 'complete'; }
  catch (error) { row.teardown = 'refused'; row.status = 'refused'; row.teardownError = String(error); }
  if (abortReason) { row.status = 'refused'; row.abortReason = abortReason; }
  if (row.status === 'pending-cleanup' && row.teardown === 'complete') row.status = 'complete';
  persist(); if (row.status !== 'complete') process.exitCode = 1;
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
