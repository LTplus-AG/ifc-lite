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
 *     --dist apps/viewer/dist [--dist-base /abs/base/dist] [--build name=/abs/dist ...] \
 *     --set test1=/abs/sixty5.ifc [--set fed=/abs/a.ifc,/abs/b.ifc] \
 *     [--rounds 3] [--orbit-s 20] [--out /abs/dir] [--no-orbit] [--no-warm]
 *
 * Linux only (reads /proc and nvidia-smi). Headed Chrome on a private Xvfb:
 * headless Chrome on Pop's NVIDIA driver loses the WebGPU device on the first
 * canvas present, so the display must be an Xvfb, never the user's :0/:1.
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// SCENOPTIC_BENCH_DEPS: a checkout with node_modules, when this one has none installed.
const require = createRequire(join(process.env.SCENOPTIC_BENCH_DEPS ?? ROOT, 'package.json'));
const { chromium } = require('@playwright/test');

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = { set: [], build: [], rounds: 3, 'orbit-s': 20, width: 1920, height: 1080 };
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
const CHROME = process.env.CHROME ?? join(process.env.HOME, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const positive = (name) => {
  const n = Number(opt[name]);
  if (!Number.isFinite(n) || n <= 0) { console.error(`--${name} needs a positive number, got "${opt[name]}"`); process.exit(2); }
  return n;
};
const ROUNDS = Math.ceil(positive('rounds')), ORBIT_MS = positive('orbit-s') * 1000;
const W = positive('width'), H = positive('height');
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
const BUILDS = opt.dist ? [{ id: 'branch', dist: resolve(opt.dist) }] : [];
if (opt['dist-base']) BUILDS.unshift({ id: 'base', dist: resolve(opt['dist-base']) });
for (const b of opt.build) { const [id, dir] = nameValue('build', b); BUILDS.push({ id, dist: resolve(dir) }); }
const PROFILE = new Set((opt.profile ?? '').split(',').filter(Boolean));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- static server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2' };
let currentRoot = BUILDS[0].dist;
const server = createServer((req, res) => {
  let pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (pathname.endsWith('/')) pathname += 'index.html';
  let file = normalize(join(currentRoot, pathname));
  if (!file.startsWith(currentRoot + sep)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(pathname)) { log('404', pathname); res.writeHead(404).end(); return; }
    file = join(currentRoot, 'index.html'); // SPA route
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE_URL = `http://127.0.0.1:${server.address().port}`;
const QUERY = '?perfTrace=1&perf.gpuFrameTiming=1';

// ---------------------------------------------------------------- process sampling
function chromePids(profileDir) {
  const pids = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (cmd.includes(profileDir)) pids.push(Number(entry));
    } catch { /* process exited between readdir and read */ }
  }
  return pids;
}
function memoryOf(pids) {
  let rss = 0, pss = 0;
  for (const pid of pids) {
    try {
      const text = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
      rss += Number(/^Rss:\s+(\d+)/m.exec(text)?.[1] ?? 0) * 1024;
      pss += Number(/^Pss:\s+(\d+)/m.exec(text)?.[1] ?? 0) * 1024;
    } catch { /* exited */ }
  }
  return { rssMiB: rss / 2 ** 20, pssMiB: pss / 2 ** 20 };
}
function vramOf(pids) {
  try {
    const text = execFileSync('nvidia-smi', ['-q', '-d', 'PIDS'], { encoding: 'utf8' });
    let total = 0;
    for (const block of text.split(/Process ID\s*:/).slice(1)) {
      const pid = Number(block.trim().split(/\s/)[0]);
      const mib = Number(/Used GPU Memory\s*:\s*(\d+)\s*MiB/.exec(block)?.[1] ?? NaN);
      if (pids.includes(pid) && Number.isFinite(mib)) total += mib;
    }
    return total;
  } catch (err) {
    log('nvidia-smi failed', err.message);
    return null;
  }
}
const TICK = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
function cpuTicks(pids) {
  let ticks = 0;
  for (const pid of pids) {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      ticks += Number(fields[11]) + Number(fields[12]); // utime + stime
    } catch { /* exited */ }
  }
  return ticks;
}

// ---------------------------------------------------------------- page helpers
const INIT = () => {
  // Count presented frames: a rendered frame acquires the swap-chain texture.
  const proto = globalThis.GPUCanvasContext?.prototype;
  if (proto && !proto.__benchWrapped) {
    const orig = proto.getCurrentTexture;
    proto.getCurrentTexture = function () { globalThis.__benchFrames = (globalThis.__benchFrames ?? 0) + 1; return orig.call(this); };
    proto.__benchWrapped = true;
  }
};

