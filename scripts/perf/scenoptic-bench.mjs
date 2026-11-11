#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real-GPU viewer benchmark on the axes of the Scenoptic web BIM benchmark
 * (sebgoubier.github.io/scenoptic-benchmarks/2026-10): per model set, in one
 * fresh browser profile,
 *
 *   cold   open the raw IFC files, empty cache: first frame, full geometry,
 *          properties (load-trace milestones), RAM + VRAM after opening
 *   warm   reload the page and open the same files again (IndexedDB cache
 *          filled): the same timings and memory
 *   orbit  a 20 s left-drag orbit after the warm open and after post-load CPU
 *          settles: rendered frames/s, per-pass GPU time (timestamp queries,
 *          also in clock-normalized Mcycles), CPU of every Chrome process
 *
 * Builds are compared base/branch, interleaved per round (ABBA), never
 * against a recorded number. Not a CI gate; run it under exclusive benchmark
 * admission on an otherwise idle host with a physical GPU.
 *
 *   DISPLAY=:97 node scripts/perf/scenoptic-bench.mjs \
 *     --dist apps/viewer/dist [--dist-base /abs/base/dist] [--build name=/abs/dist[?perf.flag=1] ...] \
 *     --set test1=/abs/sixty5.ifc [--set fed=/abs/a.ifc,/abs/b.ifc] \
 *     [--rounds 3] [--warm-opens 1] [--orbit-s 20] [--out /abs/dir] [--no-orbit] [--no-warm]
 *
 * Linux only (reads /proc and nvidia-smi). Headed Chrome on a private Xvfb:
 * headless Chrome on Pop's NVIDIA driver loses the WebGPU device on the first
 * canvas present, so the display must be an Xvfb, never the user's :0/:1.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TICK, chromePids, cpuTicks, memoryOf, settleCpu, vramOf, withGpuClock } from './scenoptic-bench-sampling.mjs';
