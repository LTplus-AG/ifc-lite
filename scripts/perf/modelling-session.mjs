/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** #9296. Diagnostic timings only; no speedup or benchmark qualification. */
import { createHash } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPERATIONS = ['addWall', 'addColumn', 'addSlab', 'addHostedWindow', 'joinWalls', 'copyElements', 'planStoreyEdit', 'editStorey', 'exportIfc'];
export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}
export function growth(results, op, percentile, from, to) {
  const a = results.find(r => r.metrics.target === from);
  const b = results.find(r => r.metrics.target === to);
  if (!a || !b || a.status !== 'pass' || b.status !== 'pass') return null;
  const x = a.metrics.operations[op]?.[percentile], y = b.metrics.operations[op]?.[percentile];
  return x > 0 && Number.isFinite(y) ? y / x : null;
}
export function checkTargets(results, ratchet, f5) {
  const failures = [];
  for (const size of [1000, 10000, 50000]) {
    if (!results.some(r => r.metrics?.target === size && r.status === 'pass')) failures.push(`Missing complete ${size} result`);
  }
  for (const op of OPERATIONS) for (const p of ['p50', 'p95']) {
    const value = growth(results, op, p, 1000, 50000);
    if (value === null || value >= ratchet.targets.maxGrowthExclusive) failures.push(`${op} ${p}: growth ${value ?? 'unmeasured'}`);
  }
  if (!f5 || f5.probe !== 'exercise' || !/^F5(?:[.\-]|$)/.test(f5.id ?? '') || f5.status !== 'pass' || !Number.isFinite(f5.metrics?.ms) || f5.metrics.ms >= ratchet.targets.f5MsExclusive) failures.push('F5 requires a passing exercise result under 60000 ms (--f5-result)');
  return failures;
}
export function table(results) {
  const lines = ['| Target / reached | Operation | n | p50 ms | p95 ms |', '|---|---|---:|---:|---:|'];
  for (const r of results) {
    for (const op of OPERATIONS) {
      const s = r.metrics.operations[op];
      lines.push(`| ${r.metrics.target} / ${r.metrics.reached} | ${op} | ${s?.count ?? 0} | ${s?.p50?.toFixed(2) ?? '—'} | ${s?.p95?.toFixed(2) ?? '—'} |`);
    }
  }
  for (const r of results) {
    lines.push(`\n${r.id}: ${r.status}; ${(r.metrics.totalMs / 1000).toFixed(1)} s; sampled peak heap ${(r.metrics.peakHeapBytes / 2 ** 20).toFixed(1)} MiB. ${r.reason ?? ''}\n`);
  }
  lines.push('| Operation | p50 1K→10K | p50 10K→50K | p50 1K→50K | p95 1K→50K |', '|---|---:|---:|---:|---:|');
  for (const op of OPERATIONS) lines.push(`| ${op} | ${[[1000, 10000, 'p50'], [10000, 50000, 'p50'], [1000, 50000, 'p50'], [1000, 50000, 'p95']].map(([a, b, p]) => growth(results, op, p, a, b)?.toFixed(2) ?? 'unmeasured').join(' | ')} |`);
  lines.push(`\nTotal: ${(results.reduce((sum, r) => sum + r.metrics.totalMs, 0) / 1000).toFixed(1)} s; maximum sampled heap ${(Math.max(...results.map(r => r.metrics.peakHeapBytes)) / 2 ** 20).toFixed(1)} MiB. Diagnostic timings only.`);
  return lines.join('\n');
}
async function runSize(target, budgetMs, samples, directory) {
  const checkpoint = join(directory, `${target}.json`);
  let timedOut = false;
  const started = performance.now();
  const child = fork(fileURLToPath(new URL('./modelling-session-worker.mjs', import.meta.url)), [checkpoint, String(target), String(budgetMs), String(samples)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, budgetMs);
  const { code, signal } = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done({ code, signal }));
  }).finally(() => clearTimeout(timer));
  let data;
  try { data = JSON.parse(readFileSync(checkpoint, 'utf8')); }
  catch (error) { data = { target, reached: 0, operations: {}, totalMs: budgetMs, peakHeapBytes: 0, reason: `No checkpoint: ${error.message}` }; }
  if (timedOut || code !== 0) {
    data.complete = false;
    if (data.phase === 'fill') data.reached = data.after;
    data.reason = timedOut ? `Hard ${budgetMs} ms budget exhausted during ${data.phase}; last durable count ${data.after}` : `Worker exit ${code}, signal ${signal}: ${data.reason ?? data.phase}`;
  }
  data.checkpointMs = data.totalMs;
  data.totalMs = performance.now() - started;
  if (timedOut) data.unfinishedPhaseMs = data.totalMs - data.checkpointMs;
  return data;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('pnpm parity:perf [--budget-ms 540000] [--samples 5] [--check] [--input results.json] [--f5-result F5.json]\nPARITY_OUT defaults to tests/modelling-parity/.out/l3. Each size gets a fresh process; 75% fill, 25% sampling; hard deadline kills only that worker. --check verifies round-1 targets; missing sizes/F5 fail. --input checks without rerunning.');
    return;
  }
  const valuedFlags = new Set(['--budget-ms', '--samples', '--input', '--f5-result']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') continue;
    if (!valuedFlags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${args[i]}`);
    i++;
  }
  const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const budgetMs = Number(value('--budget-ms', '540000')), samples = Number(value('--samples', '5'));
  if (!(budgetMs > 0 && budgetMs <= 540000) || !Number.isInteger(samples) || samples < 1 || samples > 5) throw new Error('Budget must be 1..540000 ms; samples 1..5');
  const output = resolve(process.env.PARITY_OUT ?? 'tests/modelling-parity/.out/l3');
  mkdirSync(output, { recursive: true });
  // Keep the default generated results local even before the other R0 lanes land.
  if (!process.env.PARITY_OUT) writeFileSync(join(output, '.gitignore'), '*\n');
  let results;
  if (args.includes('--input')) results = JSON.parse(readFileSync(value('--input'), 'utf8'));
  else {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const protocolHashes = Object.fromEntries(['scripts/perf/modelling-session.mjs', 'scripts/perf/modelling-session-worker.mjs', 'packages/wasm/pkg/ifc-lite_bg.wasm'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
    const source = { commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) };
    const runner = [process.execPath, ...process.argv.slice(1)].join(' ');
    const directory = mkdtempSync(join(tmpdir(), 'ifc-modelling-session-'));
    results = [];
    try {
      for (const target of [1000, 10000, 50000]) {
        console.error(`Session target ${target}; budget ${budgetMs} ms`);
        const data = await runSize(target, budgetMs, samples, directory);
        results.push({ schema: 'ifclite-parity-result/1', capability: 'large-tall-model-performance', probe: 'perf', id: `session.${target}`, status: data.complete ? 'pass' : 'fail', ...(data.complete ? {} : { reason: data.reason ?? 'Incomplete samples' }), metrics: { ...data, budgetMs, requestedSamples: samples, measuredAt: new Date().toISOString(), protocolHashes }, evidence: [], source, runner });
        writeFileSync(join(output, 'modelling-session.json'), JSON.stringify(results, null, 2) + '\n');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  for (const r of results) {
    r.metrics.growthFrom1K = Object.fromEntries(OPERATIONS.map(op => [op, Object.fromEntries(['p50', 'p95'].map(p => [p, growth(results, op, p, 1000, r.metrics.target)]))]));
    r.metrics.growthFrom10K = Object.fromEntries(OPERATIONS.map(op => [op, Object.fromEntries(['p50', 'p95'].map(p => [p, growth(results, op, p, 10000, r.metrics.target)]))]));
  }
  if (!args.includes('--input')) writeFileSync(join(output, 'modelling-session.json'), JSON.stringify(results, null, 2) + '\n');
  const human = table(results);
  console.log(human);
  writeFileSync(join(output, 'modelling-session.md'), human + '\n');
  if (args.includes('--check')) {
    const ratchet = JSON.parse(readFileSync('tests/perf-ratchets/modelling-session.json', 'utf8'));
    const f5 = args.includes('--f5-result') ? JSON.parse(readFileSync(value('--f5-result'), 'utf8')) : undefined;
    const failures = checkTargets(results, ratchet, f5);
    for (const failure of failures) console.error(failure);
    if (failures.length) process.exitCode = 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