async function openPage(context) {
  const page = context.pages()[0] ?? await context.newPage();
  page.on('pageerror', (e) => log('pageerror', e.message.slice(0, 300)));
  await page.goto(`${BASE_URL}/${QUERY}`);
  const step = async (what, fn) => { try { await fn(); } catch (err) {
    await page.screenshot({ path: join(OUT, `fail-${what}-${Date.now()}.png`) }).catch(() => {});
    throw new Error(`${what}: ${err.message}`);
  } };
  await step('store', () => page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__), null, { timeout: 60000 }));
  await step('file-input', () => page.locator('#file-input-open').waitFor({ state: 'attached', timeout: 60000 }));
  return page;
}

/** Open `files`, wait for full geometry + metadata in every model, return timings relative to the input event. */
async function openFiles(page, files, label) {
  const t0 = await page.evaluate(() => (globalThis.__benchT0 = performance.now()));
  await page.locator('#file-input-open').setInputFiles(files);
  const result = await page.waitForFunction((count) => {
    const trace = globalThis.__IFC_LITE_LOAD_TRACE__;
    const s = globalThis.__ifc_lite_viewer_store__?.getState();
    if (!trace || !s) return null;
    const loads = trace.loads().filter((l) => l.start >= globalThis.__benchT0 - 50);
    if (loads.length < count) return null;
    const end = (l, name) => l.spans.find((sp) => sp.name === name && sp.end !== null)?.end ?? null;
    // Full geometry = stream complete AND the GPU queue drained and finalized: the
    // `geometry.streamComplete` milestone fires before the upload drain and regroup.
    const DRAIN = /^(stream\.queueDrain|scene\.finalize.*|camera\.refit)$/;
    const geomDone = loads.map((l) => {
      const stream = end(l, 'geometry.streamComplete');
      if (stream === null || l.spans.some((sp) => DRAIN.test(sp.name) && sp.end === null)) return null;
      // A streamed load finalizes its fragments; a federated add uploads final batches directly.
      const streamed = l.spans.some((sp) => sp.name === 'stream.queue');
      if (streamed ? !l.spans.some((sp) => sp.name === 'scene.finalize' && sp.end !== null) : l.end === null) return null;
      return Math.max(stream, ...l.spans.filter((sp) => DRAIN.test(sp.name)).map((sp) => sp.end));
    });
    const meta = loads.map((l) => end(l, 'parser.complete') ?? end(l, 'cache.storeReady'));
    const models = [...(s.models?.values?.() ?? [])];
    const settled = !s.loading && models.length >= count && models.every((m) => m.loadState === 'complete' || m.loadState === undefined);
    if (geomDone.some((v) => v === null) || meta.some((v) => v === null) || !settled) return null;
    const firstVisible = loads.map((l) => end(l, 'geometry.firstVisible')).filter((v) => v !== null);
    const t = globalThis.__benchT0;
    return {
      firstFrameMs: firstVisible.length ? Math.min(...firstVisible) - t : null,
      geometryMs: Math.max(...geomDone) - t,
      propsMs: Math.max(...meta) - t,
      settledMs: performance.now() - t,
      loadPaths: loads.map((l) => l.attrs?.loadPath ?? l.attrs?.path ?? null),
      cacheHit: loads.map((l) => l.spans.some((sp) => sp.name === 'cache.lookup' && sp.attrs?.hit === true) || l.attrs?.loadPath === 'cache'),
      spans: loads.map((l) => l.spans.filter((sp) => sp.end !== null && sp.end - sp.start > 50)
        .map((sp) => ({ name: sp.name, startMs: Math.round(sp.start - t), ms: Math.round(sp.end - sp.start) }))),
    };
  }, files.length, { timeout: 45 * 60 * 1000, polling: 100 });
  const value = await result.jsonValue();
  log(`  ${label}: first frame ${fmt(value.firstFrameMs)} ms, geometry ${fmt(value.geometryMs)} ms, props ${fmt(value.propsMs)} ms (t0 ${t0.toFixed(0)})`);
  return value;
}

async function waitCacheWrites(page, timeoutMs = 10 * 60 * 1000) {
  // The cold load writes the IndexedDB cache beside the critical path; the warm open needs it complete.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await page.evaluate(() => globalThis.__IFC_LITE_LOAD_TRACE__.loads()
      .filter((l) => l.start >= globalThis.__benchT0 - 50)
      .some((l) => l.spans.some((sp) => sp.name.startsWith('cache.write') && sp.end === null)));
    if (!pending) return;
    await page.waitForTimeout(500);
  }
  log('  cache write still pending after timeout');
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

/** Wait for post-load background work (cache writes, source compaction) to end; returns its CPU seconds. */
async function settleCpu(profileDir, quietCores = 0.5, timeoutMs = 60_000) {
  const pids = chromePids(profileDir);
  const start = Date.now(), ticks0 = cpuTicks(pids);
  let last = ticks0, quiet = 0;
  while (quiet < 3 && Date.now() - start < timeoutMs) {
    await new Promise((res) => setTimeout(res, 500));
    const now = cpuTicks(pids);
    quiet = (now - last) / TICK / 0.5 < quietCores ? quiet + 1 : 0;
    last = now;
  }
  return { cpuSeconds: (last - ticks0) / TICK, wallMs: Date.now() - start };
}

