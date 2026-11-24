#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Huge-geometry ladder runner (scripts/perf/huge-geometry.md). For each
 * scenario, climbs the tiers: generate (or reuse) the model, load it in a
 * fresh Chrome on the real GPU through the canonical file input, measure load
 * phases, memory, the camera paths and interaction latencies, and stop the
 * scenario at its first failing tier (recording exactly how it failed).
 *
 *   node scripts/perf/huge-geometry-run.mjs --out DIR --models-dir DIR
 *        [--scenarios mixed,small-unique] [--tiers 10k,100k] [--label baseline]
 *        [--evidence diagnostic|benchmark] [--timeout-min 30] [--frames 240]
 *        [--dist apps/viewer/dist] [--generate-only] [--keep-climbing] [--skip-gc]
 *
 * Writes DIR/runs/NAME.json per run, DIR/summary.json and DIR/summary.md.
 * `--evidence` is recorded, never inferred: pass `benchmark` only inside the
 * fleet's exclusive benchmark admission (see the README).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { generateScenario } from './huge-geometry-gen.mjs';
import { FAMILIES, TIERS, resolveScenario, tierLabel } from './huge-geometry-ladder.mjs';
import { ROOT, launchGpu, loadModel, positiveFinite, startSampler } from './huge-geometry-browser.mjs';
import { cameraPaths, interactions, settledMemory } from './huge-geometry-measure.mjs';
import { markdownSummary } from './huge-geometry-report.mjs';
import { startViewerServer } from './viewer-load-probe.mjs';

