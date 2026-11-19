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
 *        [--on-memory-dialog wait|cancel|continue]
 *
 * A viewer that warns before an oversized load (a dialog titled "... may exceed
 * available memory" with Continue loading / Cancel) is left waiting by default
 * (`awaiting-decision`); `cancel` clicks Cancel (`cancelled`), `continue` clicks
 * Continue loading and then reports `loaded` or `killed-after-continue`.
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
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { writeDenseIfc } from './gen-dense-ifc.mjs';
import { DIALOG_BUTTONS, GENERIC_MODEL_ERROR, MEMORY_WARNING, SERVER_FIRST, classify, expectFlags, mergeFinalSnapshot, optionErrors, parseSize, phaseOf, polledErrorEvent, runCleanup, sampleCpuGeometry, serverAttemptSummary, verdict, withTimeout } from './oom-load-probe-lib.mjs';
import { CPU_GEOMETRY_PROBE, DIALOG_MARKS, NOTICES, PAGE_PROBE } from './oom-load-probe-page.mjs';
import { installSourceTracker, trackerSummary } from './oom-load-probe-tracker.mjs';
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

/** Sample the walk every this many 2 s polls (it walks every mesh, so not every poll). */
const CPU_GEOMETRY_EVERY = 5;

/** Chrome process type of `pid` from its command line ('renderer', 'gpu-process', 'utility', 'browser'). */
function processType(pid) {
  try { return /--type=([a-z-]+)/.exec(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))?.[1] ?? 'browser'; } catch { return null; }
}

const scopeStop = (unit) => {
  // The scope ends on its own when Chrome exits; stop only a leftover one, then clear a failed record.
  if (scopeProp(unit, 'ActiveState') === 'active') execFileSync('systemctl', ['--user', 'stop', `${unit}.scope`], { stdio: 'ignore' });
  if (scopeProp(unit, 'ActiveState') === 'failed') execFileSync('systemctl', ['--user', 'reset-failed', `${unit}.scope`], { stdio: 'ignore' });
};