/** Sample the graphics clock during `fn`. Timer queries move with DVFS, so ms alone do not compare across runs. */
async function withGpuClock(fn) {
  const child = spawn('nvidia-smi', ['--query-gpu=clocks.gr', '--format=csv,noheader,nounits', '-lms', '250'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let text = '';
  child.stdout.on('data', (d) => { text += d; });
  child.on('error', () => {});
  try { return { result: await fn(), mhz: () => {
    const v = text.split('\n').map(Number).filter((n) => n > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  } }; } finally { child.kill(); }
}

async function orbit(page, profileDir) {
  const settle = await settleCpu(profileDir);
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
    gpuClockMHz: clock.mhz(),
  };
  res.gpuMcyclesMean = res.gpuMsMean !== null && res.gpuClockMHz ? (res.gpuMsMean * res.gpuClockMHz) / 1000 : null;
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
  const profileDir = mkdtempSync(join(tmpdir(), 'scenoptic-bench-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: CHROME, headless: false, viewport: { width: W, height: H }, deviceScaleFactor: 1,
    args: ['--enable-gpu', '--enable-unsafe-webgpu', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan',
      '--use-angle=vulkan', '--ignore-gpu-blocklist', '--hide-scrollbars', '--no-first-run', `--window-size=${W},${H}`, '--window-position=0,0'],
  });
  const sample = { build: build.id, set: set.name, round, files: set.files.map((f) => basename(f)), bytes: set.bytes };
  try {
    await context.addInitScript(INIT);
    let page = await openPage(context);
    const tag = `${set.name}-${build.id}-r${round}`;
    sample.cold = await profiled(page, 'cold', tag, () => openFiles(page, set.files, `${build.id}/${set.name}#${round} cold`));
    sample.cold.memory = await sampleMemory(page, profileDir);
    sample.adapter = sample.cold.memory.adapter;
    log(`    memory: PSS ${fmt(sample.cold.memory.pssMiB)} MiB, RSS ${fmt(sample.cold.memory.rssMiB)} MiB, VRAM ${fmt(sample.cold.memory.vramMiB)} MiB`);
    if (!opt['no-warm']) {
      await waitCacheWrites(page);
      await page.close();
      page = await openPage(context);
      sample.warm = await profiled(page, 'warm', tag, () => openFiles(page, set.files, `${build.id}/${set.name}#${round} warm`));
      sample.warm.memory = await sampleMemory(page, profileDir);
      log(`    memory: PSS ${fmt(sample.warm.memory.pssMiB)} MiB, RSS ${fmt(sample.warm.memory.rssMiB)} MiB, VRAM ${fmt(sample.warm.memory.vramMiB)} MiB`);
    }
    if (!opt['no-orbit']) sample.orbit = await profiled(page, 'orbit', tag, () => orbit(page, profileDir));
  } catch (err) {
    sample.error = String(err?.stack ?? err);
    log('  sample failed:', String(err?.message ?? err).slice(0, 400));
  } finally {
    await context.close().catch(() => {});
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
  ['warm first frame ms', (s) => s.warm?.firstFrameMs], ['warm geometry ms', (s) => s.warm?.geometryMs], ['warm props ms', (s) => s.warm?.propsMs],
  ['warm PSS MiB', (s) => s.warm?.memory?.pssMiB], ['warm VRAM MiB', (s) => s.warm?.memory?.vramMiB],
  ['orbit fps', (s) => s.orbit?.fps], ['orbit GPU ms mean', (s) => s.orbit?.gpuMsMean], ['orbit GPU Mcycles', (s) => s.orbit?.gpuMcyclesMean], ['post-load CPU-s', (s) => s.orbit?.settleCpuSeconds], ['orbit CPU cores', (s) => s.orbit?.cpuCores],
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
    const digits = name.includes('GPU') || name.includes('cores') || name.includes('CPU-s') ? 2 : 0;
    const cells = vals.map((v, i) => i ? `${fmt(v, digits)} | ${vals[0] && v !== null ? (v / vals[0]).toFixed(2) : 'n/a'}` : fmt(v, digits));
    lines.push(`| ${set.name} | ${name} | ${cells.join(' | ')} |`);
  }
}
const failures = samples.filter((s) => s.error).length;
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ builds: BUILDS, sets: SETS, rounds: ROUNDS, failures, summary }, null, 2));
writeFileSync(join(OUT, 'summary.md'), lines.join('\n') + '\n');
console.log(`\nmedians over ${ROUNDS} round(s), ${failures} failed sample(s):\n` + lines.join('\n'));
process.exit(failures ? 1 : 0);