import { COUNT_FRAMES, openAndWaitInteractive, openViewerPage, replacePage, startViewerServer, waitCacheWrites, waitSceneSnapshots } from './viewer-load-probe.mjs';
import { expectSceneSnapshot, prepareWarmOpen } from './viewer-scene-snapshot.mjs';
import { expectedCacheTier } from './load-scoreboard-stats.mjs';
import { waitCacheEntryStable } from './load-scoreboard-lanes.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// SCENOPTIC_BENCH_DEPS: a checkout with node_modules, when this one has none installed.
const require = createRequire(join(process.env.SCENOPTIC_BENCH_DEPS ?? ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = { set: [], build: [], rounds: 3, 'orbit-s': 20, 'warm-opens': 1, width: 1920, height: 1080 };
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].replace(/^--/, '');
  if (key === 'no-orbit' || key === 'no-warm') { opt[key] = true; continue; }
  // --profile cold,warm,orbit: main-thread CPU profile per phase (build with VITE_SOURCEMAP=1 to symbolize).
  const value = argv[++i];
  if (value === undefined) { console.error(`--${key} needs a value`); process.exit(2); }
  if (key === 'set') opt.set.push(value); else if (key === 'build') opt.build.push(value); else opt[key] = value;
}
if ((!opt.dist && opt.build.length === 0) || opt.set.length === 0) {
  console.error('usage: scenoptic-bench.mjs --dist DIR [--dist-base DIR] --set name=a.ifc[,b.ifc] [--rounds N]');
  process.exit(2);
}
const display = process.env.DISPLAY;
if (!display || display === ':0' || display === ':1') throw new Error('set DISPLAY to a private Xvfb (e.g. :97)');
// A hybrid laptop's Intel Vulkan driver can win the adapter and then lose the device on allocation: show Chrome the NVIDIA one only.
const NVIDIA_ICD = '/usr/share/vulkan/icd.d/nvidia_icd.json';
const GPU_ENV = existsSync(NVIDIA_ICD) ? { ...process.env, VK_ICD_FILENAMES: NVIDIA_ICD, VK_DRIVER_FILES: NVIDIA_ICD } : process.env;
const CHROME = process.env.CHROME ?? join(process.env.HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const positive = (name) => {
  const n = Number(opt[name]);
  if (!Number.isFinite(n) || n <= 0) { console.error(`--${name} needs a positive number, got "${opt[name]}"`); process.exit(2); }
  return n;
};
const ROUNDS = Math.ceil(positive('rounds')), ORBIT_MS = positive('orbit-s') * 1000;
const W = positive('width'), H = positive('height');
const WARM_OPENS = Math.ceil(positive('warm-opens'));
const OUT = resolve(opt.out ?? join(ROOT, 'scripts/perf/.scenoptic-bench-results', new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(OUT, { recursive: true });
/** Split `name=value` at the first `=`, so a path may contain one. */
const nameValue = (flag, s) => {
  const at = s.indexOf('=');
  if (at <= 0 || at === s.length - 1) { console.error(`--${flag} needs name=value, got "${s}"`); process.exit(2); }
  return [s.slice(0, at), s.slice(at + 1)];
};
const SETS = opt.set.map((s) => {
  const [name, files] = nameValue('set', s);
  const list = files.split(',').map((f) => resolve(f));
  for (const f of list) if (!existsSync(f)) throw new Error(`missing fixture ${f}`);
  return { name, files: list, bytes: list.reduce((n, f) => n + statSync(f).size, 0) };
});
// The first build is the reference every ratio is taken against.
const BUILDS = opt.dist ? [{ id: 'branch', dist: resolve(opt.dist), flags: '' }] : [];
if (opt['dist-base']) BUILDS.unshift({ id: 'base', dist: resolve(opt['dist-base']), flags: '' });
for (const b of opt.build) {
  const [id, target] = nameValue('build', b);
  const [dir, flags] = target.split('?');
  BUILDS.push({ id, dist: resolve(dir), flags: flags ? `&${flags}` : '' });
}
// Results are keyed by name: a repeat would overwrite samples and merge medians.
for (const [flag, names] of [['set', SETS.map((x) => x.name)], ['build', BUILDS.map((x) => x.id)]]) {
  const repeat = names.find((n, i) => names.indexOf(n) !== i);
  if (repeat) { console.error(`--${flag} name "${repeat}" is used twice`); process.exit(2); }
}
const PROFILE = new Set((opt.profile ?? '').split(',').filter(Boolean));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- static server
let currentRoot = BUILDS[0].dist;
const { server, baseUrl: BASE_URL } = await startViewerServer(() => currentRoot, log);
const QUERY = '?perfTrace=1&perf.gpuFrameTiming=1';
let currentFlags = ''; // the running build's own `--build name=dir?flags`

// ---------------------------------------------------------------- page helpers
const INIT = COUNT_FRAMES;

async function openPage(context) {
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (e) => log('pageerror', e.message.slice(0, 300)));
  return openViewerPage(context, `${BASE_URL}/${QUERY}${currentFlags}`, {
    onFailure: (p, what) => p.screenshot({ path: join(OUT, `fail-${what}-${Date.now()}.png`) }).catch(() => {}),
  });
}

/** Open `files`, wait until every model is fully interactive (viewer-load-probe.mjs), return timings relative to the input event. */
async function openFiles(page, files, label) {
  const value = await openAndWaitInteractive(page, files);
  log(`  ${label}: first frame ${fmt(value.firstFrameMs)} ms, geometry ${fmt(value.geometryMs)} ms, props ${fmt(value.propsMs)} ms, interactive ${fmt(value.interactiveMs)} ms (t0 ${value.t0.toFixed(0)})`);
  delete value.trace; // full span dump is the scoreboard's; keep this summary's shape
  return value;
}

async function sampleMemory(page, profileDir) {
  await page.waitForTimeout(3000); // let post-load GC and deferred work settle
  const pids = chromePids(profileDir);
  const stats = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_render_stats__?.();
    return s ? { gpu: s.gpu, cpuBytes: s.cpuBytes, adapter: s.adapter } : null;
  });
  return { ...memoryOf(pids), vramMiB: vramOf(pids), rendererGpu: stats?.gpu ?? null, rendererCpu: stats?.cpuBytes ?? null, adapter: stats?.adapter ?? null };
}

