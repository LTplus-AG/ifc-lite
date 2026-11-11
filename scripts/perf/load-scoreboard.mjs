#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC load-time scoreboard: one table per fixture and lane (native-cold,
 * browser-cold, browser-warm) with time to first geometry, time to fully
 * interactive, peak memory, per-stage shares, median and spread, output
 * fingerprints and a base-vs-branch verdict (gain >= 2x noise floor). See
 * the "Load scoreboard" section of scripts/perf/README.md.
 *
 *   node scripts/perf/load-scoreboard.mjs run --plan plan.json --out DIR [--fixtures a,b] [--resume] [--aa-reference aa/report.json]
 *   node scripts/perf/load-scoreboard.mjs report --plan plan.json --out DIR [--aa-reference aa/report.json]
 *
 * It drives existing tools: `perf_probe --cold` for native, and the viewer
 * readiness shared with scenoptic-bench (viewer-load-probe.mjs) for browser.
 * Builds are prepared beforehand (see the README); this script compiles
 * nothing. Timings are evidence only inside exclusive benchmark admission
 * (IFC_WORKER_KIND=benchmark); otherwise the report says it is a dry run.
 * Not a CI gate.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundOrder, seededRand } from './ab-order.mjs';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { nativeSample } from './load-scoreboard-native.mjs';
import { BOOT_FIXTURE, BROWSER_LANES, LANES, elementsFileFor, renderMarkdown, summarize } from './load-scoreboard-report.mjs';
import { browserShares, diffElements, uiQuietValue } from './load-scoreboard-stats.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opt = { command };
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    if (key === 'resume') { opt.resume = true; continue; }
    opt[key] = rest[++i];
  }
  return opt;
}

/** Validate and normalize a plan; throws on anything that would make the table ambiguous. */
export function loadPlan(path) {
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  plan.lanes ??= LANES;
  for (const lane of plan.lanes) if (!LANES.includes(lane)) throw new Error(`unknown lane ${lane}`);
  if (!Number.isInteger(plan.rounds) || plan.rounds < 1) throw new Error('plan.rounds must be a positive integer');
  plan.seed ??= Date.now() % 2 ** 31;
  plan.warmOpens ??= plan.lanes.includes('browser-warm') ? 2 : 0;
  for (const side of ['base', 'branch']) {
    const s = plan.sides?.[side];
    if (!s?.label) throw new Error(`plan.sides.${side}.label is required`);
    if (plan.lanes.includes('native-cold') && !existsSync(s.perfProbe ?? '')) throw new Error(`plan.sides.${side}.perfProbe missing: ${s.perfProbe}`);
    if (plan.lanes.some((l) => l.startsWith('browser') || l === 'boot') && !existsSync(join(s.dist ?? '', 'index.html'))) throw new Error(`plan.sides.${side}.dist has no index.html: ${s.dist}`);
  }
  if (plan.sides.base.label === plan.sides.branch.label) throw new Error('base and branch labels must differ (an A/A run labels its copies, e.g. main-A / main-B)');
  const names = new Set();
  for (const f of plan.fixtures ?? []) {
    if (names.has(f.name)) throw new Error(`fixture name ${f.name} repeats`);
    names.add(f.name);
    if (!existsSync(f.path)) throw new Error(`fixture missing: ${f.path}`);
    f.bytes = statSync(f.path).size;
    f.set ??= 'tuning';
  }
  if (names.size === 0) throw new Error('plan.fixtures is empty');
  return plan;
}

function readText(path) { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } }
function tryExec(cmd, args) { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10000 }).trim(); } catch { return null; } }

export function hostSnapshot() {
  return {
    at: new Date().toISOString(), hostname: hostname(), loadavg: loadavg(),
    powerProfile: tryExec('system76-power', ['profile'])?.split('\n')[0]?.replace('Power Profile: ', '') ?? null,
    scalingMaxFreqKHz: Number(readText('/sys/devices/system/cpu/cpufreq/policy0/scaling_max_freq')) || null,
    noTurbo: readText('/sys/devices/system/cpu/intel_pstate/no_turbo'),
    gpu: tryExec('nvidia-smi', ['--query-gpu=name,driver_version,pstate,clocks.gr,temperature.gpu', '--format=csv,noheader']),
  };
}

const BUILDERS = new Set(['cargo', 'rustc', 'rust-lld', 'cc1', 'cc1plus', 'wasm-opt', 'wasm-pack', 'turbo', 'pnpm', 'tsc']);
function cpuPressure10() { return Number(/some avg10=([\d.]+)/.exec(readText('/proc/pressure/cpu') ?? '')?.[1] ?? NaN); }
function foreignBuilders() {
  const out = [];
  for (const pid of readdirSync('/proc').filter((e) => /^\d+$/.test(e))) {
    const name = readText(`/proc/${pid}/comm`);
    if (name && BUILDERS.has(name)) out.push(name);
  }
  return out;
}

