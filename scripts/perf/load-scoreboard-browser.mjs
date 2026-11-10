/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser lanes of `load-scoreboard.mjs`. One sample = one fresh Chrome
 * process with an empty profile: the cold open (empty IndexedDB), then
 * `warmOpens` reopens in a new page of the same browser (IndexedDB filled).
 * The first reopen streams the cache hit and writes the scene snapshot; the
 * last one is the steady-state warm open the `browser-warm` lane reports.
 *
 * Launch matches `scenoptic-bench.mjs` (headed on a private Xvfb, NVIDIA
 * Vulkan ICD only, because headless Chrome on Pop loses the WebGPU device),
 * plus `--use-webgpu-power-preference=default-high-performance` so the
 * default adapter cannot flip to the Intel iGPU (#8787). The adapter the
 * renderer actually used is recorded per sample.
 *
 * Peak memory: the largest sum of PSS over the profile's Chrome processes,
 * sampled every 250 ms from the input event to readiness (includes the
 * browser's own baseline; PSS does not double-count shared pages). Per-process
 * VmHWM is kept beside it as the OS high-water witness for short peaks.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromePids, memoryOf, vramOf } from './scenoptic-bench-sampling.mjs';
import { COUNT_FRAMES, openAndWaitInteractive, openViewerPage, readOutputFingerprint, replacePage, waitCacheWrites, waitSceneSnapshots } from './viewer-load-probe.mjs';
import { browserShares, browserStages, stageShares } from './load-scoreboard-stats.mjs';
import { readGpuHealth } from '../../tests/benchmark/gpu-health.ts';

export const CHROME_ARGS = ['--enable-gpu', '--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
  '--use-angle=vulkan', '--ignore-gpu-blocklist', '--use-webgpu-power-preference=default-high-performance',
  '--hide-scrollbars', '--no-first-run', '--window-size=1920,1080', '--window-position=0,0'];
const NVIDIA_ICD = '/usr/share/vulkan/icd.d/nvidia_icd.json';

export function loadPlaywright(root) {
  const require = createRequire(join(process.env.LOAD_SCOREBOARD_DEPS ?? root, 'package.json'));
  return require('@playwright/test');
}

function vmHwmMiB(pid) {
  try {
    return Number(/^VmHWM:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? NaN) / 1024;
  } catch { return NaN; }
}

/** Sample PSS/RSS of the profile's Chrome processes until `stop()`. */
export function startMemorySampler(profileDir, intervalMs = 250) {
  let pids = chromePids(profileDir), scannedAt = Date.now();
  const peak = { pssMiB: 0, rssMiB: 0, samples: 0 };
  const hwm = new Map();
  const tick = () => {
    if (Date.now() - scannedAt > 1000) { pids = chromePids(profileDir); scannedAt = Date.now(); }
    const m = memoryOf(pids);
    peak.pssMiB = Math.max(peak.pssMiB, m.pssMiB);
    peak.rssMiB = Math.max(peak.rssMiB, m.rssMiB);
    peak.samples++;
    for (const pid of pids) { const v = vmHwmMiB(pid); if (Number.isFinite(v)) hwm.set(pid, Math.max(hwm.get(pid) ?? 0, v)); }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      tick();
      const values = [...hwm.values()];
      return { peakPssMiB: peak.pssMiB, peakRssSumMiB: peak.rssMiB, samples: peak.samples, intervalMs,
        maxProcessHwmMiB: values.length ? Math.max(...values) : null, processes: values.length };
    },
  };
}

function summarizeOpen(open, memory) {
  const { byGroup } = browserStages(open.trace);
  const { shares, milestones } = browserShares(open.trace, open.interactiveMs);
  return {
    firstGeometryMs: open.firstFrameMs, interactiveMs: open.interactiveMs, geometryMs: open.geometryMs, propsMs: open.propsMs,
    storeSettledMs: open.storeSettledMs, settleQuantized: open.settleQuantized, completeFrameMs: open.completeFrameMs,
    peakMemoryMiB: memory.peakPssMiB, peakMemoryMetric: 'peak sampled PSS sum over Chrome processes (250 ms), incl. browser baseline', memory,
    loadPaths: open.loadPaths, cacheTiers: open.cacheTiers, cacheHit: open.cacheHit, snapshotAdopted: open.snapshotAdopted,
    stageShares: shares, stageGroupShares: stageShares(byGroup, open.interactiveMs), milestones,
    trace: open.trace,
  };
}

/**
 * One browser sample (cold + warm opens) for `fixture` on `side`. Never
 * throws: failures are kept as samples with `ok: false` and an error.
 * Returns { cold, warm, warmOpens, meta }.
 */