async function orbit(page, profileDir, openTicks) {
  const settle = await settleCpu(profileDir);
  // A faster open moves post-load work into the settle window, so also count from the open.
  const fromOpenCpuSeconds = openTicks === undefined ? null : (cpuTicks(chromePids(profileDir)) - openTicks) / TICK;
  const box = await page.locator('canvas').first().boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2, r = Math.min(box.width, box.height) * 0.2;
  await page.mouse.move(cx + r, cy);
  await page.waitForTimeout(1500);
  const pids = chromePids(profileDir);
  const before = await page.evaluate(() => ({ frames: globalThis.__benchFrames ?? 0, now: performance.now(),
    gpu: globalThis.__ifc_lite_render_stats__?.().gpuTiming?.sampled ?? 0 }));
  const ticks0 = cpuTicks(pids), wall0 = Date.now();
  const clock = await withGpuClock(async () => {
    await page.mouse.down();
    // Continuous drag: one move per ~8 ms; a full horizontal sweep plus a gentle vertical wobble.
    while (Date.now() - wall0 < ORBIT_MS) {
      const p = (Date.now() - wall0) / ORBIT_MS;
      await page.mouse.move(cx + r * Math.cos(p * 6 * Math.PI), cy + r * 0.3 * Math.sin(p * 4 * Math.PI));
      await new Promise((res) => setTimeout(res, 8));
    }
    await page.mouse.up();
  });
  const wallMs = Date.now() - wall0, ticks1 = cpuTicks(pids);
  const after = await page.evaluate((startNow) => {
    const timing = globalThis.__ifc_lite_render_stats__?.().gpuTiming ?? null;
    const frames = timing?.mode === 'gpu-queries' ? timing.frames.filter((f) => f.timestamp >= startNow) : [];
    return { frames: globalThis.__benchFrames ?? 0, now: performance.now(), timingMode: timing?.mode ?? null,
      gpuFrames: frames.map((f) => f.passesMs) };
  }, before.now);
  const pageMs = after.now - before.now;
  const totals = after.gpuFrames.map((p) => Object.values(p).reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
  const perPass = {};
  for (const frame of after.gpuFrames) for (const [k, v] of Object.entries(frame)) (perPass[k] ??= []).push(v);
  const res = {
    fps: (after.frames - before.frames) / (pageMs / 1000),
    gpuTimingMode: after.timingMode,
    gpuSamples: totals.length,
    gpuMsMean: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null,
    gpuMsP50: pct(totals, 50), gpuMsP95: pct(totals, 95),
    gpuPassMsMean: Object.fromEntries(Object.entries(perPass).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length])),
    cpuCores: (ticks1 - ticks0) / TICK / (wallMs / 1000),
    settleCpuSeconds: settle.cpuSeconds,
    fromOpenCpuSeconds,
    gpuClockMHz: clock.mhz(),
  };
  res.gpuMcyclesMean = res.gpuMsMean !== null && res.gpuClockMHz ? (res.gpuMsMean * res.gpuClockMHz) / 1000 : null;
  // Post passes switch on and off between rounds; the main pass is what batches decide.
  res.mainPassMcycles = res.gpuPassMsMean.main !== undefined && res.gpuClockMHz ? (res.gpuPassMsMean.main * res.gpuClockMHz) / 1000 : null;
  res.cpuMsPerFrame = res.fps > 0 ? (res.cpuCores * 1000) / res.fps : null;
  log(`  orbit: ${res.fps.toFixed(1)} fps, GPU mean ${fmt(res.gpuMsMean, 2)} ms (p95 ${fmt(res.gpuMsP95, 2)}) at ${fmt(res.gpuClockMHz)} MHz = ${fmt(res.gpuMcyclesMean, 2)} Mcycles, settle ${fmt(res.settleCpuSeconds, 1)} CPU-s, CPU ${res.cpuCores.toFixed(2)} cores (${fmt(res.cpuMsPerFrame, 1)} ms/frame)`);
  return res;
}