export async function runProbe(opts) {
  const outDir = opts.out ?? mkdtempSync(join(tmpdir(), 'oom-load-probe-'));
  mkdirSync(outDir, { recursive: true });
  rmSync(join(outDir, 'result.json'), { force: true });
  writeFileSync(join(outDir, 'samples.ndjson'), '');
  const log = (o) => appendFileSync(join(outDir, 'samples.ndjson'), `${JSON.stringify(o)}\n`);
  const result = { tool: 'oom-load-probe', issue: 10264, expect: opts.expect, gl: opts.gl, capBytes: parseSize(opts.cap),
    cpuQuota: opts.cpuQuota, deviceMemory: opts.deviceMemory, cores: opts.cores, dist: relative(ROOT, opts.dist) || '.' };
  const cleanup = [];
  const finish = async () => { const f = await runCleanup(cleanup); if (f.length) result.cleanupFailures = (result.cleanupFailures ?? []).concat(f); };
  const onSignal = (sig) => { finish().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  cleanup.push({ name: 'signal handlers', fn: () => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); } });

  const obs = { oomKills: 0, killedTypes: [], killEvents: [], pageCrashed: false, pageClosed: false, browserGone: false, interactive: false, storeError: null, notices: [],
    timedOut: false, warningShown: false, decision: 'none' };
  const peak = { pssMiB: 0, cgroupMiB: 0 };
  const unit = `oom-load-probe-${process.pid}-${Date.now()}`;
  let last = null, context, sampler, cg = null, verdictReady = false, pickAt = null, dialogs = [], trackerReport = null;
  let lastPssMiB = null, polls = 0;
  const netEvents = [], storeErrors = [];
  const watchOrigin = opts.watchUrl ? new URL(opts.watchUrl).origin : null;
  try {
    let fixture = opts.fixture;
    if (!fixture) {
      fixture = join(outDir, `${opts.kind}-${opts.targetMb}.ifc`);
      if (!opts.keepFixture) cleanup.push({ name: 'fixture', fn: () => rmSync(fixture, { force: true }) });
      const t0 = Date.now();
      const stats = writeDenseIfc(fixture, { kind: opts.kind, targetBytes: Math.round(opts.targetMb * 1e6), seed: opts.seed });
      delete stats.out; // absolute local path; result.fixture keeps the base name
      result.generator = { ...stats, genSeconds: (Date.now() - t0) / 1000 };
    }
    result.fixture = basename(fixture);
    result.fixtureBytes = statSync(fixture).size;

    const { chromium } = createRequire(join(ROOT, 'package.json'))('@playwright/test');
    result.unit = unit;
    const launcher = join(outDir, 'chrome-capped.sh');
    // Only validated numbers reach the script; the Chrome path arrives through the environment.
    writeFileSync(launcher, `#!/bin/sh\nexec systemd-run --user --scope --quiet --unit=${unit} -p MemoryMax=${result.capBytes} `
      + `-p MemorySwapMax=0 -p CPUQuota=${opts.cpuQuota} -p OOMPolicy=continue -- "$OOM_PROBE_CHROME" "$@"\n`);
    chmodSync(launcher, 0o755);
    const { server, baseUrl } = await startViewerServer(() => opts.dist);
    cleanup.push({ name: 'server', fn: () => server.close() });
    const profileDir = mkdtempSync(join(tmpdir(), 'oom-load-probe-profile-'));
    cleanup.push({ name: 'profile dir', fn: () => rmSync(profileDir, { recursive: true, force: true }) });
    cleanup.push({ name: 'scope', fn: () => scopeStop(unit) });

    context = await chromium.launchPersistentContext(profileDir, { executablePath: launcher, headless: opts.gl !== 'hardware',
      env: { ...process.env, OOM_PROBE_CHROME: chromium.executablePath() },
      viewport: { width: 1600, height: 1000 }, args: [...GPU_ARGS[opts.gl], '--no-first-run', '--enable-precise-memory-info'] });
    cleanup.push({ name: 'browser', fn: () => withTimeout(context.close(), 10_000, () => scopeStop(unit)) });
    context.on('close', () => { if (!verdictReady) obs.browserGone = true; });
    await context.addInitScript(({ dm, hc }) => {
      if (dm !== null) Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => dm, configurable: true });
      if (hc !== null) Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => hc, configurable: true });
    }, { dm: opts.deviceMemory, hc: opts.cores });
    // Source identity, reads and worker posts (oom-load-probe-tracker.mjs), injected as source text.
    await context.addInitScript({ content: `(${installSourceTracker})({ Blob, FileReader, Worker: globalThis.Worker, MessagePort: globalThis.MessagePort, BroadcastChannel: globalThis.BroadcastChannel, URL, XMLHttpRequest, target: globalThis, document, now: Date.now, watchOrigin: ${JSON.stringify(watchOrigin)} });` });
    await context.addInitScript(DIALOG_MARKS);
    if (watchOrigin) {
      const sameOrigin = (url) => { try { return new URL(url).origin === watchOrigin; } catch { return false; } };
      // Driver-side view (its own clock): kept for the browser's error code, never used for order.
      const net = (event, extra) => (r) => { if (sameOrigin(r.url())) netEvents.push({ t: Date.now(), event, url: r.url(), clock: 'driver', ...extra(r) }); };
      context.on('request', net('driver-request', (r) => ({ method: r.method() })));
      context.on('requestfailed', net('driver-requestfailed', (r) => ({ failure: r.failure()?.errorText ?? null })));
      context.on('response', (res) => net('driver-response', () => ({ status: res.status() }))(res.request()));
    }
    cg = cgroupOf(unit);
    if (!cg) throw new EnvError(`Chrome did not start inside scope ${unit}`);
    const page = await openViewerPage(context, `${baseUrl}/?perfTrace=1&perfMem=1`);
    // Tab death is decided only from evidence about this page: its renderer crashed ('crash' is raised
    // when this page's renderer process dies), the page closed, or the browser exited. CDP exposes no
    // target-to-pid mapping (TargetInfo has no pid), so vanished process TYPES never decide it.
    page.on('crash', () => { obs.pageCrashed = true; });
    page.on('close', () => { if (!verdictReady) obs.pageClosed = true; });
    result.navigator = await page.evaluate(() => ({ deviceMemory: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency }));
    const t0 = Date.now();
    let types = new Map();
    sampler = setInterval(() => {
      const pids = chromePids(profileDir);
      const now = new Map(pids.map((pid) => [pid, types.get(pid) ?? processType(pid)]));
      const m = memoryOf(pids);
      const cur = readNum(`${cg}/memory.current`);
      const ev = readKV(`${cg}/memory.events`);
      const kills = ev.oom_kill ?? 0;
      if (kills > obs.oomKills) {
        // One event per counter increase: how many kills it added and which processes vanished in
        // this interval. A kill is identified only by a process that vanished in its own interval.
        const vanished = [...types].filter(([pid, type]) => !now.has(pid) && type).map(([, type]) => type);
        obs.killEvents.push({ t: (Date.now() - t0) / 1000, added: kills - obs.oomKills, types: vanished });
        obs.killedTypes.push(...vanished);
        obs.oomKills = kills;
      }
      types = now;
      peak.pssMiB = Math.max(peak.pssMiB, m.pssMiB);
      lastPssMiB = m.pssMiB;
      if (cur !== null) peak.cgroupMiB = Math.max(peak.cgroupMiB, cur / MiB);
      log({ t: (Date.now() - t0) / 1000, pssMiB: Math.round(m.pssMiB), cgroupMiB: cur === null ? null : Math.round(cur / MiB), oomKill: kills });
    }, 500);
    cleanup.push({ name: 'sampler', fn: () => clearInterval(sampler) });

    let done = false, previousPollReadAt = null;
    pickAt = Date.now();
    const interactive = openAndWaitInteractive(page, [fixture], { timeoutMs: opts.limitMin * 60_000 })
      .then(() => { obs.interactive = true; }, (e) => { if (/timeout/i.test(String(e?.message))) obs.timedOut = true; result.waitError = String(e?.message ?? e).slice(0, 300); });
    const watch = (async () => {
      while (!done) {
        await new Promise((r) => setTimeout(r, 2000));
        // Stop at a tab death (crash, close, browser exit). An OOM kill of any other process, identified
        // or not, does not end the load: keep watching until interactive, a tab death or the limit.
        if (done || obs.pageCrashed || obs.pageClosed || obs.browserGone) return;
        const st = await withTimeout(page.evaluate(PAGE_PROBE).catch(() => null), 15000, () => null);
        const previousReadAt = previousPollReadAt;
        if (st) previousPollReadAt = st.readAt;
        if (st) { last = st; log({ t: (Date.now() - t0) / 1000, page: st }); }
        if (st && ++polls % CPU_GEOMETRY_EVERY === 0) {
          const measurement = await sampleCpuGeometry(() => page.evaluate(CPU_GEOMETRY_PROBE), st.tris, 15000);
          log({ t: (Date.now() - t0) / 1000, cpuGeometryMeasurement: measurement.status,
            ...(measurement.held ? { cpuGeometryHeld: measurement.held } : { diagnosticError: measurement.error }),
            pssMiB: lastPssMiB === null ? null : Math.round(lastPssMiB) });
        }
        if (st?.error || st?.modelStates?.includes('error')) { obs.storeError = st.error ?? GENERIC_MODEL_ERROR; storeErrors.push({ readAt: st.readAt, previousReadAt, text: obs.storeError }); return; }
        if (obs.decision === 'none') {
          // CSS role selectors, not getByRole: when another layer (e.g. a privacy banner) is open the
          // dialog's container can be aria-hidden, which hides it from getByRole although it is on screen.
          const dialog = page.locator('[role=dialog],[role=alertdialog]').filter({ hasText: MEMORY_WARNING });
          if (await dialog.count().catch(() => 0)) {
            obs.warningShown = true;
            result.memoryWarning = { text: (await dialog.first().innerText().catch(() => '')).slice(0, 500), trisBefore: st?.tris ?? null };
            last = { ...(st ?? {}), warning: true };
            if (opts.onMemoryDialog === 'wait') return;
            await dialog.first().locator('button').filter({ hasText: DIALOG_BUTTONS[opts.onMemoryDialog] }).first().click({ timeout: 10000 });
            obs.decision = opts.onMemoryDialog;
            log({ t: (Date.now() - t0) / 1000, clicked: opts.onMemoryDialog });
            if (opts.onMemoryDialog === 'cancel') { await new Promise((r) => setTimeout(r, 3000)); return; }
          }
        }
      }
    })();
    await Promise.race([interactive, watch]);
    done = true;
    result.wallSeconds = (Date.now() - t0) / 1000;
    await new Promise((r) => setTimeout(r, 1500)); // let a pending OOM kill / crash land before the verdict
    if (!obs.pageCrashed && !obs.pageClosed && !obs.browserGone) {
      // One final observation on every exit path (interactive, rejection, timeout, poll stop):
      // the 2 s poll is only a progress sampler, never the source of the verdict.
      const st = await withTimeout(page.evaluate(PAGE_PROBE).catch(() => null), 5000, () => null);
      if (st) { last = { ...last, ...st }; log({ t: (Date.now() - t0) / 1000, final: st }); }
      const warningLocator = page.locator('[role=dialog],[role=alertdialog]').filter({ hasText: MEMORY_WARNING });
      const warningVisible = obs.decision === 'none' && (await warningLocator.count().catch(() => 0)) > 0;
      if (warningVisible && !result.memoryWarning) {
        result.memoryWarning = { text: (await warningLocator.first().innerText().catch(() => '')).slice(0, 500), trisBefore: st?.tris ?? null };
        last = { ...last, warning: true };
      }
      const notices = await withTimeout(page.evaluate(NOTICES).catch(() => null), 5000, () => null);
      Object.assign(obs, mergeFinalSnapshot(obs, st ? { error: st.error, modelStates: st.modelStates, warningVisible, notices } : (notices ? { notices } : null)));
      dialogs = await withTimeout(page.evaluate(() => globalThis.__oomProbeDialogs ?? []).catch(() => []), 5000, () => []);
      trackerReport = await withTimeout(page.evaluate(() => globalThis.__oomProbeTracker?.report() ?? null).catch(() => null), 5000, () => null);
      if (obs.interactive) last = { ...(await withTimeout(page.evaluate(PAGE_PROBE).catch(() => last), 5000, () => last)), interactive: true };
      if (obs.interactive) {
        // Settled figure next to summed process memory: a few sampler ticks after interactive so PSS reflects it.
        await new Promise((r) => setTimeout(r, 3000));
        const measurement = await sampleCpuGeometry(() => page.evaluate(CPU_GEOMETRY_PROBE), last?.tris ?? 0, 30000);
        result.cpuGeometryMeasurement = measurement.status;
        if (measurement.error) result.cpuGeometryError = measurement.error;
        log({ t: (Date.now() - t0) / 1000, settled: true, cpuGeometryMeasurement: measurement.status, diagnosticError: measurement.error });
        const held = measurement.held;
        if (held) {
          result.cpuGeometryHeld = { ...held, settledPssMiB: lastPssMiB === null ? null : Math.round(lastPssMiB) };
          log({ t: (Date.now() - t0) / 1000, settled: true, cpuGeometryHeld: result.cpuGeometryHeld });
        }
      }
      await page.screenshot({ path: join(outDir, 'end.png'), timeout: 10000 }).catch(() => {});
    }
  } finally {
    clearInterval(sampler);
    if (cg) {
      // Kills the sampler never saw as an event stay unidentified (oomAccounting counts them).
      obs.oomKills = Math.max(obs.oomKills, readKV(`${cg}/memory.events`).oom_kill ?? 0);
      const p = readNum(`${cg}/memory.peak`);
      if (p !== null) peak.cgroupMiB = Math.max(peak.cgroupMiB, p / MiB);
    }
    result.scopeResult = scopeProp(unit, 'Result');
    if (result.scopeResult === 'oom-kill' && obs.oomKills === 0) obs.oomKills = 1;
    verdictReady = true;
    await finish();
  }
  result.memoryDialogPolicy = opts.onMemoryDialog;
  result.memoryDialogDecision = obs.decision;
  result.notices = obs.notices;
  if (pickAt !== null) {
    // The page's own pick stamp (tracker) is the time origin; the driver's call time only as fallback.
    const tracked = trackerSummary(trackerReport, pickAt);
    const origin = tracked.pickKnown ? tracked.pickAt : pickAt;
    const ms = (t) => t - origin;
    result.driverCallToPickMs = tracked.pickKnown ? tracked.pickAt - pickAt : null;
    const { events: trackedEvents, ...trackedCounts } = tracked;
    result.sourceTracking = trackedCounts;
    result.timeline = [
      ...netEvents.map(({ t, ...e }) => ({ ms: ms(t), ...e })),
      ...dialogs.map((d) => ({ ms: ms(d.t), event: d.kind ?? 'dialog', text: d.text })),
      // Page-clock read bounds include delayed evaluation and sampling between polls.
      ...storeErrors.map((e) => polledErrorEvent(e, origin)),
      ...trackedEvents,
    ].sort((a, b) => a.ms - b.ms);
    result.serverAttempts = serverAttemptSummary(result.timeline, { watching: Boolean(watchOrigin), tracker: tracked });
  }
  Object.assign(result, classify(obs), { phase: phaseOf(last), last, peakPssMiB: Math.round(peak.pssMiB),
    peakCgroupMiB: Math.round(peak.cgroupMiB), oomKills: obs.oomKills, killedTypes: obs.killedTypes, killEvents: obs.killEvents });
  const v = verdict(result.outcome, opts.expect);
  Object.assign(result, { pass: v.pass, verdict: v.message });
  if (opts.expectServerFirst) {
    const f = expectFlags(result.serverAttempts, SERVER_FIRST);
    Object.assign(result, { pass: result.pass && f.pass, verdict: `${result.verdict}; ${f.message}` });
  }
  writeFileSync(join(outDir, 'result.json'), `${JSON.stringify(result, null, 1)}\n`);
  return { result, outDir };
}

