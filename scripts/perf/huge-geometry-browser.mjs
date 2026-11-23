/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser plumbing of the huge-geometry harness (scripts/perf/huge-geometry.md):
 * one fresh Chrome process and profile per run on the host's real GPU,
 * process memory sampling, and failure evidence (crash, device loss, store
 * error, timeout).
 *
 * GPU: chrome-headless-shell (Playwright's bundled one) with Vulkan, the
 * launch `ifc-gpu-check --probe` proves on Pop, plus the high-performance
 * adapter pin. Do not force the NVIDIA Vulkan ICD (VK_ICD_FILENAMES): its
 * GLX-backed library fails headless and Chrome silently falls back to
 * SwiftShader. Any software adapter (SwiftShader, llvmpipe, fallback) fails
 * the run up front: such numbers do not count.
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromePids, vramOf } from './scenoptic-bench-sampling.mjs';
import { DEVICE_LOSS_PATTERNS, isSoftwareAdapter } from './retained-qual-browser.mjs';
import { DIALOG_MARKS, NOTICES, PAGE_PROBE } from './oom-load-probe-page.mjs';
import { DIALOG_BUTTONS, MEMORY_WARNING } from './oom-load-probe-lib.mjs';
import { COUNT_FRAMES, openAndWaitInteractive, openViewerPage } from './viewer-load-probe.mjs';
import { HARNESS_INIT } from './huge-geometry-page.mjs';

export const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export const VIEWPORT = Object.freeze({ width: 1600, height: 900 });
/** `ifc-gpu-check`'s Pop launch (IFC_GPU_CHROME_ARGS) plus the high-performance adapter pin. */
export const DEFAULT_GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-features=Vulkan', '--use-angle=vulkan'];

export function loadPlaywright() {
  return createRequire(join(ROOT, 'package.json'))('@playwright/test');
}

export function gpuArgs() {
  const fromHelper = (process.env.IFC_GPU_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);
  return [...(fromHelper.length ? fromHelper : DEFAULT_GPU_ARGS), '--use-webgpu-power-preference=default-high-performance',
    '--no-first-run', '--hide-scrollbars', '--enable-precise-memory-info'];
}

/**
 * `HUGE_GEOMETRY_GLOBALS="__IFC_LITE_X=1,__IFC_LITE_Y=0"` sets viewer perf
 * globals before boot, so one build can A/B a runtime flag (spike lanes).
 * Only `__IFC_LITE_*` names with numeric values are accepted.
 */
export function pageGlobalsInit(raw = process.env.HUGE_GEOMETRY_GLOBALS ?? '') {
  const pairs = raw.split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('='));
  for (const [k, v] of pairs) if (!/^__IFC_LITE_[A-Z0-9_]+$/.test(k ?? '') || !/^-?\d+(\.\d+)?$/.test(v ?? '')) throw new Error(`bad HUGE_GEOMETRY_GLOBALS entry ${k}=${v}`);
  return pairs.length ? [pairs.map(([k, v]) => `globalThis.${k} = ${Number(v)};`).join('\n')] : [];
}

/** Launch a fresh persistent profile; returns `{ context, page, profileDir, events, close }`. */
export async function launchGpu({ viewport = VIEWPORT, extraInit = [] } = {}) {
  const { chromium } = loadPlaywright();
  const profileDir = mkdtempSync(join(tmpdir(), 'huge-geometry-profile-'));
  // On the PC, ifc-gpu-check starts Windows Chrome on the real GPU and exports IFC_GPU_CDP_URL: attach to it
  // (a fresh context per run). Per-process memory sampling is Linux-only and stays empty there.
  const cdpUrl = process.env.IFC_GPU_CDP_URL;
  const browser = cdpUrl ? await chromium.connectOverCDP(cdpUrl) : null;
  const context = browser
    ? await browser.newContext({ viewport })
    : await chromium.launchPersistentContext(profileDir, { headless: true, viewport, args: gpuArgs(), timeout: 60000 });
  for (const script of [COUNT_FRAMES, DIALOG_MARKS, HARNESS_INIT, ...pageGlobalsInit(), ...extraInit]) await context.addInitScript(script);
  const page = context.pages()[0] ?? await context.newPage();
  const events = { console: [], pageErrors: [], crashed: false, closed: false };
  page.on('console', (m) => { if (events.console.length < 5000) events.console.push(`[${m.type()}] ${m.text().slice(0, 600)}`); });
  page.on('pageerror', (e) => events.pageErrors.push(String(e).slice(0, 2000)));
  page.on('crash', () => { events.crashed = true; });
  page.on('close', () => { events.closed = true; });
  return { context, page, profileDir, events, version: (browser ?? context.browser())?.version() ?? null, windowsPaths: Boolean(cdpUrl),
    async close() {
      try { await Promise.race([context.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('close timeout')), 30000))]); }
      catch (err) { console.warn(`huge-geometry: browser close: ${err.message}`); }
      // A CDP-attached browser stays up for the next run: close() only disconnects it, which lets node exit.
      if (browser) { try { await browser.close(); } catch (err) { console.warn(`huge-geometry: CDP disconnect: ${err.message}`); } }
      rmSync(profileDir, { recursive: true, force: true });
    } };
}