/** H9: before each sample, wait (at most 20 s) for CPU pressure avg10 < 5; flag the sample if the host stays busy. */
export async function hostQuiet({ limit = 5, maxWaitMs = 20000 } = {}) {
  const started = Date.now();
  let psi = cpuPressure10();
  while (!(psi < limit) && Date.now() - started < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 1000));
    psi = cpuPressure10();
  }
  const builders = foreignBuilders();
  return { cpuPressureAvg10: psi, waitedMs: Date.now() - started, builders, underLoad: !(psi < limit) || builders.length > 0 };
}

/** Balanced, randomized first-side order per lane group and fixture (ab-order.mjs), reproducible from the seed. */
export function buildOrder(plan) {
  const rand = seededRand(plan.seed);
  const groups = [];
  if (plan.lanes.includes('native-cold')) groups.push('native');
  if (plan.lanes.some((l) => l.startsWith('browser'))) groups.push('browser');
  const order = {};
  for (const g of groups) for (const f of plan.fixtures) (order[g] ??= {})[f.name] = roundOrder(plan.rounds, rand);
  // The boot lane opens no file: one pair per round, under its pseudo-fixture.
  if (plan.lanes.includes('boot')) order.boot = { [BOOT_FIXTURE]: roundOrder(plan.rounds, rand) };
  return order;
}

