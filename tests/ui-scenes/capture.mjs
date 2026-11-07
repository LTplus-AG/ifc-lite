#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capture the UI overhaul scene set (#8802) on a real GPU.
 *
 *   node tests/ui-scenes/capture.mjs --dist <built viewer dist> --out <dir>
 *     [--label <name>] [--scenes a,b] [--themes light,dark] [--cdp <url>]
 *
 * Serves `--dist` with `vite preview` (so the production COOP/COEP headers
 * apply), drives a browser over CDP, and writes `<scene>.<theme>.png` plus a
 * `manifest.json` (scene, theme, viewport, sha256, failures) to `--out`.
 *
 * WHY CDP: in WSL, Playwright's bundled Chromium only gets SwiftShader, so
 * the WebGPU model canvas is empty in its screenshots. Without `--cdp` this
 * launches a fresh headless Windows Chrome on a random port with a throwaway
 * profile and removes both afterwards (the profile caches model geometry).
 *
 * DETERMINISM: fixed viewport and DPR 1, a fixed start date, animations and
 * transitions disabled, caret hidden, toasts dismissed, camera re-homed after
 * the scene's own steps, then a settle wait. Repeat captures of one build are
 * then pixel-identical except measured timings ("Parse time 11 ms", seconds of "Loaded at").
 * A scene that throws is recorded as a failure in the manifest and the run
 * exits non-zero: a missing screenshot must never read as "no change".
 *
 * @unwired-by-design needs a real GPU and Windows Chrome; run by the council loop, not CI.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { SCENES } from './scenes.mjs';
import { startOwnedPreview } from './capture-preview.mjs';

const ROOT = process.env.IFC_CAPTURE_CHECKOUT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WIN_CHROME = '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';

function parseArgs(argv) {
  const args = { themes: ['light', 'dark'], scenes: null, label: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${key} needs a value`);
      return v;
    };
    if (key === '--dist') args.dist = resolve(value());
    else if (key === '--out') args.out = resolve(value());
    else if (key === '--label') args.label = value();
    // De-duplicated, so a repeated id is neither captured twice nor mistaken for an unknown one.
    else if (key === '--scenes') args.scenes = [...new Set(value().split(','))];
    else if (key === '--themes') args.themes = [...new Set(value().split(','))];
    else if (key === '--cdp') args.cdp = value();
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.dist || !args.out) throw new Error('usage: capture.mjs --dist <dir> --out <dir> [--scenes a,b] [--themes light,dark] [--cdp url]');
  for (const theme of args.themes) {
    if (!['light', 'dark'].includes(theme)) throw new Error(`invalid theme ${JSON.stringify(theme)}; expected light or dark`);
  }
  for (const id of args.scenes ?? []) {
    if (!SCENES.some((scene) => scene.id === id)) throw new Error(`unknown scene ${JSON.stringify(id)}`);
  }
  return args;
}

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

async function waitForHttp(url, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ''}`, { cause: lastError });
}

async function launchWindowsChrome(signal) {
  if (!existsSync(WIN_CHROME)) throw new Error(`Windows Chrome not found at ${WIN_CHROME}; pass --cdp <url> instead`);
  const port = randomPort();
  const profile = `ifclite-ui-scenes-${process.pid}-${port}`;
  let winProfile; let wslProfile;
  try {
    const temp = execFileSync('powershell.exe', ['-NoProfile', '-Command', '[IO.Path]::GetTempPath()'], { encoding: 'utf8' }).trim();
    if (!temp) throw new Error('Windows temp path is empty');
    winProfile = `${temp.replace(/[\\/]+$/, '')}\\${profile}`;
    wslProfile = execFileSync('wslpath', ['-u', winProfile], { encoding: 'utf8' }).trim();
    if (!wslProfile.startsWith('/')) throw new Error('wslpath did not return an absolute path');
  } catch (error) {
    throw new Error(`cannot resolve Windows temp directory: ${error.message}`, { cause: error });
  }
  const child = spawn(WIN_CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${winProfile}`,
    '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore', detached: true });
  const cdp = `http://127.0.0.1:${port}`;
  const chrome = {
    cdp,
    async close() {
      try { process.kill(-child.pid); } catch (error) { if (error.code !== 'ESRCH') console.warn(`chrome kill: ${error.message}`); }
      // Windows Chrome outlives the WSL interop process; kill it by its profile path.
      await new Promise((r) => spawn('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
        { stdio: 'ignore' }).on('exit', r).on('error', (error) => { console.warn(`chrome cleanup: ${error.message}`); r(); }));
      await rm(wslProfile, { recursive: true, force: true }).catch((error) => console.warn(`profile cleanup: ${error.message}`));
    },
  };
  let launchError;
  child.on('error', (error) => { launchError = error; });
  try {
    await waitForHttp(`${cdp}/json/version`, 30000, signal);
    if (launchError) throw launchError;
    return chrome;
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

const FREEZE_CSS = `*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }`;

async function settle(page, ms = 700) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(ms);
}

async function waitForModelReady(page) {
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size >= 1 && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0);
  }, undefined, { timeout: 180000 });
}