/** The profile's browser process(es) plus every descendant (headless children do not name the profile). */
export function chromeTree(profileDir) {
  const roots = new Set(chromePids(profileDir));
  if (!roots.size) return [];
  const parent = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try { parent.set(Number(entry), Number(readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ')[1].split(' ')[1])); }
    catch { /* exited between readdir and read */ }
  }
  const tree = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of parent) if (!tree.has(pid) && tree.has(ppid)) { tree.add(pid); grew = true; }
  }
  return [...tree];
}

const processType = (pid) => {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const t = /--type=([\w-]+)/.exec(cmd)?.[1] ?? 'browser';
    return t === 'utility' ? 'utility' : t;
  } catch { return null; }
};
const pssOf = (pid) => {
  try { return Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0) / 1024; }
  catch { return 0; }
};

/**
 * Sample PSS per Chrome process type, the main thread's JS heap (CDP) and,
 * every `vramEveryMs`, NVIDIA VRAM of the profile's processes. `stop()`
 * returns peaks and the last sample.
 */
export function startSampler(profileDir, cdp, { intervalMs = 250, vramEveryMs = 2000 } = {}) {
  const peak = { totalPssMiB: 0, rendererPssMiB: 0, gpuPssMiB: 0, jsHeapMiB: 0, vramMiB: 0 };
  let last = null, pids = [], scanned = 0, vramAt = 0, busy = false, samples = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (Date.now() - scanned > 1000) { pids = chromeTree(profileDir); scanned = Date.now(); }
      const by = {};
      for (const pid of pids) { const t = processType(pid); if (t) by[t] = (by[t] ?? 0) + pssOf(pid); }
      const total = Object.values(by).reduce((a, b) => a + b, 0);
      let jsHeapMiB = last?.jsHeapMiB ?? null;
      try {
        const m = await Promise.race([cdp.send('Performance.getMetrics'), new Promise((r) => setTimeout(() => r(null), 1500))]);
        const v = m?.metrics?.find((x) => x.name === 'JSHeapUsedSize')?.value;
        if (Number.isFinite(v)) jsHeapMiB = v / 2 ** 20;
      } catch { jsHeapMiB = last?.jsHeapMiB ?? null; /* page busy or gone: keep the previous value */ }
      let vramMiB = last?.vramMiB ?? null;
      if (Date.now() - vramAt > vramEveryMs) { vramAt = Date.now(); vramMiB = vramOf(pids); }
      last = { t: Date.now(), totalPssMiB: total, rendererPssMiB: by.renderer ?? 0, gpuPssMiB: by['gpu-process'] ?? 0, jsHeapMiB, vramMiB, byType: by };
      for (const k of Object.keys(peak)) if (Number.isFinite(last[k])) peak[k] = Math.max(peak[k], last[k]);
      samples++;
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  void tick();
  return { peek: () => last, async stop() { clearInterval(timer); await tick(); return { peak, last, samples }; } };
}

/** Classify a failed load from its evidence. Order matters: the most specific symptom wins. */
export function classifyFailure({ crashed, deviceLost, storeError, pageErrors, timedOut, console: lines }) {
  const text = [storeError ?? '', ...(pageErrors ?? []), ...(lines ?? []).filter((l) => l.startsWith('[error]'))].join('\n');
  if (crashed) return { kind: 'renderer-crash', detail: 'page crashed (tab killed: OOM or renderer fault)' };
  if (deviceLost) return { kind: 'device-lost', detail: deviceLost };
  if (/out of memory|memory access out of bounds|Array buffer allocation failed|WebAssembly\.Memory|could not allocate memory|RangeError: Invalid array length|Invalid typed array length/i.test(text)) {
    return { kind: 'out-of-memory', detail: text.split('\n').find((l) => /memory|allocation|Invalid (typed )?array length/i.test(l))?.slice(0, 600) ?? text.slice(0, 600) };
  }
  if (storeError) return { kind: 'load-error', detail: String(storeError).slice(0, 600) };
  if (timedOut) return { kind: 'timeout', detail: timedOut };
  if (pageErrors?.length) return { kind: 'page-error', detail: pageErrors[0].slice(0, 600) };
  return { kind: 'unknown', detail: 'load did not complete' };
}

