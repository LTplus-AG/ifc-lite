/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 integrated-viewer recorder. Explicit manual tool, not a CI gate.
// Drives a running ifc-lite viewer build in ifc-gpu-check's hardware Chrome and
// records the whole page (UI + WebGPU canvas) with a CDP screencast on
// wall-clock timestamps. Input is real: the capture enters the viewer's own
// file input, and the camera moves by mouse and wheel events.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { verifiedFixture } from './showcase-fixture.mjs';
import { intervalStats, screencastConcat } from './screencast-timing.mjs';

const { values: args } = parseArgs({ options: {
  'viewer-url': { type: 'string' }, query: { type: 'string', default: '' }, asset: { type: 'string' }, assets: { type: 'string' },
  out: { type: 'string' }, journey: { type: 'string', default: new URL('./integrated-journey.mjs', import.meta.url).pathname },
  'journey-options': { type: 'string', default: '{}' }, 'init-storage': { type: 'string', default: '{}' },
  'viewer-commit': { type: 'string', default: 'unknown' }, 'viewer-build': { type: 'string', default: '' },
  quality: { type: 'string', default: '90' },
} });
for (const key of ['viewer-url', 'asset', 'assets', 'out']) if (!args[key]) throw new Error(`--${key} required`);
if (!isAbsolute(args.out)) throw new Error('--out must be absolute');
const cdpUrl = process.env.IFC_GPU_CDP_URL;
if (!cdpUrl) throw new Error('IFC_GPU_CDP_URL is not set: run under ~/build-workers/ifc-gpu-check for a hardware Chrome');

const { entry, localPath } = await verifiedFixture(args.asset, resolve(args.assets));
// Windows Chrome reads the exact local bytes through the WSL share.
const windowsPath = execFileSync('wslpath', ['-w', localPath], { encoding: 'utf8' }).trim();
const framesDir = join(args.out, 'frames');
await mkdir(framesDir, { recursive: true });
const initStorage = JSON.parse(args['init-storage']);
const evidence = { issue: 8567, date: new Date().toISOString(), host: hostname(), timeline: [], skipped: [], initStorage,
  viewer: { url: args['viewer-url'], query: args.query, commit: args['viewer-commit'], build: args['viewer-build'] },
  asset: { path: entry.path, bytes: entry.size, sha256: entry.sha256, localSha256Verified: true, windowsPath } };
const frames = [];
let browser, page, cdp;
try {
  browser = await chromium.connectOverCDP(cdpUrl);
  evidence.browser = browser.version();
  page = await (browser.contexts()[0] ?? await browser.newContext()).newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors = [];
  page.on('pageerror', e => errors.length < 30 && errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.length < 30 && errors.push(m.text()));
  // User preferences only (e.g. theme), set before the app boots; never app state.
  await page.addInitScript(pairs => { for (const [k, v] of Object.entries(pairs)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); }, initStorage);
  await page.goto(`${args['viewer-url']}${args.query ? `?${args.query}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  evidence.adapter = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, fallback: a.isFallbackAdapter ?? a.info?.isFallbackAdapter ?? null } : null;
  });
  if (!evidence.adapter || evidence.adapter.fallback !== false || /swiftshader/i.test(evidence.adapter.architecture ?? '')) {
    throw new Error(`refusing non-hardware adapter ${JSON.stringify(evidence.adapter)}`);
  }
  cdp = await page.context().newCDPSession(page);
  let writing = Promise.resolve();
  evidence.sameInstantFramesReplaced = 0;
  cdp.on('Page.screencastFrame', frame => {
    const ts = frame.metadata.timestamp;
    // Two deliveries can share one swap instant; the newer image takes that instant
    // rather than inventing a zero-length or shifted frame.
    const sameInstant = frames.length > 0 && ts <= frames.at(-1).ts;
    if (sameInstant) evidence.sameInstantFramesReplaced++;
    else frames.push({ n: frames.length + 1, ts });
    const n = frames.at(-1).n;
    writing = writing.then(() => writeFile(join(framesDir, `${String(n).padStart(6, '0')}.jpg`), Buffer.from(frame.data, 'base64')))
      .then(() => cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {}));
  });
  const clock = () => (frames.length ? Date.now() / 1000 - frames[0].ts : 0);
  const ctx = {
    page, asset: args.asset, options: JSON.parse(args['journey-options']),
    hold: ms => page.waitForTimeout(ms),
    skip: (step, reason) => evidence.skipped.push({ step, reason }),
    async step(name, caption, fn) {
      const start = clock();
      try { return await fn(); } finally { evidence.timeline.push({ name, caption, start: +start.toFixed(3), end: +clock().toFixed(3) }); }
    },
    async uploadToInput(selector) {
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`no file input ${selector}`);
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [windowsPath] });
    },
    // Eased real input, paced by wall-clock time because CDP round trips vary.
    async drag(from, to, ms) {
      await page.mouse.move(...from); await page.mouse.down();
      for (let t = 0, start = Date.now(); t < 1;) {
        t = Math.min(1, (Date.now() - start) / ms);
        const e = t * t * (3 - 2 * t);
        await page.mouse.move(from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e);
      }
      await page.mouse.up();
    },
    async wheel(at, deltaY, ms) {
      await page.mouse.move(...at);
      for (let t = 0, sent = 0, start = Date.now(); t < 1;) {
        t = Math.min(1, (Date.now() - start) / ms);
        const target = deltaY * t * t * (3 - 2 * t);
        await page.mouse.wheel(0, target - sent); sent = target;
        await page.waitForTimeout(16);
      }
    },
  };
  const journey = await import(pathToFileURL(resolve(args.journey)).href);
  await journey.prepare(ctx);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: Number(args.quality), maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await page.waitForTimeout(400);
  await journey.journey(ctx);
  await cdp.send('Page.stopScreencast');
  await writing;
  evidence.errors = errors;
} catch (error) {
  evidence.failure = error.stack ?? String(error); process.exitCode = 1;
  await page?.screenshot({ path: join(args.out, 'failure.png') }).catch(() => {});
} finally {
  await cdp?.send('Page.stopScreencast').catch(() => {});
  evidence.frames = frames.length;
  try {
    if (frames.length > 1) {
      await writeFile(join(args.out, 'frames.ffconcat'), screencastConcat(frames));
      evidence.screencast = intervalStats(frames);
    }
  } catch (error) {
    evidence.failure ??= error.stack ?? String(error); process.exitCode = 1;
  }
  await writeFile(join(args.out, 'evidence-integrated.json'), JSON.stringify(evidence, null, 2) + '\n');
  await page?.close().catch(error => console.error('page close:', error.message));
  await browser?.close().catch(error => console.error('browser close:', error.message));
  console.log(JSON.stringify({ failure: evidence.failure, adapter: evidence.adapter, screencast: evidence.screencast, skipped: evidence.skipped, timeline: evidence.timeline }, null, 1));
}
