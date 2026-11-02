/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 RESEARCH PREVIEW recorder. Explicit manual tool, not a CI gate.
// Run it under ~/build-workers/ifc-gpu-check, which exports IFC_GPU_CDP_URL for
// a hardware Chrome; a fallback/software adapter is refused. Timing fields are
// diagnostics of one take, never performance evidence.
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { showcaseCredits } from './showcase-credits.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(root, '../..');
const { values: args } = parseArgs({ options: {
  asset: { type: 'string' }, assets: { type: 'string' }, out: { type: 'string' },
  mode: { type: 'string', default: 'record' }, azimuth: { type: 'string', default: '0' },
  framing: { type: 'string' }, rotation: { type: 'string', default: 'x180' },
  stills: { type: 'string', default: '0,8,15,19,22,26,30' }, turntable: { type: 'string', default: '0,30,60,90,120,150,180,210,240,270,300,330' },
  width: { type: 'string', default: '1920' }, height: { type: 'string', default: '1080' },
  'mime-type': { type: 'string' }, bitrate: { type: 'string', default: '40000000' },
} });
const assets = resolve(args.assets ?? process.env.SPLAT_SPIKE_ASSETS ?? '');
if (!args.asset || !args.out || !isAbsolute(args.out) || !assets) throw new Error('usage: --asset NAME.ply --assets ABS_DIR --out ABS_DIR [--mode turntable|stills|record]');
if (!['turntable', 'stills', 'record'].includes(args.mode)) throw new Error(`unknown mode ${args.mode}`);
const cdp = process.env.IFC_GPU_CDP_URL;
if (!cdp) throw new Error('IFC_GPU_CDP_URL is not set: run under ~/build-workers/ifc-gpu-check for a hardware Chrome');

const manifest = JSON.parse(await readFile(join(repo, 'tests/models/manifest.json'), 'utf8'));
const entry = manifest.files.find(file => file.path === `gaussian/${args.asset}`);
if (!entry?.gaussian) throw new Error(`gaussian/${args.asset} is not a catalogued Gaussian fixture`);
const credits = showcaseCredits(entry);
const sha256File = path => new Promise((done, fail) => {
  const hash = createHash('sha256');
  createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
});
const localPath = join(assets, args.asset);
const localSha = await sha256File(localPath);
if (localSha !== entry.sha256) throw new Error(`${localPath} SHA-256 ${localSha} differs from the manifest`);
await mkdir(args.out, { recursive: true });
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const pkg = async name => JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

process.env.SPLAT_SPIKE_ASSETS = assets;
const server = await createServer({ root, configFile: resolve(root, 'vite.config.mjs'), logLevel: 'warn',
  server: { host: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 9000), strictPort: false } });