const deviceLossLine = (lines) => lines.find((l) => DEVICE_LOSS_PATTERNS.some((re) => re.test(l))) ?? null;

/**
 * Open the viewer, verify a hardware adapter, load `files` through the
 * canonical file input (`useIfcLoader.loadFile`) and wait until fully
 * interactive, or fail with evidence. A pre-load memory warning is answered
 * with "Continue loading" so the ladder reaches the real failure point.
 * `url` replaces the default `${baseUrl}/?perfTrace=1` (a viewer elsewhere, or extra query flags).
 */
export async function loadModel(session, baseUrl, files, { timeoutMs, url = null }) {
  const { page, context, events } = session;
  await openViewerPage(context, url ?? `${baseUrl}/?perfTrace=1`);
  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return null;
    const i = a.info ?? {};
    return { vendor: i.vendor ?? '', architecture: i.architecture ?? '', description: i.description ?? '', fallback: a.isFallbackAdapter ?? i.isFallbackAdapter ?? null };
  });
  if (isSoftwareAdapter(adapter)) throw Object.assign(new Error(`software or missing WebGPU adapter: ${JSON.stringify(adapter)}`), { fatal: true });
  const started = Date.now();
  let settled = false, continued = 0;
  // Windows Chrome (PC, CDP) reads uploads by Windows path, and Playwright stats paths on the Node
  // side, so set the converted paths on the input straight through CDP.
  let target = page;
  if (session.windowsPaths) {
    const winFiles = files.map((f) => execFileSync('wslpath', ['-w', f], { encoding: 'utf8' }).trim());
    const cdp = await context.newCDPSession(page);
    target = { evaluate: page.evaluate.bind(page), waitForFunction: page.waitForFunction.bind(page),
      locator: (selector) => ({ setInputFiles: async () => {
        const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
        await cdp.send('DOM.setFileInputFiles', { files: winFiles, objectId: result.objectId });
      } }) };
  }
  const loading = openAndWaitInteractive(target, files, { timeoutMs }).then((v) => { settled = true; return { ok: true, value: v }; },
    (err) => { settled = true; return { ok: false, error: err }; });
  const watchdog = (async () => {
    while (!settled) {
      await new Promise((r) => setTimeout(r, 1000));
      if (settled) return null;
      if (events.crashed || events.closed) return { ok: false, crashed: true };
      const lost = deviceLossLine(events.console);
      if (lost) return { ok: false, deviceLost: lost };
      let snap = null;
      try { snap = await Promise.race([page.evaluate(PAGE_PROBE), new Promise((r) => setTimeout(() => r(null), 5000))]); }
      catch (err) { if (events.crashed || events.closed) return { ok: false, crashed: true }; console.warn(`huge-geometry: probe: ${err.message}`); }
      if (snap?.error) return { ok: false, storeError: snap.error, snap };
      if (snap) session.lastSnap = snap;
      const dialog = page.locator('[role=dialog],[role=alertdialog]').filter({ hasText: MEMORY_WARNING });
      // Bounded: on a starved page an unbounded locator call held this loop (and the timeout below) for 30+ minutes.
      if (await Promise.race([dialog.count().catch(() => 0), new Promise((r) => setTimeout(() => r(0), 5000))])) {
        await dialog.first().locator('button').filter({ hasText: DIALOG_BUTTONS.continue }).first().click({ timeout: 10000 })
          .catch((err) => console.warn(`huge-geometry: memory dialog: ${err.message}`));
        continued++;
      }
      if (Date.now() - started > timeoutMs) return { ok: false, timedOut: `not interactive after ${Math.round(timeoutMs / 1000)} s; open spans: ${(session.lastSnap?.openSpans ?? []).join(', ')}` };
    }
    return null;
  })();
  const first = await Promise.race([loading, watchdog.then((w) => w ?? loading)]);
  const out = { adapter, memoryDialogContinued: continued, wallMs: Date.now() - started };
  if (first.ok) return { ...out, ok: true, timings: first.value };
  const notices = await page.evaluate(NOTICES).catch(() => []);
  const failure = classifyFailure({ crashed: first.crashed || events.crashed, deviceLost: first.deviceLost ?? deviceLossLine(events.console),
    storeError: first.storeError, pageErrors: events.pageErrors, timedOut: first.timedOut ?? (first.error ? String(first.error.message ?? first.error).slice(0, 600) : null),
    console: events.console });
  return { ...out, ok: false, failure, notices, lastSnap: session.lastSnap ?? null };
}
