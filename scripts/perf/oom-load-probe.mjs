#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Capped-memory load test (#10264): open one IFC file in the built viewer
 * inside a hard memory cap with no swap, on a browser that declares a given
 * device memory and core count, and report whether the load was `loaded`,
 * `refused` (the viewer showed a memory message) or `killed` (a Chrome process
 * was OOM-killed / crashed). Untimed; memory only.
 *
 * Only Chrome runs inside the cap: Playwright launches it through a wrapper
 * that `exec`s `systemd-run --user --scope -p MemoryMax=CAP -p MemorySwapMax=0`,
 * so every Chrome process (browser, renderer, GPU, utilities) is charged to
 * one cgroup v2 scope while this driver stays outside and survives the kill to
 * classify it. `OOMPolicy=continue` keeps the browser up when only the
 * renderer dies, like a real tab crash. Needs Linux, cgroup v2 and a systemd
 * user manager with the memory controller delegated; anything missing is a
 * hard error (exit 2), never a skip.
 *
 * Usage:
 *   node scripts/perf/oom-load-probe.mjs --dist apps/viewer/dist --expect killed|not-killed|loaded|refused
 *        (--fixture FILE.ifc | --kind tfs|brep --target-mb N [--seed 1])
 *        --cap 3G [--device-memory 4] [--cores 4] [--cpu-quota 400%]
 *        [--gl swiftshader|hardware] [--out DIR] [--limit-min 10] [--keep-fixture]
 *
 * `--gl hardware` launches headed Chrome on $DISPLAY with ANGLE/Vulkan (use a
 * private Xvfb; headless Chrome can lose a discrete GPU's device). Under
 * swiftshader (the default) GPU buffers live in CPU memory and count against
 * the cap, so sizes that reproduce differ between the two.
 *
 * Exit: 0 when the outcome matches --expect, 1 when it does not (including
 * `error`/`timeout`), 2 for usage or environment problems. Writes
 * OUT/result.json and OUT/samples.ndjson; prints one summary line.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { writeDenseIfc } from './gen-dense-ifc.mjs';
import { EXPECTATIONS, classify, parseSize, phaseOf, verdict } from './oom-load-probe-lib.mjs';
import { GPU_ARGS } from './retained-qual-browser.mjs';
import { chromePids, memoryOf } from './scenoptic-bench-sampling.mjs';
import { openAndWaitInteractive, openViewerPage, startViewerServer } from './viewer-load-probe.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const MiB = 2 ** 20;

class EnvError extends Error {}

function readKV(path) {
  const o = {};
  try { for (const l of readFileSync(path, 'utf8').split('\n')) { const [k, v] = l.split(' '); if (k) o[k] = Number(v); } } catch { /* scope gone */ }
  return o;
}
const readNum = (path) => { try { return Number(readFileSync(path, 'utf8')); } catch { return null; } };

/** Fail loudly unless a memory-capped, swapless user scope can actually be created here. */
export function preflight() {
  if (process.platform !== 'linux') throw new EnvError('needs Linux (cgroup v2 + systemd user manager)');
  if (!existsSync('/sys/fs/cgroup/cgroup.controllers')) throw new EnvError('needs the unified cgroup v2 hierarchy');
  const uid = process.getuid();
  const ctl = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.subtree_control`;
  let delegated = '';
  try { delegated = readFileSync(ctl, 'utf8'); } catch { /* reported below */ }
  if (!/\bmemory\b/.test(delegated)) throw new EnvError(`memory controller is not delegated to the user manager (${ctl})`);
  try {
    execFileSync('systemd-run', ['--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=64M', '-p', 'MemorySwapMax=0', 'true'], { stdio: 'pipe' });
  } catch (err) {
    throw new EnvError(`systemd-run --user --scope with MemoryMax failed: ${String(err.stderr ?? err.message).trim()}`);
  }
}

function cgroupOf(unit) {
  try {
    const rel = execFileSync('systemctl', ['--user', 'show', `${unit}.scope`, '-p', 'ControlGroup', '--value'], { encoding: 'utf8' }).trim();
    return rel ? `/sys/fs/cgroup${rel}` : null;
  } catch { return null; }
}
const scopeProp = (unit, prop) => {
  try { return execFileSync('systemctl', ['--user', 'show', `${unit}.scope`, '-p', prop, '--value'], { encoding: 'utf8' }).trim(); } catch { return null; }
};

/** In page: what the load has reached. */
const PAGE_PROBE = () => {
  const s = globalThis.__ifc_lite_viewer_store__?.getState();
  const models = [...(s?.models?.values?.() ?? [])];
  let tris = 0;
  for (const g of (models.length ? models.map((m) => m.geometryResult) : [s?.geometryResult])) tris += g?.totalTriangles ?? 0;
  const l = (globalThis.__IFC_LITE_LOAD_TRACE__?.loads?.() ?? []).at(-1);
  return { loading: s?.loading ?? null, error: s?.error ?? null, progress: s?.progress ?? null, tris,
    modelStates: models.map((m) => m.loadState ?? null),
    jsHeapMiB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null,
    openSpans: l ? l.spans.filter((sp) => sp.end === null).slice(0, 8).map((sp) => sp.name) : [] };
};

export async function runProbe(opts) {
  const outDir = opts.out ?? mkdtempSync(join(tmpdir(), 'oom-load-probe-'));
  mkdirSync(outDir, { recursive: true });
  const log = (o) => appendFileSync(join(outDir, 'samples.ndjson'), `${JSON.stringify(o)}\n`);
  const result = { tool: 'oom-load-probe', issue: 10264, expect: opts.expect, gl: opts.gl, capBytes: parseSize(opts.cap),
    cpuQuota: opts.cpuQuota, deviceMemory: opts.deviceMemory, cores: opts.cores, dist: opts.dist };

  let fixture = opts.fixture, generated = false;
  if (!fixture) {
    fixture = join(outDir, `${opts.kind}-${opts.targetMb}.ifc`);
    const t0 = Date.now();
    result.generator = writeDenseIfc(fixture, { kind: opts.kind, targetBytes: Math.round(opts.targetMb * 1e6), seed: opts.seed });
    result.generator.genSeconds = (Date.now() - t0) / 1000;
    generated = true;
  }
  result.fixtureBytes = statSync(fixture).size;

  const { chromium } = createRequire(join(ROOT, 'package.json'))('@playwright/test');
  const unit = `oom-load-probe-${process.pid}-${Date.now()}`;
  result.unit = unit;
  const launcher = join(outDir, 'chrome-capped.sh');
  writeFileSync(launcher, `#!/bin/sh\nexec systemd-run --user --scope --quiet --unit=${unit} -p MemoryMax=${result.capBytes} `
    + `-p MemorySwapMax=0 -p CPUQuota=${opts.cpuQuota} -p OOMPolicy=continue -- '${chromium.executablePath()}' "$@"\n`);
  chmodSync(launcher, 0o755);

  const { server, baseUrl } = await startViewerServer(() => resolve(opts.dist));
  const profileDir = mkdtempSync(join(tmpdir(), 'oom-load-probe-profile-'));
  const obs = { oomKills: 0, pageCrashed: false, browserGone: false, interactive: false, storeError: null, pageText: '', timedOut: false };
  const peak = { pssMiB: 0, cgroupMiB: 0 };
  let last = null, context, sampler, cg = null, verdictReady = false;
  try {
    context = await chromium.launchPersistentContext(profileDir, { executablePath: launcher, headless: opts.gl !== 'hardware',
      viewport: { width: 1600, height: 1000 }, args: [...GPU_ARGS[opts.gl], '--no-first-run', '--enable-precise-memory-info'] });
    context.on('close', () => { if (!verdictReady) obs.browserGone = true; });
    await context.addInitScript(({ dm, hc }) => {
      if (dm !== null) Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => dm, configurable: true });
      if (hc !== null) Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => hc, configurable: true });
    }, { dm: opts.deviceMemory, hc: opts.cores });
    cg = cgroupOf(unit);
    if (!cg) throw new EnvError(`Chrome did not start inside scope ${unit}`);
    const page = await openViewerPage(context, `${baseUrl}/?perfTrace=1&perfMem=1`);
    page.on('crash', () => { obs.pageCrashed = true; });
    result.navigator = await page.evaluate(() => ({ deviceMemory: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency }));
    const t0 = Date.now();
    sampler = setInterval(() => {
      const m = memoryOf(chromePids(profileDir));
      const cur = readNum(`${cg}/memory.current`);
      const ev = readKV(`${cg}/memory.events`);
      obs.oomKills = Math.max(obs.oomKills, ev.oom_kill ?? 0);
      peak.pssMiB = Math.max(peak.pssMiB, m.pssMiB);
      if (cur !== null) peak.cgroupMiB = Math.max(peak.cgroupMiB, cur / MiB);
      log({ t: (Date.now() - t0) / 1000, pssMiB: Math.round(m.pssMiB), cgroupMiB: cur === null ? null : Math.round(cur / MiB), oomKill: ev.oom_kill ?? null });
    }, 500);

    let done = false;
    const interactive = openAndWaitInteractive(page, [fixture], { timeoutMs: opts.limitMin * 60_000 })
      .then(() => { obs.interactive = true; }, (e) => { if (/timeout/i.test(String(e?.message))) obs.timedOut = true; result.waitError = String(e?.message ?? e).slice(0, 300); });
    const watch = (async () => {
      while (!done) {
        await new Promise((r) => setTimeout(r, 2000));
        if (done || obs.pageCrashed || obs.browserGone || obs.oomKills > 0) return;
        const st = await Promise.race([page.evaluate(PAGE_PROBE), new Promise((r) => setTimeout(() => r(null), 15000))]).catch(() => null);
        if (st) { last = st; log({ t: (Date.now() - t0) / 1000, page: st }); }
        if (st?.error || st?.modelStates?.includes('error')) { obs.storeError = st.error ?? 'model load error'; return; }
      }
    })();
    await Promise.race([interactive, watch]);
    done = true;
    result.wallSeconds = (Date.now() - t0) / 1000;
    await new Promise((r) => setTimeout(r, 1500)); // let a pending OOM kill / crash land before the verdict
    if (!obs.pageCrashed && !obs.browserGone) {
      obs.pageText = await Promise.race([page.evaluate(() => document.body?.innerText ?? ''), new Promise((r) => setTimeout(() => r(''), 5000))]).catch(() => '');
      if (obs.interactive) last = { ...(await page.evaluate(PAGE_PROBE).catch(() => last)), interactive: true };
      await page.screenshot({ path: join(outDir, 'end.png') }).catch(() => {});
    }
  } finally {
    clearInterval(sampler);
    if (cg) {
      obs.oomKills = Math.max(obs.oomKills, readKV(`${cg}/memory.events`).oom_kill ?? 0);
      const p = readNum(`${cg}/memory.peak`);
      if (p !== null) peak.cgroupMiB = Math.max(peak.cgroupMiB, p / MiB);
    }
    result.scopeResult = scopeProp(unit, 'Result');
    if (result.scopeResult === 'oom-kill' && obs.oomKills === 0) obs.oomKills = 1;
    verdictReady = true;
    await context?.close().catch(() => {});
    execFileSync('systemctl', ['--user', 'stop', `${unit}.scope`], { stdio: 'ignore' });
    try { execFileSync('systemctl', ['--user', 'reset-failed', `${unit}.scope`], { stdio: 'ignore' }); } catch { /* not failed */ }
    server.close();
    rmSync(profileDir, { recursive: true, force: true });
    if (generated && !opts.keepFixture) rmSync(fixture, { force: true });
  }
  Object.assign(result, classify(obs), { phase: phaseOf(last), last, peakPssMiB: Math.round(peak.pssMiB),
    peakCgroupMiB: Math.round(peak.cgroupMiB), oomKills: obs.oomKills });
  const v = verdict(result.outcome, opts.expect);
  Object.assign(result, { pass: v.pass, verdict: v.message });
  writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(result, null, 1)}\n`);
  return { result, outDir };
}

function cli() {
  const { values: v } = parseArgs({ options: {
    dist: { type: 'string' }, fixture: { type: 'string' }, kind: { type: 'string' }, 'target-mb': { type: 'string' },
    seed: { type: 'string' }, cap: { type: 'string' }, 'device-memory': { type: 'string' }, cores: { type: 'string' },
    'cpu-quota': { type: 'string' }, gl: { type: 'string' }, expect: { type: 'string' }, out: { type: 'string' },
    'limit-min': { type: 'string' }, 'keep-fixture': { type: 'boolean' },
  } });
  const fail = (m) => { console.error(`oom-load-probe: ${m}`); process.exit(2); };
  if (!v.dist || !existsSync(join(v.dist, 'index.html'))) fail('--dist must point at a built viewer (apps/viewer/dist)');
  if (!v.expect || !EXPECTATIONS[v.expect]) fail(`--expect is required: ${Object.keys(EXPECTATIONS).join(' | ')}`);
  if (!v.cap) fail('--cap is required (e.g. 3G)');
  if (!v.fixture && !(v.kind && v['target-mb'])) fail('give --fixture or --kind and --target-mb');
  const gl = v.gl ?? 'swiftshader';
  if (!GPU_ARGS[gl]) fail('--gl must be swiftshader or hardware');
  if (gl === 'hardware' && !process.env.DISPLAY) fail('--gl hardware needs a $DISPLAY (headed Chrome, e.g. a private Xvfb)');
  const cores = v.cores ? Number(v.cores) : null;
  const opts = { dist: resolve(v.dist), fixture: v.fixture && resolve(v.fixture), kind: v.kind, targetMb: Number(v['target-mb']),
    seed: v.seed ? Number(v.seed) : 1, cap: v.cap, deviceMemory: v['device-memory'] ? Number(v['device-memory']) : null, cores,
    cpuQuota: v['cpu-quota'] ?? `${(cores ?? 4) * 100}%`, gl, expect: v.expect, out: v.out && resolve(v.out),
    limitMin: Number(v['limit-min'] ?? 10), keepFixture: Boolean(v['keep-fixture']) };
  try { preflight(); } catch (err) { fail(err.message); }
  runProbe(opts).then(({ result, outDir }) => {
    console.log(`outcome=${result.outcome} phase="${result.phase}" peakPssMiB=${result.peakPssMiB} peakCgroupMiB=${result.peakCgroupMiB} `
      + `oomKills=${result.oomKills} reason="${result.reason}" -> ${result.verdict} [${outDir}/result.json]`);
    process.exit(result.pass ? 0 : 1);
  }, (err) => {
    console.error(`oom-load-probe: ${err instanceof EnvError ? '' : 'driver error: '}${err.stack ?? err}`);
    process.exit(err instanceof EnvError ? 2 : 1);
  });
}

if (isMainEntry(import.meta.url)) cli();