/** Run `fn` under a main-thread CDP CPU profile when `phase` is requested; writes `<tag>-<phase>.cpuprofile`. */
async function profiled(page, phase, tag, fn) {
  if (!PROFILE.has(phase)) return fn();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  try { return await fn(); } finally {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(join(OUT, `${tag}-${phase}.cpuprofile`), JSON.stringify(profile));
    await cdp.detach().catch(() => {});
  }
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const fmt = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));

async function runSample(build, set, round) {
  currentRoot = build.dist;
  currentFlags = build.flags;
  const profileDir = mkdtempSync(join(tmpdir(), 'scenoptic-bench-'));
  const launch = () => chromium.launchPersistentContext(profileDir, {
    env: GPU_ENV, executablePath: CHROME, headless: false, viewport: { width: W, height: H }, deviceScaleFactor: 1,
    args: ['--enable-gpu', '--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
      // Pin the default WebGPU adapter to the discrete GPU: on Pop it flips between Intel and NVIDIA (#8787).
      '--use-angle=vulkan', '--ignore-gpu-blocklist', '--use-webgpu-power-preference=default-high-performance',
      '--hide-scrollbars', '--no-first-run', `--window-size=${W},${H}`, '--window-position=0,0'],
  });
  const sample = { build: build.id, set: set.name, round, files: set.files.map((f) => basename(f)), bytes: set.bytes };
  let context = null;
  try {
    context = await launch();
    await context.addInitScript(INIT);
    let page = await openPage(context);
    const tag = `${set.name}-${build.id}-r${round}`;
    let openTicks;
    sample.cold = await profiled(page, 'cold', tag, () => openFiles(page, set.files, `${build.id}/${set.name}#${round} cold`));
    sample.cold.memory = await sampleMemory(page, profileDir);
    sample.adapter = sample.cold.memory.adapter;
    log(`    memory: PSS ${fmt(sample.cold.memory.pssMiB)} MiB, RSS ${fmt(sample.cold.memory.rssMiB)} MiB, VRAM ${fmt(sample.cold.memory.vramMiB)} MiB`);
    if (!opt['no-warm']) {
      const cacheWriteSettled = await waitCacheWrites(page);
      // The viewer's own default rule (on unless perf.sceneSnapshot says otherwise); only a cached single-file hit writes one.
      const cached = !expectedCacheTier(set.bytes).startsWith('none');
      const snapshotExpected = expectSceneSnapshot({ query: `${QUERY}${build.flags}`, files: set.files.length, cached });
      // A warm open may store a scene snapshot the next one reads (`--warm-opens 2`); the last is the sample.
      for (let open = 1; open <= WARM_OPENS; open++) {
        const prep = await prepareWarmOpen({ open, cacheWriteSettled, snapshotExpected, waitSnapshot: () => waitSceneSnapshots(page),
          // The first reopen waits until the stored entry stops changing, as load-scoreboard does (#9740).
          waitEntryStable: () => (cached ? waitCacheEntryStable(page) : Promise.resolve({ skipped: 'uncached tier: no cache entry is written' })) });
        if (open === 1) sample.entryBeforeWarm1 = prep.entry ?? null;
        if (prep.failure) {
          // Not measured: a reopen without its cache write or expected snapshot would time a different path.
          // The reason stays in the sample; the cold open stays valid; no warm or orbit numbers enter the medians.
          sample.warmError = `warm${open}: ${prep.failure}`;
          delete sample.warm;
          log(`  ${sample.warmError}`);
          break;
        }
        await replacePage(context, page);
        page = await openPage(context);
        openTicks = cpuTicks(chromePids(profileDir));
        sample.warm = await profiled(page, 'warm', tag, () => openFiles(page, set.files, `${build.id}/${set.name}#${round} warm${open}`));
      }
      if (sample.warm) {
        sample.warm.memory = await sampleMemory(page, profileDir);
        log(`    memory: PSS ${fmt(sample.warm.memory.pssMiB)} MiB, RSS ${fmt(sample.warm.memory.rssMiB)} MiB, VRAM ${fmt(sample.warm.memory.vramMiB)} MiB`);
      }
    }
    if (!opt['no-orbit'] && !sample.warmError) sample.orbit = await profiled(page, 'orbit', tag, () => orbit(page, profileDir, openTicks));
  } catch (err) {
    sample.error = String(err?.stack ?? err);
    log('  sample failed:', String(err?.message ?? err).slice(0, 400));
  } finally {
    await context?.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, `${set.name}-${build.id}-r${round}.json`), JSON.stringify(sample, null, 2));
  return sample;
}