function cli() {
  const { values: v } = parseArgs({ options: {
    dist: { type: 'string' }, fixture: { type: 'string' }, kind: { type: 'string' }, 'target-mb': { type: 'string' },
    seed: { type: 'string' }, cap: { type: 'string' }, 'device-memory': { type: 'string' }, cores: { type: 'string' },
    'cpu-quota': { type: 'string' }, gl: { type: 'string' }, expect: { type: 'string' }, out: { type: 'string' },
    'limit-min': { type: 'string' }, 'keep-fixture': { type: 'boolean' }, 'on-memory-dialog': { type: 'string' },
    'watch-url': { type: 'string' }, 'expect-server-first': { type: 'boolean' },
  } });
  const fail = (m) => { console.error(`oom-load-probe: ${m}`); process.exit(2); };
  if (!v.dist || !existsSync(join(v.dist, 'index.html'))) fail('--dist must point at a built viewer (apps/viewer/dist)');
  const errors = optionErrors(v);
  if (errors.length) fail(errors.join('; '));
  const gl = v.gl ?? 'swiftshader';
  if (gl === 'hardware' && !process.env.DISPLAY) fail('--gl hardware needs a $DISPLAY (headed Chrome, e.g. a private Xvfb)');
  if (v.fixture && !existsSync(v.fixture)) fail(`--fixture ${v.fixture} does not exist`);
  const cores = v.cores ? Number(v.cores) : null;
  const opts = { dist: resolve(v.dist), fixture: v.fixture && resolve(v.fixture), kind: v.kind, targetMb: Number(v['target-mb']),
    seed: v.seed ? Number(v.seed) : 1, cap: v.cap, deviceMemory: v['device-memory'] ? Number(v['device-memory']) : null, cores,
    cpuQuota: v['cpu-quota'] ?? `${(cores ?? 4) * 100}%`, gl, expect: v.expect, out: v.out && resolve(v.out),
    limitMin: Number(v['limit-min'] ?? 10), keepFixture: Boolean(v['keep-fixture']), onMemoryDialog: v['on-memory-dialog'] ?? 'wait',
    watchUrl: v['watch-url'], expectServerFirst: Boolean(v['expect-server-first']) };
  if (opts.expectServerFirst && !opts.watchUrl) fail('--expect-server-first needs --watch-url');
  try { preflight(); } catch (err) { fail(err.message); }
  runProbe(opts).then(({ result, outDir }) => {
    console.log(`outcome=${result.outcome} phase="${result.phase}" peakPssMiB=${result.peakPssMiB} peakCgroupMiB=${result.peakCgroupMiB} `
      + `oomKills=${result.oomKills} sourceTracking=${JSON.stringify(result.sourceTracking ?? null)} reason="${result.reason}" `
      + `${result.serverAttempts?.watched ? `server=${JSON.stringify(result.serverAttempts)} ` : ''}-> ${result.verdict} [${outDir}/result.json]`);
    if (result.cleanupFailures) console.error(`oom-load-probe: cleanup failures: ${result.cleanupFailures.join('; ')}`);
    process.exit(result.pass ? 0 : 1);
  }, (err) => {
    console.error(`oom-load-probe: ${err instanceof EnvError ? '' : 'driver error: '}${err.stack ?? err}`);
    process.exit(err instanceof EnvError ? 2 : 1);
  });
}

if (isMainEntry(import.meta.url)) cli();
