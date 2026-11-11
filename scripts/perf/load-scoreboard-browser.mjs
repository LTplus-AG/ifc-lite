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
import { browserShares, browserStages, expectedCacheTier, failedOpenIndex, gpuUnhealthy, stageShares, uiQuietValue } from './load-scoreboard-stats.mjs';
import { BOOT_OBSERVERS, waitShellQuiet, waitUiQuiet } from './viewer-load-boot.mjs';
import { expectSceneSnapshot, prepareWarmOpen } from './viewer-scene-snapshot.mjs';
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
    publishPaintMs: open.publishPaintMs, settlePaintMs: open.settlePaintMs, inputDelayMs: open.inputDelayMs, clockFrom: open.clockFrom,
    // A capped quiet wait is not a measurement: it is kept as null with the flag (uiQuietValue).
    uiQuietMs: uiQuietValue(open), uiQuietTimedOut: Boolean(open.uiQuietTimedOut), uiQuietRawMs: open.uiQuietMs ?? null,
    longTasksAfterReady: open.longTasksAfterReady ?? null, shell: open.shell ?? null,
    peakMemoryMiB: memory ? memory.peakPssMiB : null,
    peakMemoryMetric: memory ? 'peak sampled PSS sum over Chrome processes (250 ms), incl. browser baseline' : 'not sampled (timing pass)', memory,
    loadPaths: open.loadPaths, cacheTiers: open.cacheTiers, cacheHit: open.cacheHit, snapshotAdopted: open.snapshotAdopted,
    stageShares: shares, stageGroupShares: stageShares(byGroup, open.interactiveMs), milestones,
    trace: open.trace,
  };
}

/**
 * One browser sample (cold + warm opens) for `fixture` on `side`. Never
 * throws: failures are kept as samples with `ok: false` and an error.
 * `pass: 'timing'` takes no memory samples (the 250 ms PSS sampler cost about
 * 12% on Holter); `pass: 'memory'` repeats the sample with the sampler on and
 * is used for peak memory only. Both arm each open on a quiet shell with the
 * main-thread perf counters off (viewer-load-boot.mjs).
 * Returns { lanes: { 'browser-cold', 'browser-warm1', 'browser-warm' }, warmOpens, meta }.
 */
