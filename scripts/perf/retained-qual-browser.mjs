/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Browser plumbing shared by the retained qualification runners that drive Chrome
// (retained-qual-viewer.mjs, retained-qual-browser-memory.mjs): a FRESH browser process
// and profile per sample, bounded teardown, GPU identity and loss evidence, and the
// built viewer served by `vite preview` exactly as the e2e project serves it.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// Same flag sets as playwright.config.ts (`swiftshader`) and the Pop hardware recipe
// (headed Chrome on a PRIVATE Xvfb; headless loses the NVIDIA device on canvas present).
export const GPU_ARGS = {
  swiftshader: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
    '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu'],
  hardware: ['--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--use-angle=vulkan', '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist', '--enable-gpu'],
};
// tests/benchmark/gpu-health.ts DEVICE_LOSS_LOG_FORMATS (pinned by retained-qual-browser.test.mjs).
export const DEVICE_LOSS_PATTERNS = [/\[WebGPU\] Device lost:.*\(reason: [\w-]+\)/,
  /\[Renderer\] GPU device lost — halting rendering until re-init:/, /\[Viewport\] GPU device lost:/];

export const raceWithTimeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/** Largest per-site count, never the sum: one loss is printed by up to three log sites. */
export function deviceLossCount(consoleLines) {
  return Math.max(0, ...DEVICE_LOSS_PATTERNS.map(pattern => consoleLines.filter(line => pattern.test(line)).length));
}

export async function launchFresh({ gpu, channel, executable, headed, closeMs = 30000, cleanupMs = 30000, chromium: suppliedChromium }) {
  const chromium = suppliedChromium ?? (await import('@playwright/test')).chromium; // lazy: the pure helpers need no browser install
  const profileDir = mkdtempSync(join(tmpdir(), 'retained-qual-profile-'));
  const launching = Promise.resolve().then(() => chromium.launchPersistentContext(profileDir, {
    headless: !headed, ...(executable ? { executablePath: executable } : { channel }), viewport: { width: 1440, height: 900 },
    timeout: closeMs, args: GPU_ARGS[gpu] ?? GPU_ARGS.swiftshader }));
  let context, page;
  try {
    context = await raceWithTimeout(launching, closeMs, 'launch');
    page = context.pages()[0] ?? await raceWithTimeout(context.newPage(), closeMs, 'newPage');
  } catch (error) {
    // Playwright's own timeout bounds launch/process teardown. Also await late
    // resolution and closure; an unresolved cleanup is fatal to the whole run.
    try {
      await raceWithTimeout(launching.then(late => late.close()), cleanupMs, 'launch cleanup');
      rmSync(profileDir, { recursive: true, force: true });
    } catch (cleanupError) {
      if (cleanupError === error) rmSync(profileDir, { recursive: true, force: true });
      else {
        error.cleanupFailed = true;
        error.message += `; browser cleanup failed: ${cleanupError}`;
        // Keep ownership of a late browser even after the fatal result.
        void launching.then(async late => {
          await late.close(); rmSync(profileDir, { recursive: true, force: true });
        }).catch(e => console.error('late browser cleanup:', e));
      }
    }
    throw error;
  }
  const consoleLines = [], requests = [], pageErrors = [];
  page.on('console', message => consoleLines.push(message.text()));
  page.on('pageerror', error => pageErrors.push(String(error)));
  context.on('request', request => requests.push(request.url()));
  return { profileDir, context, page, consoleLines, requests, pageErrors,
    async close() {
      let error = null;
      try { await raceWithTimeout(context.close(), closeMs, 'context.close()'); } catch (e) { error = String(e); }
      rmSync(profileDir, { recursive: true, force: true });
      return error;
    } };
}

/** `navigator.gpu` adapter identity; software rasterisers are named, never hidden. */
export function gpuIdentity(page) {
  return page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const info = adapter.info ?? {};
    return { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '', description: info.description ?? '',
      fallback: adapter.isFallbackAdapter ?? info.isFallbackAdapter ?? null };
  });
}
export const isSoftwareAdapter = adapter => !adapter || adapter.fallback === true || /swiftshader|software|llvmpipe/i.test(JSON.stringify(adapter));

/** Aggregate browser memory including Workers; null with a reason where the API is unavailable. */
export function userAgentMemory(page) {
  return page.evaluate(async () => {
    if (!globalThis.crossOriginIsolated) return { bytes: null, reason: 'page is not cross-origin isolated' };
    if (!performance.measureUserAgentSpecificMemory) return { bytes: null, reason: 'measureUserAgentSpecificMemory unavailable' };
    try {
      const m = await performance.measureUserAgentSpecificMemory();
      const owners = url => m.breakdown.filter(e => e.attribution.some(o => o.url?.includes(url))).reduce((s, e) => s + e.bytes, 0);
      return { bytes: m.bytes, smlibWorkerBytes: owners('/smlib/') || null, retainedWorkerBytes: owners('retained') || null,
        note: 'aggregate, worker-inclusive; not an isolated SDK linear heap' };
    } catch (error) { return { bytes: null, reason: String(error) }; }
  });
}

/** Deterministic digest of a built tree (sorted `path size sha256`), the served-artifact identity. */
export function treeDigest(root) {
  const lines = [];
  const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) lines.push(`${relative(root, path)} ${statSync(path).size} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
  } };
  walk(root);
  return { files: lines.length, sha256: createHash('sha256').update(lines.join('\n')).digest('hex') };
}

/** `vite preview` of an arm's e2e build with the staged engine, as playwright.config.ts starts it. */
export async function startPreview(arm, port, { ready = 90000 } = {}) {
  const cwd = join(arm.checkout, 'apps/viewer');
  const child = spawn(join(cwd, 'node_modules/.bin/vite'), ['preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd, env: { ...process.env, BROWSER: 'none', VITE_RETAINED_GEOMETRY: 'on', IFCLITE_RETAINED_ENGINE: arm.engine }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', c => { log += c; }); child.stderr.on('data', c => { log += c; });
  let spawnError = null;
  const exited = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', code => resolve(code));
  });
  const stop = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try { await raceWithTimeout(exited, 5000, 'preview stop'); }
    catch {
      child.kill('SIGKILL');
      await raceWithTimeout(exited, 5000, 'preview SIGKILL');
    }
  };
  const origin = `http://127.0.0.1:${port}`, deadline = Date.now() + ready;
  try {
    for (;;) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`vite preview exited (${child.exitCode}): ${log.slice(-800)}`);
      try { if ((await fetch(`${origin}/`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* not listening yet */ }
      if (spawnError) throw spawnError;
      if (Date.now() > deadline) throw new Error(`vite preview not ready: ${log.slice(-800)}`);
      await new Promise(r => setTimeout(r, 25));
    }
    return { origin, stop };
  } catch (error) { await stop(); throw error; }
}

/** The engine manifest the preview actually serves, hashed byte for byte. */
export async function servedManifestSha256(origin) {
  const response = await fetch(`${origin}/retained-engine/engine-manifest.json`);
  if (!response.ok) return null;
  return createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
}

/** Start both arms transactionally: a failed second preview owns first-arm cleanup. */
export async function startPreviews(arms, port, start = startPreview) {
  const previews = new Map();
  try {
    for (const [i, arm] of arms.entries()) previews.set(arm.side, await start(arm, port + i));
    return previews;
  } catch (error) {
    await Promise.all([...previews.values()].map(preview => preview.stop()));
    throw error;
  }
}