/** "10k" / "2M" / "250000" -> number. */
export function parseTier(text) {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(String(text).trim());
  if (!m) throw new Error(`bad tier '${text}': use e.g. 10k, 250k, 1M`);
  const n = Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1);
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad tier '${text}'`);
  return n;
}

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

/** Host, GPU, build and source identity recorded in every result. */
/** Measurement steps whose failure leaves the tier usable (browser memory APIs vary by build and host). */
const OPTIONAL_STEPS = new Set(['gc', 'wasm-bytes', 'ua-memory']);

/** Environment fields that make two result rows comparable (not label, load or time). */
const comparableEnv = (e) => JSON.stringify([e?.host, e?.evidence, e?.pageGlobals, e?.gpu, e?.git?.head, e?.git?.dirty, e?.distIndexSha256]);

export function environment(dist, evidence, label) {
  const index = join(dist, 'index.html');
  return { host: hostname(), label, evidence, pageGlobals: process.env.HUGE_GEOMETRY_GLOBALS ?? null,
    gpu: sh('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader']),
    kernel: sh('uname', ['-r']), node: process.version,
    git: { head: sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']), dirty: Boolean(sh('git', ['-C', ROOT, 'status', '--porcelain'])) },
    distIndexSha256: existsSync(index) ? createHash('sha256').update(readFileSync(index)).digest('hex') : null,
    loadAvg: readFileSync('/proc/loadavg', 'utf8').trim() };
}

/** Load one generated scenario and measure it. Never throws for a viewer failure; a fatal setup error is rethrown. */
export async function runOne({ baseUrl, manifest, timeoutMs, frames, skipGc = false, onPhase }) {
  const result = { scenario: manifest.scenario, generated: { files: manifest.files, totals: manifest.totals }, status: 'failed', errors: [] };
  const session = await launchGpu();
  result.browser = session.version;
  const cdp = await session.context.newCDPSession(session.page);
  await cdp.send('Performance.enable');
  const sampler = startSampler(session.profileDir, cdp);
  let after = null;
  try {
    onPhase?.('load', session);
    const load = await loadModel(session, baseUrl, manifest.files, { timeoutMs });
    result.load = load;
    result.sampling = await sampler.stop().then((s) => ({ peak: s.peak, samples: s.samples, lastDuringLoad: s.last }));
    if (!load.ok) {
      result.failure = load.failure;
      result.console = session.events.console.filter((l) => /error|warn|lost|memory/i.test(l)).slice(-40);
      return result;
    }
    after = startSampler(session.profileDir, cdp);
    result.memory = await settledMemory(session.page, cdp, after, result.errors, { skipGc });
    result.skipGc = skipGc;
    onPhase?.('camera', session);
    result.camera = await cameraPaths(session.page, frames, result.errors, { onPath: (k) => onPhase?.(`camera-${k}`, session) });
    onPhase?.('interactions', session);
    result.interactions = await interactions(session.page, result.errors);
    const post = await after.stop();
    result.sampling.peakAfterLoad = post.peak;
    if (session.events.crashed) { result.failure = { kind: 'renderer-crash', detail: 'page crashed after load (during camera/interactions)' }; return result; }
    // Every step was attempted; a failed camera path or interaction still fails the tier (memory probes are best-effort).
    const failed = result.errors.filter((e) => !OPTIONAL_STEPS.has(e.step));
    if (failed.length) { result.failure = { kind: 'measure-error', detail: failed.map((e) => `${e.step}: ${e.error}`).join('; ').slice(0, 800) }; return result; }
    result.status = 'ok';
    return result;
  } catch (err) {
    if (err.fatal) throw err;
    result.status = 'error';
    result.failure = { kind: session.events.crashed ? 'renderer-crash' : 'harness-error', detail: String(err?.message ?? err).slice(0, 800) };
    return result;
  } finally {
    await sampler.stop().catch(() => null);
    // A crash between load and the end of the interactions must not leave this interval keeping the process alive.
    if (after) await after.stop().catch(() => null);
    result.pageErrors = session.events.pageErrors.slice(0, 20);
    await session.close();
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, 'models-dir': { type: 'string' }, scenarios: { type: 'string' }, tiers: { type: 'string' },
    label: { type: 'string', default: 'run' }, evidence: { type: 'string', default: 'diagnostic' }, 'timeout-min': { type: 'string', default: '30' },
    frames: { type: 'string', default: '240' }, dist: { type: 'string', default: join(ROOT, 'apps/viewer/dist') },
    'generate-only': { type: 'boolean', default: false }, 'skip-gc': { type: 'boolean', default: false }, 'keep-climbing': { type: 'boolean', default: false }, seed: { type: 'string' },
  } });
  const usage = 'usage: huge-geometry-run.mjs --out DIR --models-dir DIR [--scenarios a,b] [--tiers 10k,100k] [--label L] [--evidence diagnostic|benchmark] [--timeout-min 30] [--frames 240] [--seed 1] [--dist DIR] [--generate-only] [--keep-climbing]';
  if (!values.out || !values['models-dir']) {
    console.error(usage);
    process.exit(2);
  }
  if (!['diagnostic', 'benchmark'].includes(values.evidence)) { console.error('--evidence must be diagnostic or benchmark'); process.exit(2); }
  const scenarios = values.scenarios ? values.scenarios.split(',') : Object.keys(FAMILIES);
  const tiers = values.tiers ? values.tiers.split(',').map(parseTier) : [...TIERS];
  const seed = values.seed === undefined ? undefined : positiveFinite('seed', values.seed, usage);
  for (const s of scenarios) resolveScenario({ scenario: s, elements: tiers[0], seed }); // validate before any work
  const frames = positiveFinite('frames', values.frames, usage);
  const timeoutMs = positiveFinite('timeout-min', values['timeout-min'], usage) * 60000;
  const out = resolve(values.out), modelsDir = resolve(values['models-dir']), dist = resolve(values.dist);
  mkdirSync(join(out, 'runs'), { recursive: true });
  const env = environment(dist, values.evidence, values.label);
  const results = [];
  const summaryPath = join(out, 'summary.json');
  if (existsSync(summaryPath)) {
    // Keep earlier rows measured in a comparable environment (the summary carries one environment header). A row
    // is replaced only when this run actually measures that scenario name again (below), so tiers the climb
    // never reaches, and other seeds, keep their earlier results.
    try {
      const kept = JSON.parse(readFileSync(summaryPath, 'utf8')).results;
      const same = kept.filter((r) => comparableEnv(r.environment) === comparableEnv(env));
      if (same.length < kept.length) console.warn(`huge-geometry: dropping ${kept.length - same.length} earlier row(s) from another build/host/flags; use a new --out to keep them`);
      results.push(...same);
    }
    catch (err) { console.warn(`huge-geometry: ignoring unreadable ${summaryPath}: ${err.message}`); }
  }
  const save = () => {
    const ordered = [...results].sort((a, b) => (a.scenario.scenario.localeCompare(b.scenario.scenario)) || a.scenario.nominal - b.scenario.nominal);
    writeFileSync(summaryPath, `${JSON.stringify({ environment: env, results: ordered }, null, 1)}\n`);
    writeFileSync(join(out, 'summary.md'), `${markdownSummary(ordered, { label: values.label, host: `${env.host}, ${env.gpu}, evidence: ${env.evidence}` })}\n`);
  };
  let server = null, baseUrl = null;
  if (!values['generate-only']) {
    if (!existsSync(join(dist, 'index.html'))) { console.error(`no viewer build at ${dist}`); process.exit(2); }
    ({ server, baseUrl } = await startViewerServer(() => dist));
  }
  try {
    for (const scenario of scenarios) {
      for (const elements of tiers) {
        const manifest = generateScenario(modelsDir, { scenario, elements, seed });
        console.log(`[${scenario} ${tierLabel(elements)}] ${manifest.reused ? 'reused' : 'generated'} ${manifest.totals.elements} elements, ${(manifest.totals.bytes / 2 ** 20).toFixed(0)} MiB`);
        if (values['generate-only']) continue;
        const t0 = Date.now();
        const r = await runOne({ baseUrl, manifest, timeoutMs, frames, skipGc: values['skip-gc'] });
        r.environment = env;
        r.runSeconds = (Date.now() - t0) / 1000;
        writeFileSync(join(out, 'runs', `${manifest.scenario.name}.json`), `${JSON.stringify(r, null, 1)}\n`);
        const i = results.findIndex((x) => x.scenario.name === r.scenario.name);
        if (i >= 0) results.splice(i, 1);
        results.push(r);
        save();
        console.log(`[${scenario} ${tierLabel(elements)}] ${r.status}${r.failure ? `: ${r.failure.kind}: ${r.failure.detail}` : ''} (${r.runSeconds.toFixed(0)} s)`);
        if (r.status !== 'ok' && !values['keep-climbing']) break;
      }
    }
  } finally {
    server?.close();
  }
  if (!values['generate-only']) console.log(readFileSync(join(out, 'summary.md'), 'utf8'));
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => { console.error(`huge-geometry-run: ${err.stack ?? err}`); process.exit(1); });
}