async function dismissToasts(page) {
  for (const button of await page.getByRole('button', { name: 'Dismiss notification' }).all()) {
    await button.click({ timeout: 2000 }).catch((error) => console.warn(`dismiss toast: ${error.message}`));
  }
}

/**
 * Objective layout numbers the council's hard constraints are judged on:
 * `modelVisibleFraction` is the share of a 64x40 probe grid whose topmost
 * element is the WebGPU canvas (chrome covering the model lowers it), and
 * `minFontPx` / `smallTextShare` cover visible text nodes.
 */
async function measureLayout(page) {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const main = canvases.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? null;
    const cols = 64; const rows = 40;
    let onCanvas = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const hit = document.elementFromPoint((c + 0.5) * innerWidth / cols, (r + 0.5) * innerHeight / rows);
        if (main && hit === main) onCanvas++;
      }
    }
    let minFontPx = Infinity; let small = 0; let total = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !node.textContent.trim()) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const size = parseFloat(style.fontSize);
      total++;
      if (size < 11) small++;
      minFontPx = Math.min(minFontPx, size);
    }
    return {
      modelVisibleFraction: Math.round((onCanvas / (cols * rows)) * 1000) / 1000,
      minFontPx: Number.isFinite(minFontPx) ? minFontPx : null,
      smallTextShare: total ? Math.round((small / total) * 1000) / 1000 : 0,
      visibleTextNodes: total,
    };
  });
}