const evidence = {
  label: 'RESEARCH PREVIEW: upstream PlayCanvas research spike, not the ifc-lite production viewer',
  issue: 8567, mode: args.mode, date: new Date().toISOString(), host: hostname(),
  source: { head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--', 'examples/gaussian-splat-spike') !== '' },
  runtime: { playcanvas: await pkg('playcanvas'), splatTransform: await pkg('@playcanvas/splat-transform'), playwright: await pkg('@playwright/test'), node: process.version },
  asset: { path: entry.path, bytes: entry.size, sha256: entry.sha256, localPath, localSha256Verified: true, gaussian: entry.gaussian },
  credits, outputs: [], notQualified: ['integrated ifc-lite viewer', 'performance or budgets', 'metric scale or alignment', 'IFC overlay'],
};
let browser, page;
try {
  await server.listen();
  const base = server.resolvedUrls.local[0];
  browser = await chromium.connectOverCDP(cdp);
  evidence.browser = { version: browser.version(), cdp: 'ifc-gpu-check Windows Chrome' };
  const context = browser.contexts()[0] ?? await browser.newContext();
  page = await context.newPage();
  await page.setViewportSize({ width: Number(args.width), height: Number(args.height) });
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.length < 20 && consoleErrors.push(error.message));
  page.on('console', message => message.type() === 'error' && consoleErrors.length < 20 && consoleErrors.push(message.text()));
  const query = new URLSearchParams({ asset: args.asset, sha256: entry.sha256, bytes: String(entry.size), count: String(entry.gaussian.count),
    rotation: args.rotation, azimuth: args.azimuth, width: args.width, height: args.height, ...(args.framing ? { framing: args.framing } : {}) });
  await page.goto(`${base}showcase.html?${query}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => window.showcase?.ready || window.showcase?.error, undefined, { timeout: 900_000, polling: 1000 });
  const ready = await page.evaluate(() => { const s = window.showcase; return { ready: s.ready, error: s.error, adapter: s.adapter, userAgent: navigator.userAgent,
    playcanvas: s.playcanvas, numSplats: s.numSplats, shBands: s.shBands, rotation: s.rotation, framing: s.framing, autoFraming: s.autoFraming,
    sortedAtStart: s.sortedAtStart, gsplatRenderer: s.gsplatRenderer, sortPath: s.sortPath, supportedTypes: s.supportedTypes, loadToFirstSettledFrameMs: s.loadToFirstSettledFrameMs, errors: s.errors }; });
  Object.assign(evidence, { page: ready, consoleErrors });
  if (!ready.ready) throw new Error(ready.error);
  const adapter = ready.adapter ?? {};
  if (adapter.fallback !== false || !adapter.vendor || /swiftshader/i.test(`${adapter.architecture} ${adapter.description}`)) {
    throw new Error(`refusing non-hardware adapter ${JSON.stringify(adapter)}`);
  }
  const savePng = async (name, request) => {
    const started = Date.now();
    const still = await request;
    const file = join(args.out, name);
    await writeFile(file, Buffer.from(still.png.split(',')[1], 'base64'));
    const output = { file, sha256: await sha256File(file), pose: still.pose, settled: still.settled, sampledColors: still.sampledColors, azimuth: still.azimuth, diagnosticMs: Date.now() - started };
    evidence.outputs.push(output);
    return output;
  };
  if (args.mode === 'turntable') {
    for (const azimuth of args.turntable.split(',').map(Number)) {
      await savePng(`turntable-az${String(azimuth).padStart(3, '0')}.png`, page.evaluate(a => window.showcase.still(0, a), azimuth));
    }
  }
  evidence.diagnosticIdleFps = await page.evaluate(() => window.showcase.frameRate(2000));
  if (args.mode === 'record') {
    const mimeType = args['mime-type'] ?? ready.supportedTypes[0];
    if (!mimeType) throw new Error('no supported MediaRecorder type');
    // A wall-clock take needs the engine loop to keep up; otherwise refuse rather than ship a stutter.
    if (!(evidence.diagnosticIdleFps >= 25)) throw new Error(`engine loop at ${evidence.diagnosticIdleFps} fps; not recording`);
    const take = await page.evaluate(options => window.showcase.record(options), { mimeType, bitsPerSecond: Number(args.bitrate) });
    const file = join(args.out, `${basename(args.asset, '.ply')}-research-preview-master.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
    const parts = [];
    for (let offset = 0; offset < take.bytes; offset += 4 << 20) {
      parts.push(Buffer.from(await page.evaluate(([o, n]) => window.showcase.readRecording(o, n), [offset, 4 << 20]), 'base64'));
    }
    const video = Buffer.concat(parts);
    if (video.length !== take.bytes) throw new Error(`transferred ${video.length} of ${take.bytes} recording bytes`);
    await writeFile(file, video);
    const intervals = take.frames.slice(1).map((t, i) => (t - take.frames[i]) * 1000).sort((a, b) => a - b);
    const at = q => +intervals[Math.min(intervals.length - 1, Math.floor(q * intervals.length))].toFixed(2);
    evidence.recording = { file, bytes: video.length, sha256: await sha256File(file), mimeType: take.mimeType, requestedBitsPerSecond: Number(args.bitrate),
      method: 'canvas.captureStream() (every painted frame) + MediaRecorder; camera from demoCameraAt(wall-clock seconds) inside the PlayCanvas update loop',
      engineFrames: take.frames.length, journeySeconds: take.frames.at(-1), sortsDuringRecording: take.sortsDuringRecording,
      diagnosticFrameIntervalMs: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1), over50ms: intervals.filter(v => v > 50).length } };
  }
  if (args.mode === 'stills' || args.mode === 'record') {
    for (const seconds of args.stills.split(',').map(Number)) {
      await savePng(`still-t${String(seconds).padStart(2, '0')}s.png`, page.evaluate(t => window.showcase.still(t), seconds));
    }
  }
  evidence.pageErrorsAfter = await page.evaluate(() => window.showcase.errors);
  evidence.consoleErrors = consoleErrors;
} catch (error) {
  evidence.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await page?.close().catch(error => console.error('page close:', error.message));
  await browser?.close().catch(error => console.error('browser close:', error.message));
  await server.close();
  await writeFile(join(args.out, `evidence-${args.mode}.json`), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ out: args.out, failure: evidence.failure, adapter: evidence.page?.adapter, browser: evidence.browser,
    framing: evidence.page?.framing, recording: evidence.recording, outputs: evidence.outputs.length }, null, 2));
}
