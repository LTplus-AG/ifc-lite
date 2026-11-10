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

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundOrder, seededRand } from './ab-order.mjs';
import { nativeSample } from './load-scoreboard-native.mjs';
import { LANES, renderMarkdown, summarize } from './load-scoreboard-report.mjs';

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
    if (plan.lanes.some((l) => l.startsWith('browser')) && !existsSync(join(s.dist ?? '', 'index.html'))) throw new Error(`plan.sides.${side}.dist has no index.html: ${s.dist}`);
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

/** Balanced, randomized first-side order per lane group and fixture (ab-order.mjs), reproducible from the seed. */
export function buildOrder(plan) {
  const rand = seededRand(plan.seed);
  const groups = [];
  if (plan.lanes.includes('native-cold')) groups.push('native');
  if (plan.lanes.some((l) => l.startsWith('browser'))) groups.push('browser');
  const order = {};
  for (const g of groups) for (const f of plan.fixtures) (order[g] ??= {})[f.name] = roundOrder(plan.rounds, rand);
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
  if (order.browser) browser = await startBrowserLane(plan, out);
  const record = (row, trace) => {
    if (trace) { writeFileSync(join(out, 'traces', `${row.fixture}-${row.lane}-${row.side}-r${row.round}.json`), JSON.stringify(trace)); }
    appendFileSync(samplesPath, JSON.stringify(row) + '\n');
  };
  try {
    // --fixtures a,b runs a subset into the same result set (bounded exclusive jobs); --resume continues it.
    const only = opt.fixtures ? new Set(opt.fixtures.split(',')) : null;
    for (const name of only ?? []) if (!plan.fixtures.some((f) => f.name === name)) throw new Error(`--fixtures: ${name} is not in the plan`);
    for (let round = 0; round < plan.rounds; round++) {
      for (const fixture of plan.fixtures.filter((f) => !only || only.has(f.name))) {
        for (const group of Object.keys(order)) {
          for (const side of order[group][fixture.name][round]) {
            if (done.has(`${group}/${fixture.name}/${round}/${side}`)) continue;
            const common = { group, fixture: fixture.name, round, side, sideLabel: plan.sides[side].label, at: new Date().toISOString(), loadavg1: loadavg()[0] };
            const tag = `${fixture.name}-${side}-r${round}`;
            log(`${group} ${tag}`);
            if (group === 'native') {
              const s = await nativeSample({ side: plan.sides[side], fixture });
              const { probe, ...row } = s;
              record({ ...common, ...row, probe }, null);
              log(`  ${tag} native: ${s.ok ? `${s.interactiveMs.toFixed(0)} ms, ${s.peakMemoryMiB?.toFixed(0)} MiB` : `FAILED ${s.error}`}`);
            } else {
              const s = await browser.sample({ side: plan.sides[side], fixture, tag, warmOpens: plan.warmOpens });
              const adapter = s.meta.adapter ? JSON.stringify(s.meta.adapter) : null;
              for (const lane of ['browser-cold', 'browser-warm']) {
                const r = lane === 'browser-cold' ? s.cold : s.warm;
                if (!r || !plan.lanes.includes(lane)) continue;
                const { trace, ...row } = r;
                record({ ...common, ...row, lane, adapter, browserVersion: s.meta.browserVersion ?? null, pageErrors: s.meta.pageErrors.length,
                  gpuHealth: lane === 'browser-cold' ? s.meta.gpuHealthCold ?? null : s.meta.gpuHealth ?? null,
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
  const { browserSample, loadPlaywright } = await import('./load-scoreboard-browser.mjs');
  const { startViewerServer } = await import('./viewer-load-probe.mjs');
  const { chromium } = loadPlaywright(ROOT);
  const executablePath = process.env.CHROME ?? plan.chrome ?? chromium.executablePath();
  let root = plan.sides.base.dist;
  const { server, baseUrl } = await startViewerServer(() => root, log);
  return {
    sample: (args) => browserSample({ chromium, executablePath, baseUrl, setRoot: (r) => { root = resolve(r); }, outDir: join(out, 'traces'), log, ...args }),
    close: () => new Promise((r) => server.close(r)),
  };
}

function report(opt) {
  const out = resolve(opt.out);
  const plan = JSON.parse(readFileSync(opt.plan ?? join(out, 'plan.json'), 'utf8'));
  const samples = readFileSync(join(out, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const aaPath = opt['aa-reference'] ?? plan.aaReference ?? null;
  const floors = aaPath ? JSON.parse(readFileSync(aaPath, 'utf8')).floors : null;
  const host = existsSync(join(out, 'host.json')) ? JSON.parse(readFileSync(join(out, 'host.json'), 'utf8')) : null;
  const summary = summarize(plan, samples, { floors });
  summary.aaReference = aaPath;
  summary.host = host;
  writeFileSync(join(out, 'report.json'), JSON.stringify(summary, null, 2) + '\n');
  const md = renderMarkdown(summary, plan, host);
  writeFileSync(join(out, 'report.md'), md);
  console.log(md);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = parseArgs(process.argv.slice(2));
  const commands = { run, report };
  if (!commands[opt.command] || !opt.out || (opt.command === 'run' && !opt.plan)) {
    console.error('usage: load-scoreboard.mjs run --plan plan.json --out DIR [--resume] [--aa-reference report.json]\n       load-scoreboard.mjs report --out DIR [--plan plan.json] [--aa-reference report.json]');
    process.exit(2);
  }
  Promise.resolve(commands[opt.command](opt)).catch((err) => { console.error(err?.stack ?? err); process.exit(1); });
}