export async function browserSample({ chromium, executablePath, baseUrl, setRoot, side, fixture, warmOpens, outDir, tag, log, pass = 'timing' }) {
  setRoot(side.dist);
  const profileDir = mkdtempSync(join(tmpdir(), 'load-scoreboard-'));
  const env = { ...process.env, VK_ICD_FILENAMES: NVIDIA_ICD, VK_DRIVER_FILES: NVIDIA_ICD };
  const query = `?perfTrace=1${side.query ? `&${side.query}` : ''}`;
  const sizeMB = statSync(fixture.path).size / 2 ** 20;
  const uncached = expectedCacheTier(statSync(fixture.path).size).startsWith('none');
  const timeoutMs = Math.max(15 * 60 * 1000, sizeMB * 12 * 1000);
  const consoleLogs = [];
  const meta = { pass, query, executablePath, chromeArgs: CHROME_ARGS, pageErrors: [], crashed: false };
  const lanes = { 'browser-cold': { lane: 'browser-cold', ok: false } };
  if (warmOpens > 1) lanes['browser-warm1'] = { lane: 'browser-warm1', ok: false };
  if (warmOpens > 0) lanes['browser-warm'] = { lane: 'browser-warm', ok: false };
  const result = { lanes, warmOpens: [], meta };
  let context = null, page = null, phase = 'launch', coldFingerprint = null;
  const watch = (p) => {
    p.on('console', (m) => { if (consoleLogs.length < 5000) consoleLogs.push(m.text()); });
    p.on('pageerror', (e) => meta.pageErrors.push(e.message.slice(0, 300)));
    p.on('crash', () => { meta.crashed = true; });
  };
  const measuredOpen = async (label) => {
    phase = `${label}-shell`;
    const shell = await waitShellQuiet(page);
    phase = label;
    const sampler = pass === 'memory' ? startMemorySampler(profileDir) : null;
    let open;
    try { open = await openAndWaitInteractive(page, [fixture.path], { timeoutMs }); } finally { if (sampler) meta[`${label}Memory`] = sampler.stop(); }
    Object.assign(open, { shell }, await waitUiQuiet(page, open.originAbs + open.interactiveMs, open.originAbs));
    const memory = meta[`${label}Memory`] ?? null;
    const fingerprint = await readOutputFingerprint(page);
    log?.(`  ${tag} ${pass} ${label}: first ${open.firstFrameMs?.toFixed(0)} ms, interactive ${open.interactiveMs.toFixed(0)} ms, ui quiet ${open.uiQuietTimedOut ? 'capped' : `${open.uiQuietMs.toFixed(0)} ms`}, input delay ${open.inputDelayMs?.toFixed(0)} ms${memory ? `, peak PSS ${memory.peakPssMiB.toFixed(0)} MiB` : ''}, path ${open.loadPaths.join(',')}`);
    let identity = fingerprint.map((m) => m.identity).join(' | ');
    let elements = fingerprint.map((m) => m.elements);
    let identitySource = 'element hashes';
    if (label !== 'cold' && fingerprint.every((m) => m.hashed === 0)) {
      // A cache hit has no element hashes. It is identified by its cold load when it
      // restored that load's flat output exactly; otherwise it is a restore mismatch.
      const restored = coldFingerprint && coldFingerprint.length === fingerprint.length
        && fingerprint.every((m, i) => m.flat.signature === coldFingerprint[i].flat.signature && m.flat.meshes === coldFingerprint[i].flat.meshes);
      identity = restored ? `restored cold: ${coldFingerprint.map((m) => m.identity).join(' | ')}`
        : `RESTORE MISMATCH vs cold: flat ${fingerprint.map((m) => `${m.flat.meshes}/${m.flat.signature}`).join(',')}`;
      elements = restored ? coldFingerprint.map((m) => m.elements) : fingerprint.map(() => ({}));
      identitySource = restored ? 'cold load (warm restored its flat output exactly; instanced shards not compared)' : 'none';
    }
    if (label === 'cold') coldFingerprint = fingerprint;
    // Per-element hashes go to their own file (large); the row keeps the partition-independent identity.
    if (pass === 'timing') writeFileSync(join(outDir, `${tag}-${label}.elements.json`), JSON.stringify(elements));
    return { ...summarizeOpen(open, memory), fingerprint: identity, identitySource,
      models: fingerprint.map(({ elements: _e, ...rest }) => rest) };
  };
  try {
    context = await chromium.launchPersistentContext(profileDir, { env, executablePath, headless: false,
      viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, args: CHROME_ARGS });
    meta.browserVersion = context.browser()?.version() ?? null;
    await context.addInitScript(COUNT_FRAMES);
    await context.addInitScript(BOOT_OBSERVERS, { countersOff: true });
    page = context.pages()[0] ?? await context.newPage();
    watch(page);
    phase = 'boot';
    page = await openViewerPage(context, `${baseUrl}/${query}`);
    lanes['browser-cold'] = { lane: 'browser-cold', ok: true, ...(await measuredOpen('cold')) };
    meta.adapter = await page.evaluate(() => globalThis.__ifc_lite_render_stats__?.()?.adapter ?? null);
    meta.gpuHealthCold = await readGpuHealth(page, consoleLogs).catch((e) => ({ error: String(e) }));
    if (gpuUnhealthy(meta.gpuHealthCold) || meta.crashed) {
      throw new Error(meta.crashed ? 'renderer crashed' : gpuUnhealthy(meta.gpuHealthCold));
    }
    if (warmOpens > 0) {
      // Every step that prepares reopen i is attributed to open i (`warm<i>-prep`), so a
      // failure there taints that open and later ones, never an earlier clean open.
      phase = 'warm1-prep';
      meta.cacheWriteSettled = await waitCacheWrites(page);
      for (let i = 1; i <= warmOpens; i++) {
        phase = `warm${i}-prep`;
        // Uncached tiers never write a snapshot: waiting for one cost 60 s per sample (H6).
        // The viewer's own rule decides whether a snapshot will be written (viewer-scene-snapshot.mjs).
        meta.snapshotExpected = expectSceneSnapshot({ query, files: 1, cached: !uncached });
        // A reopen whose cache write or expected snapshot is missing fails as that open (warm<i>-prep).
        const prep = await prepareWarmOpen({ open: i, cacheWriteSettled: meta.cacheWriteSettled, snapshotExpected: meta.snapshotExpected,
          waitSnapshot: () => waitSceneSnapshots(page) });
        if (prep.snapshotWritten !== undefined) meta.snapshotWritten = prep.snapshotWritten;
        if (prep.failure) throw new Error(prep.failure);
        await replacePage(context, page);
        page = context.pages().at(-1);
        watch(page);
        phase = `warm${i}`;
        page = await openViewerPage(context, `${baseUrl}/${query}`);
        const warm = await measuredOpen(`warm${i}`);
        result.warmOpens.push({ open: i, interactiveMs: warm.interactiveMs, firstGeometryMs: warm.firstGeometryMs, loadPaths: warm.loadPaths,
          snapshotAdopted: warm.snapshotAdopted, peakMemoryMiB: warm.peakMemoryMiB });
        if (i === 1 && warmOpens > 1) lanes['browser-warm1'] = { lane: 'browser-warm1', ok: true, ...warm };
        if (i === warmOpens) lanes['browser-warm'] = { lane: 'browser-warm', ok: true, ...warm };
      }
    }
    // A loss seen only at the end cannot be placed in one reopen: it taints every warm open.
    phase = 'warm1';
    meta.gpuHealth = await readGpuHealth(page, consoleLogs).catch((e) => ({ error: String(e) }));
    meta.vramMiB = vramOf(chromePids(profileDir));
    if (gpuUnhealthy(meta.gpuHealth)) throw new Error(gpuUnhealthy(meta.gpuHealth));
    if (meta.crashed) throw new Error('renderer crashed');
  } catch (err) {
    const error = `${phase}: ${String(err?.message ?? err).slice(0, 600)}`;
    log?.(`  ${tag} FAILED ${error}`);
    if (page) await page.screenshot({ path: join(outDir, `FAILED-${tag}.png`) }).catch(() => {});
    if (!meta.gpuHealth && page) meta.gpuHealth = await readGpuHealth(page, consoleLogs).catch((e) => ({ error: String(e) }));
    // A failure taints every lane of this sample that had not already finished cleanly before it.
    // A failure taints the open it happened in and every later one; earlier clean opens keep their result.
    const failedOpen = failedOpenIndex(phase);
    const index = { 'browser-cold': 0, 'browser-warm1': 1, 'browser-warm': warmOpens };
    for (const [name, lane] of Object.entries(lanes)) if (index[name] >= failedOpen) lanes[name] = { ...lane, ok: false, error };
  } finally {
    await context?.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
    writeFileSync(join(outDir, `${tag}.console.log`), consoleLogs.join('\n'));
  }
  return result;
}