export async function browserSample({ chromium, executablePath, baseUrl, setRoot, side, fixture, warmOpens, outDir, tag, log }) {
  setRoot(side.dist);
  const profileDir = mkdtempSync(join(tmpdir(), 'load-scoreboard-'));
  const env = { ...process.env, VK_ICD_FILENAMES: NVIDIA_ICD, VK_DRIVER_FILES: NVIDIA_ICD };
  const query = `?perfTrace=1${side.query ? `&${side.query}` : ''}`;
  const sizeMB = statSync(fixture.path).size / 2 ** 20;
  const timeoutMs = Math.max(15 * 60 * 1000, sizeMB * 12 * 1000);
  const consoleLogs = [];
  const meta = { query, executablePath, chromeArgs: CHROME_ARGS, pageErrors: [], crashed: false };
  const result = { cold: { lane: 'browser-cold', ok: false }, warm: warmOpens > 0 ? { lane: 'browser-warm', ok: false } : null, warmOpens: [], meta };
  let context = null, page = null, phase = 'launch';
  const watch = (p) => {
    p.on('console', (m) => { if (consoleLogs.length < 5000) consoleLogs.push(m.text()); });
    p.on('pageerror', (e) => meta.pageErrors.push(e.message.slice(0, 300)));
    p.on('crash', () => { meta.crashed = true; });
  };
  const measuredOpen = async (label) => {
    phase = label;
    const sampler = startMemorySampler(profileDir);
    let open;
    try { open = await openAndWaitInteractive(page, [fixture.path], { timeoutMs }); } finally { meta[`${label}Memory`] = sampler.stop(); }
    const fingerprint = await readOutputFingerprint(page);
    log?.(`  ${tag} ${label}: first ${open.firstFrameMs?.toFixed(0)} ms, interactive ${open.interactiveMs.toFixed(0)} ms, peak PSS ${meta[`${label}Memory`].peakPssMiB.toFixed(0)} MiB, path ${open.loadPaths.join(',')}`);
    return { ...summarizeOpen(open, meta[`${label}Memory`]), fingerprint: fingerprint.map((m) => `meshes=${m.meshes} triangles=${m.triangles} vertices=${m.vertices} sig=${m.meshSignature}`).join(' | '), models: fingerprint };
  };
  try {
    context = await chromium.launchPersistentContext(profileDir, { env, executablePath, headless: false,
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, args: CHROME_ARGS });
    meta.browserVersion = context.browser()?.version() ?? null;
    await context.addInitScript(COUNT_FRAMES);
    page = context.pages()[0] ?? await context.newPage();
    watch(page);
    phase = 'boot';
    page = await openViewerPage(context, `${baseUrl}/${query}`);
    result.cold = { lane: 'browser-cold', ok: true, ...(await measuredOpen('cold')) };
    meta.adapter = await page.evaluate(() => globalThis.__ifc_lite_render_stats__?.()?.adapter ?? null);
    meta.gpuHealthCold = await readGpuHealth(page, consoleLogs).catch((e) => ({ error: String(e) }));
    if (meta.gpuHealthCold?.contaminated || meta.crashed) {
      throw new Error(meta.crashed ? 'renderer crashed' : `GPU device lost during sample (${meta.gpuHealthCold.reasons.join('; ')})`);
    }
    if (warmOpens > 0) {
      phase = 'cache-write';
      meta.cacheWriteSettled = await waitCacheWrites(page);
      for (let i = 1; i <= warmOpens; i++) {
        if (i > 1 && !/perf\.sceneSnapshot=0\b/.test(side.query ?? '')) {
          phase = 'snapshot-write';
          meta.snapshotWritten = await waitSceneSnapshots(page).then(() => true, () => false);
        }
        await replacePage(context, page);
        page = context.pages().at(-1);
        watch(page);
        phase = `warm${i}`;
        page = await openViewerPage(context, `${baseUrl}/${query}`);
        const warm = await measuredOpen(`warm${i}`);
        result.warmOpens.push({ open: i, interactiveMs: warm.interactiveMs, firstGeometryMs: warm.firstGeometryMs, loadPaths: warm.loadPaths,
          snapshotAdopted: warm.snapshotAdopted, peakMemoryMiB: warm.peakMemoryMiB });
        if (i === warmOpens) result.warm = { lane: 'browser-warm', ok: true, ...warm };
      }
    }
    meta.gpuHealth = await readGpuHealth(page, consoleLogs).catch((e) => ({ error: String(e) }));
    meta.vramMiB = vramOf(chromePids(profileDir));
    if (meta.gpuHealth?.contaminated) throw new Error(`GPU device lost during sample (${meta.gpuHealth.reasons.join('; ')})`);
    if (meta.crashed) throw new Error('renderer crashed');
  } catch (err) {
    const error = `${phase}: ${String(err?.message ?? err).slice(0, 600)}`;
    log?.(`  ${tag} FAILED ${error}`);
    if (page) await page.screenshot({ path: join(outDir, `FAILED-${tag}.png`) }).catch(() => {});
    if (!meta.gpuHealth && page) meta.gpuHealth = await readGpuHealth(page, consoleLogs).catch((e) => ({ error: String(e) }));
    // A failure taints every lane of this sample that had not already finished cleanly before it.
    if (['launch', 'boot', 'cold'].includes(phase)) result.cold = { ...result.cold, ok: false, error };
    if (result.warm) result.warm = { ...result.warm, ok: false, error };
  } finally {
    await context?.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
    writeFileSync(join(outDir, `${tag}.console.log`), consoleLogs.join('\n'));
  }
  return result;
}