async function run(opt) {
  const plan = loadPlan(opt.plan);
  const out = resolve(opt.out);
  mkdirSync(join(out, 'traces'), { recursive: true });
  const samplesPath = join(out, 'samples.jsonl');
  const done = new Set();
  if (existsSync(samplesPath)) {
    if (!opt.resume) throw new Error(`${samplesPath} exists; pass --resume to continue it, or choose a new --out`);
    for (const line of readFileSync(samplesPath, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      done.add(`${r.group}/${r.fixture}/${r.round}/${r.side}`);
    }
  }
  const order = existsSync(join(out, 'order.json')) ? JSON.parse(readFileSync(join(out, 'order.json'), 'utf8')) : buildOrder(plan);
  writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeFileSync(join(out, 'order.json'), JSON.stringify(order, null, 2) + '\n');
  const host = { start: hostSnapshot(), workerKind: process.env.IFC_WORKER_KIND ?? null, workerJobId: process.env.IFC_WORKER_JOB_ID ?? null,
    node: process.version, resumed: Boolean(opt.resume) };
  host.timedEvidence = host.workerKind === 'benchmark';
  if (!host.timedEvidence) log('WARNING: not inside exclusive benchmark admission; timings are a dry run, not evidence');
  const hostPath = join(out, 'host.json');
  const previous = existsSync(hostPath) ? JSON.parse(readFileSync(hostPath, 'utf8')) : null;
  host.segments = [...(previous?.segments ?? []), { start: host.start, workerKind: host.workerKind, workerJobId: host.workerJobId, fixtures: opt.fixtures ?? 'all' }];
  host.timedEvidence = host.segments.every((seg) => seg.workerKind === 'benchmark');
  writeFileSync(hostPath, JSON.stringify(host, null, 2) + '\n');

  let browser = null;
  if (order.browser || order.boot) browser = await startBrowserLane(plan, out);
  const record = (row, trace) => {
    if (trace) { writeFileSync(join(out, 'traces', `${row.fixture}-${row.lane}-${row.side}-r${row.round}.json`), JSON.stringify(trace)); }
    appendFileSync(samplesPath, JSON.stringify(row) + '\n');
  };
  try {
    // --fixtures a,b runs a subset into the same result set (bounded exclusive jobs); --resume continues it.
    const only = opt.fixtures ? new Set(opt.fixtures.split(',')) : null;
    for (const name of only ?? []) if (!plan.fixtures.some((f) => f.name === name)) throw new Error(`--fixtures: ${name} is not in the plan`);
    const DEFAULT_BROWSER = ['browser-cold', 'browser-warm1', 'browser-warm'];
    for (let round = 0; round < plan.rounds; round++) {
      for (const side of order.boot?.[BOOT_FIXTURE][round] ?? []) {
        if (only || done.has(`boot/${BOOT_FIXTURE}/${round}/${side}`)) continue;
        const common = { group: 'boot', fixture: BOOT_FIXTURE, round, side, sideLabel: plan.sides[side].label, at: new Date().toISOString(),
          loadavg1: loadavg()[0], host: await hostQuiet() };
        log(`boot ${side}-r${round}`);
        record({ ...common, ...(await browser.boot({ side: plan.sides[side], tag: `boot-${side}-r${round}` })) }, null);
      }
      for (const fixture of plan.fixtures.filter((f) => !only || only.has(f.name))) {
        for (const group of Object.keys(order).filter((g) => g !== 'boot')) {
          for (const side of order[group][fixture.name][round]) {
            if (done.has(`${group}/${fixture.name}/${round}/${side}`)) continue;
            const common = { group, fixture: fixture.name, round, side, sideLabel: plan.sides[side].label, at: new Date().toISOString(),
              loadavg1: loadavg()[0], host: await hostQuiet() };
            const tag = `${fixture.name}-${side}-r${round}`;
            log(`${group} ${tag}`);
            if (group === 'native') {
              const s = await nativeSample({ side: plan.sides[side], fixture });
              const { probe, ...row } = s;
              record({ ...common, ...row, probe }, null);
              log(`  ${tag} native: ${s.ok ? `${s.interactiveMs.toFixed(0)} ms, ${s.peakMemoryMiB?.toFixed(0)} MiB` : `FAILED ${s.error}`}`);
            } else {
              // browser-cold-early: its own fresh browser, file picked at first paint, timing only (load-scoreboard-lanes.mjs).
              if (plan.lanes.includes('browser-cold-early')) {
                const e = await browser.sample({ side: plan.sides[side], fixture, tag: `${tag}-early`, warmOpens: 0, pass: 'timing', arm: 'first-paint' });
                const { trace, ...row } = e.lanes['browser-cold-early'];
                record({ ...common, ...row, lane: 'browser-cold-early', adapter: e.meta.adapter ? JSON.stringify(e.meta.adapter) : null,
                  browserVersion: e.meta.browserVersion ?? null, pageErrors: e.meta.pageErrors.length, gpuHealth: e.meta.gpuHealthCold ?? null }, trace ?? null);
              }
              if (!plan.lanes.some((l) => DEFAULT_BROWSER.includes(l))) continue;
              const s = await browser.sample({ side: plan.sides[side], fixture, tag, warmOpens: plan.warmOpens, pass: 'timing' });
              // H3: peak memory comes from a separate pass with the sampler on, never from the timed opens.
              const m = plan.memoryPass === false ? null : await browser.sample({ side: plan.sides[side], fixture, tag: `${tag}-mem`, warmOpens: plan.warmOpens, pass: 'memory' });
              const adapter = s.meta.adapter ? JSON.stringify(s.meta.adapter) : null;
              for (const [lane, r] of Object.entries(s.lanes)) {
                if (!plan.lanes.includes(lane)) continue;
                const { trace, ...row } = r;
                const mem = m?.lanes[lane];
                record({ ...common, ...row, lane, adapter, browserVersion: s.meta.browserVersion ?? null, pageErrors: s.meta.pageErrors.length,
                  peakMemoryMiB: mem?.ok ? mem.peakMemoryMiB : null, memoryPass: mem ? { ok: mem.ok, error: mem.error, memory: mem.memory,
                    interactiveMs: mem.interactiveMs, adapter: m.meta.adapter ?? null } : null,
                  gpuHealth: lane === 'browser-cold' ? s.meta.gpuHealthCold ?? null : s.meta.gpuHealth ?? null,
                  // What the reopens were prepared with (null when the sample never got that far).
                  cacheWriteSettled: s.meta.cacheWriteSettled ?? null, snapshotExpected: s.meta.snapshotExpected ?? null, snapshotWritten: s.meta.snapshotWritten ?? null,
                  warmOpens: lane === 'browser-warm' ? s.warmOpens : undefined }, trace ?? null);
              }
            }
          }
        }
      }
    }
  } finally {
    await browser?.close();
    host.end = hostSnapshot();
    host.powerProfile = { start: host.start.powerProfile, end: host.end.powerProfile };
    host.scalingMaxFreqKHz = { start: host.start.scalingMaxFreqKHz, end: host.end.scalingMaxFreqKHz };
    host.hostname = host.start.hostname;
    host.segments.at(-1).end = host.end;
    writeFileSync(hostPath, JSON.stringify(host, null, 2) + '\n');
  }
  return report({ ...opt, plan: join(out, 'plan.json') });
}

async function startBrowserLane(plan, out) {
  const display = process.env.DISPLAY;
  if (!display || display === ':0' || display === ':1') throw new Error('browser lanes run headed: set DISPLAY to a private Xvfb (e.g. :97), never the desktop');
  const { CHROME_ARGS, NVIDIA_ICD, browserSample, loadPlaywright } = await import('./load-scoreboard-browser.mjs');
  const { COUNT_FRAMES, openViewerPage, startViewerServer } = await import('./viewer-load-probe.mjs');
  const { BOOT_OBSERVERS } = await import('./viewer-load-boot.mjs');
  const { bootSample } = await import('./load-scoreboard-lanes.mjs');
  const { chromium } = loadPlaywright(ROOT);
  const executablePath = process.env.CHROME ?? plan.chrome ?? chromium.executablePath();
  let root = plan.sides.base.dist;
  const { server, baseUrl } = await startViewerServer(() => root, log);
  return {
    sample: (args) => browserSample({ chromium, executablePath, baseUrl, setRoot: (r) => { root = resolve(r); }, outDir: join(out, 'traces'), log, ...args }),
    // Same Chrome, flags, init scripts and shell readiness as the timed lanes; no file is opened.
    boot: ({ side, tag }) => {
      root = resolve(side.dist);
      return bootSample({ chromium, tag, log,
        launchOptions: { env: { ...process.env, VK_ICD_FILENAMES: NVIDIA_ICD, VK_DRIVER_FILES: NVIDIA_ICD }, executablePath, headless: false,
          viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, args: CHROME_ARGS },
        initScripts: [[COUNT_FRAMES], [BOOT_OBSERVERS, { countersOff: true }]],
        openShell: (context) => openViewerPage(context, `${baseUrl}/?perfTrace=1${side.query ? `&${side.query}` : ''}`) });
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Per-element maps saved by the browser lane (`<fixture>-<side>-r<round>-<open>.elements.json`). */
function readElements(out, row) {
  const path = join(out, 'traces', elementsFileFor(row));
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).reduce((a, m) => Object.assign(a, m), {}) : null;
}

/** For browser lanes, diff per-element output of every round pair against the first base sample. */
function attachElementDiffs(summary, samples, plan, out) {
  for (const f of summary.fixtures) {
    for (const lane of BROWSER_LANES) {
      const l = f.lanes[lane];
      if (!l) continue;
      const rows = samples.filter((r) => r.fixture === f.name && r.lane === lane && r.ok);
      const ref = rows.find((r) => r.side === 'base');
      const refElements = ref && readElements(out, ref);
      if (!refElements) continue;
      const diffs = rows.filter((r) => r !== ref).map((r) => ({ side: r.side, round: r.round, ...diffElements(refElements, readElements(out, r) ?? {}) }));
      l.elementDiff = { reference: `base r${ref.round}`, identical: diffs.every((d) => d.identical), diffs };
    }
  }
}

function report(opt) {
  const out = resolve(opt.out);
  const plan = JSON.parse(readFileSync(opt.plan ?? join(out, 'plan.json'), 'utf8'));
  const samples = readFileSync(join(out, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // Browser shares are recomputed from the raw traces, so a run keeps up with the current share definition.
  for (const row of samples) {
    if (row.lane?.startsWith('browser') && Number.isFinite(row.uiQuietMs) && uiQuietValue(row) === null) {
      Object.assign(row, { uiQuietRawMs: row.uiQuietMs, uiQuietMs: null, uiQuietTimedOut: row.uiQuietTimedOut ?? 'inferred (>= 19 s past readiness)' });
    }
    const tracePath = join(out, 'traces', `${row.fixture}-${row.lane}-${row.side}-r${row.round}.json`);
    if (row.ok && row.lane.startsWith('browser') && existsSync(tracePath)) {
      Object.assign(row, { stageShares: browserShares(JSON.parse(readFileSync(tracePath, 'utf8')), row.interactiveMs).shares });
    }
  }
  const aaPath = opt['aa-reference'] ?? plan.aaReference ?? null;
  const floors = aaPath ? JSON.parse(readFileSync(aaPath, 'utf8')).floors : null;
  const host = existsSync(join(out, 'host.json')) ? JSON.parse(readFileSync(join(out, 'host.json'), 'utf8')) : null;
  const summary = summarize(plan, samples, { floors });
  attachElementDiffs(summary, samples, plan, out);
  summary.aaReference = aaPath;
  summary.host = host;
  writeFileSync(join(out, 'report.json'), JSON.stringify(summary, null, 2) + '\n');
  const md = renderMarkdown(summary, plan, host, samples);
  writeFileSync(join(out, 'report.md'), md);
  console.log(md);
  return summary;
}

if (isMainEntry(import.meta.url)) {
  const opt = parseArgs(process.argv.slice(2));
  const commands = { run, report };
  if (!commands[opt.command] || !opt.out || (opt.command === 'run' && !opt.plan)) {
    console.error('usage: load-scoreboard.mjs run --plan plan.json --out DIR [--resume] [--aa-reference report.json]\n       load-scoreboard.mjs report --out DIR [--plan plan.json] [--aa-reference report.json]');
    process.exit(2);
  }
  Promise.resolve(commands[opt.command](opt)).catch((err) => { console.error(err?.stack ?? err); process.exit(1); });
}