// ---------------------------------------------------------------- main
log(`scenoptic-bench: ${BUILDS.map((b) => `${b.id}=${b.dist}`).join(' ')} -> ${OUT}`);
const samples = [];
for (let round = 0; round < ROUNDS; round++) {
  for (const set of SETS) {
    // Rotate which build goes first each round (ABBA for two builds).
    const order = round % 2 === 0 ? BUILDS : [...BUILDS].reverse();
    for (const build of order) samples.push(await runSample(build, set, round));
  }
}
server.close();

const median = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
const METRICS = [
  ['cold first frame ms', (s) => s.cold?.firstFrameMs], ['cold geometry ms', (s) => s.cold?.geometryMs], ['cold props ms', (s) => s.cold?.propsMs],
  ['cold PSS MiB', (s) => s.cold?.memory?.pssMiB], ['cold VRAM MiB', (s) => s.cold?.memory?.vramMiB],
  ['warm first frame ms', (s) => s.warm?.firstFrameMs], ['warm complete frame ms', (s) => s.warm?.completeFrameMs], ['warm geometry ms', (s) => s.warm?.geometryMs], ['warm props ms', (s) => s.warm?.propsMs],
  ['warm PSS MiB', (s) => s.warm?.memory?.pssMiB], ['warm VRAM MiB', (s) => s.warm?.memory?.vramMiB],
  ['orbit fps', (s) => s.orbit?.fps], ['orbit GPU ms mean', (s) => s.orbit?.gpuMsMean], ['orbit GPU Mcycles', (s) => s.orbit?.gpuMcyclesMean], ['orbit main pass Mcycles', (s) => s.orbit?.mainPassMcycles], ['post-load CPU-s', (s) => s.orbit?.settleCpuSeconds], ['open to quiet CPU-s', (s) => s.orbit?.fromOpenCpuSeconds], ['orbit CPU cores', (s) => s.orbit?.cpuCores],
  ['orbit CPU ms/frame', (s) => s.orbit?.cpuMsPerFrame],
];
const summary = {};
const lines = [`| set | metric | ${BUILDS.map((b, i) => i ? `${b.id} | ×` : b.id).join(' | ')} |`,
  `|---|---|${BUILDS.map((_, i) => i ? '---|---|' : '---|').join('')}`];
for (const set of SETS) {
  for (const [name, get] of METRICS) {
    const vals = BUILDS.map((b) => median(samples.filter((s) => s.build === b.id && s.set === set.name && !s.error).map(get)));
    if (vals.every((v) => v === null)) continue;
    (summary[set.name] ??= {})[name] = Object.fromEntries(BUILDS.map((b, i) => [b.id, vals[i]]));
    const digits = name.includes('GPU') || name.includes('Mcycles') || name.includes('cores') || name.includes('CPU-s') ? 2 : 0;
    const cells = vals.map((v, i) => i ? `${fmt(v, digits)} | ${vals[0] && v !== null ? (v / vals[0]).toFixed(2) : 'n/a'}` : fmt(v, digits));
    lines.push(`| ${set.name} | ${name} | ${cells.join(' | ')} |`);
  }
}
const failures = samples.filter((s) => s.error).length;
const warmFailures = samples.filter((s) => s.warmError).length;
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ builds: BUILDS, sets: SETS, rounds: ROUNDS, failures, warmFailures, summary }, null, 2));
writeFileSync(join(OUT, 'summary.md'), lines.join('\n') + '\n');
console.log(`\nmedians over ${ROUNDS} round(s), ${failures} failed sample(s), ${warmFailures} unmeasured warm open(s):\n` + lines.join('\n'));
process.exit(failures || warmFailures ? 1 : 0);