async function captureScene(context, baseUrl, scene, theme, outDir) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)));
  try {
    await page.setViewportSize(scene.viewport);
    // Start the wall clock at a fixed date so "Loaded at" text matches across captures to the
    // second or so. It must keep flowing: setFixedTime freezes the Date.now-driven camera tweens.
    await page.clock.setSystemTime(new Date('2026-01-15T10:00:00Z'));
    await page.addInitScript(({ theme, css, firstRun }) => {
      localStorage.setItem('ifc-lite-theme', theme);
      localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'ui-scenes');
      // The tour invite is part of the first-run scene only; elsewhere it would cover the panels.
      if (!firstRun) localStorage.setItem('ifc-lite:tours:v1', JSON.stringify({ inviteDismissedAt: '2026-01-01T00:00:00.000Z', tours: {} }));
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      });
    }, { theme, css: FREEZE_CSS, firstRun: Boolean(scene.firstRun) });
    await page.goto(scene.model ? `${baseUrl}/?model=${scene.model}` : `${baseUrl}/`);
    await page.waitForFunction(() => !!globalThis.__ifc_lite_viewer_store__, undefined, { timeout: 120000 });
    if (scene.model) {
      await waitForModelReady(page);
      await settle(page, 300);
      // Through the store, not a "Home" button: a redesign may rename or move it.
      await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.home?.());
    }
    await dismissToasts(page);
    await scene.run({ page });
    await settle(page);
    // A panel the scene opened resizes the canvas; re-home so the camera fits the final layout
    // instead of being caught mid-refit.
    if (scene.model) {
      await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.home?.());
      await settle(page, 1200);
    }
    await dismissToasts(page);
    await settle(page, 200);
    const metrics = await measureLayout(page);
    const file = `${scene.id}.${theme}.png`;
    const png = await page.screenshot({ path: join(outDir, file) });
    return { scene: scene.id, title: scene.title, theme, viewport: scene.viewport, file,
      sha256: createHash('sha256').update(png).digest('hex'), metrics, pageErrors: errors };
  } catch (error) {
    // Preserve the failed UI, not just a timeout. These are diagnostics, never
    // successful scene results; scene steps and readiness limits stay frozen.
    if (!page.isClosed()) {
      try {
        await page.screenshot({ path: join(outDir, `${scene.id}.${theme}.failed.png`), timeout: 5000 });
        await writeFile(join(outDir, `${scene.id}.${theme}.failure.json`), JSON.stringify({
          error: String(error), pageErrors: errors,
          uiText: (await page.locator('body').innerText({ timeout: 5000 })).slice(0, 16000),
        }, null, 2) + '\n');
      } catch (diagnosticError) { console.warn(`Failure diagnostics: ${diagnosticError}`); }
    }
    throw error;
  } finally {
    await page.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenes = args.scenes ? SCENES.filter((s) => args.scenes.includes(s.id)) : SCENES;
  await mkdir(args.out, { recursive: true });

  const controller = new AbortController();
  let preview; let chrome; let browser;
  const contexts = new Set();
  const onSignal = signal => {
    controller.abort(new Error(`Capture interrupted: ${signal}`));
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    // Closing owned contexts interrupts pending navigation without closing a
    // helper-managed browser. The normal finally block awaits all cleanup.
    for (const context of contexts) context.close().catch(error => console.warn(`Context interruption: ${error}`));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const results = [];
  const failures = [];
  let cleanupErrors = [];
  try {
    preview = await startOwnedPreview({ root: ROOT, dist: args.dist, signal: controller.signal });
    chrome = args.cdp ? null : await launchWindowsChrome(controller.signal);
    controller.signal.throwIfAborted();
    browser = await chromium.connectOverCDP(args.cdp ?? chrome.cdp);
    controller.signal.throwIfAborted();
    const probeContext = await browser.newContext();
    contexts.add(probeContext);
    const adapter = await probeContext.newPage().then(async (p) => {
      // navigator.gpu only exists in a secure context, which about:blank is not.
      await p.goto(`${preview.url}/favicon.ico`).catch(() => p.goto(preview.url));
      const info = await p.evaluate(async () => {
        const a = await navigator.gpu?.requestAdapter();
        return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description } : null;
      });
      await probeContext.close();
      contexts.delete(probeContext);
      return info;
    });
    if (!adapter) throw new Error('no WebGPU adapter in the capture browser; screenshots would have an empty model canvas');
    for (const scene of scenes) {
      for (const theme of args.themes) {
        preview.assertAlive();
        const context = await browser.newContext({ viewport: scene.viewport, deviceScaleFactor: 1 });
        contexts.add(context);
        try {
          preview.assertAlive();
          results.push(await captureScene(context, preview.url, scene, theme, args.out));
          preview.assertAlive();
          console.log(`ok   ${scene.id}.${theme}`);
        } catch (error) {
          failures.push({ scene: scene.id, theme, error: String(error).slice(0, 2000) });
          console.log(`FAIL ${scene.id}.${theme}: ${String(error).split('\n')[0]}`);
        } finally {
          await context.close();
          contexts.delete(context);
        }
      }
    }
    preview.assertAlive();
    await browser.close();
    browser = null;
    const dist = await readFile(join(args.dist, 'index.html'));
    await writeFile(join(args.out, 'manifest.json'), `${JSON.stringify({
      version: 1, label: args.label, capturedAt: new Date().toISOString(),
      distIndexSha256: createHash('sha256').update(dist).digest('hex'), preview: preview.identity, adapter, results, failures,
    }, null, 2)}\n`);
  } finally {
    // All resources are scoped to this run. CDP close disconnects only;
    // contexts are closed explicitly, and only our preview group is signalled.
    const cleanup = await Promise.allSettled([
      ...[...contexts].map(context => context.close()),
      browser?.close(), preview?.close(), chrome?.close(),
    ]);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    cleanupErrors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    for (const error of cleanupErrors) console.error('Capture cleanup:', error);
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Capture cleanup failed');
  console.log(`${results.length} captured, ${failures.length} failed -> ${args.out}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
