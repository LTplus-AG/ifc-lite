#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flag-on qualification (scripts/perf/flag-qualify.md): does the viewer still
 * behave with a perf flag set forced ON? Every stage compares the flags-on run
 * with a flags-off run of the same build, so a failure main also has is
 * reported as main's, not the flag's.
 *
 *   node scripts/perf/flag-qualify.mjs unit --flags SPEC --out DIR [--shards 4] [--build-deps]
 *   node scripts/perf/flag-qualify.mjs e2e  --flags SPEC --out DIR [--dist apps/viewer/dist] [--project viewer-e2e-ci] [--grep RE] [--build-deps]
 *   node scripts/perf/flag-qualify.mjs gpu  --flags SPEC --out DIR [--dist apps/viewer/dist] --models samples,real,campus-100k
 *        [--real-dir DIR] [--models-dir DIR] [--pixel-max-pct 0.1] [--timeout-min 8] [--noise]
 *   node scripts/perf/flag-qualify.mjs dist --flags SPEC --dist DIR --out FLAGGED_DIST
 *   node scripts/perf/flag-qualify.mjs report --out DIR
 *
 * SPEC is a registry flag id (drawStream, gpuInstancing: its URL param and
 * global set to 1), the preset drawStream-full, or `name=value,...`: a `__IFC_LITE_*` name sets that page global (JSON value),
 * any other name a URL param. Each stage writes DIR/<stage>.json and prints
 * its table; `report` joins them into DIR/report.md. `gpu` needs a real GPU
 * (ifc-gpu-check / ifc-fleet run --gpu); every number it records is diagnostic.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import {
  compareArms, failingTests, flagSetLabel, markdownTable, overall, parseFlagSet, resolveModels, suiteRows,
  unitInjectable, unitPreloadSource, withNodeImport, writeFlaggedDist,
} from './flag-qualify-lib.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');

/** Process groups this run started (suites, preview servers): killed with it, so a timed-out run leaves nothing behind. */
const children = new Set();
const killChildren = () => { for (const pid of children) { try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ } } children.clear(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { killChildren(); process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); });

/** Spawn in its own process group, tracked for cleanup. */
function spawnGroup(cmd, args, options) {
  const child = spawn(cmd, args, { ...options, detached: true });
  children.add(child.pid);
  child.on('exit', () => children.delete(child.pid));
  return child;
}

/** Run a command, streaming its output to `log` as it comes (a killed run keeps its log); resolves with the exit code and the output. */
function run(cmd, args, { env = {}, log, cwd = ROOT } = {}) {
  return new Promise((done) => {
    const child = spawnGroup(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const file = log ? createWriteStream(log) : null;
    let out = '';
    const take = (chunk) => { out += chunk; file?.write(chunk); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => { file?.end(); done({ exitCode: code ?? 1, output: out, child }); });
  });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`);
  return value;
}

async function unitArm(flagSet, out, { shards, arm }) {
  // Both arms get the same heap; the flags-on arm adds only the preload.
  const env = { NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096' };
  if (flagSet) {
    const preload = join(out, 'unit-flags-preload.mjs');
    writeFileSync(preload, unitPreloadSource(flagSet));
    env.NODE_OPTIONS = withNodeImport(env.NODE_OPTIONS, preload);
  }
  const results = await Promise.all(Array.from({ length: shards }, (_, i) => run('pnpm', ['--filter', '@ifc-lite/viewer', 'test'],
    { env: { ...env, TEST_SHARDS: String(shards), TEST_SHARD: String(i) }, log: join(out, `unit-${arm}-${i}.log`) })));
  return { exitCode: results.some((r) => r.exitCode !== 0) ? 1 : 0, failures: results.flatMap((r) => failingTests(r.output)),
    log: join(out, `unit-${arm}-*.log`) };
}

async function buildDeps(values, out) {
  if (!values['build-deps']) return;
  const log = join(out, 'build-deps.log');
  const { exitCode } = await run('pnpm', ['exec', 'turbo', 'build', '--filter=@ifc-lite/viewer^...', '--output-logs=errors-only'], { log });
  if (exitCode !== 0) throw new Error(`--build-deps failed (exit ${exitCode}); see ${log}`);
}

/** A suite flags on, and flags off only when that failed; writes `name`.json with its rows. */
async function suiteStage(out, name, area, runArm) {
  const on = await runArm('on');
  const off = on.exitCode === 0 ? null : await runArm('off');
  return writeJson(join(out, `${name}.json`), { on, off, rows: suiteRows(area, on, off) });
}

/** Run `fn(flaggedDist)` with a flagged view of `dist` that is removed afterwards, also on a throw. */
async function withFlaggedDist(dist, out, flagSet, fn) {
  const flagged = join(out, 'dist-flags-on');
  rmSync(flagged, { recursive: true, force: true });
  writeFlaggedDist(dist, flagged, flagSet);
  try { return await fn(flagged); } finally { rmSync(flagged, { recursive: true, force: true }); }
}

async function unitStage(flagSet, out, values) {
  if (!unitInjectable(flagSet)) {
    return writeJson(join(out, 'unit.json'), { rows: [{ area: 'viewer unit suite', check: 'suite', verdict: 'skip',
      detail: 'the flag set has no __IFC_LITE_* global, and unit tests have no URL to carry a param', evidence: '' }] });
  }
  await buildDeps(values, out);
  const shards = Number(values.shards ?? 4);
  return suiteStage(out, 'unit', 'viewer unit suite', (arm) => unitArm(arm === 'on' ? flagSet : null, out, { shards, arm }));
}

const freePort = () => new Promise((done, fail) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
  server.on('error', fail);
});

async function waitForPort(port, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    try { if ((await fetch(`http://localhost:${port}/`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`preview server on :${port} did not come up`);
}

async function e2eArm(dist, out, { arm, project, grep }) {
  const port = await freePort();
  const preview = spawnGroup('pnpm', ['--filter', '@ifc-lite/viewer', 'exec', 'vite', 'preview', '--port', String(port), '--strictPort', '--outDir', dist],
    { cwd: ROOT, env: { ...process.env, BROWSER: 'none' }, stdio: 'ignore' });
  try {
    await waitForPort(port, 90000);
    const args = ['exec', 'playwright', 'test', `--project=${project}`, '--reporter=list', ...(grep ? ['--grep', grep] : [])];
    const result = await run('pnpm', args, { env: { PLAYWRIGHT_PORT: String(port), E2E_GPU_STRICT: process.env.E2E_GPU_STRICT ?? '0' },
      log: join(out, `e2e-${arm}.log`) });
    return { exitCode: result.exitCode, failures: failingTests(result.output), log: join(out, `e2e-${arm}.log`) };
  } finally {
    try { process.kill(-preview.pid, 'SIGTERM'); } catch { /* already gone */ }
    children.delete(preview.pid);
  }
}

async function e2eStage(flagSet, out, values) {
  await buildDeps(values, out);
  const dist = resolve(values.dist ?? join(ROOT, 'apps/viewer/dist'));
  const options = { project: values.project ?? 'viewer-e2e-ci', grep: values.grep };
  return withFlaggedDist(dist, out, flagSet, (flagged) => suiteStage(out, 'e2e', `e2e (${options.project})`,
    (arm) => e2eArm(arm === 'on' ? flagged : dist, out, { ...options, arm })));
}

async function gpuStage(flagSet, out, values) {
  const { generateScenario } = await import('./huge-geometry-gen.mjs');
  const { parseTier } = await import('./huge-geometry-run.mjs');
  const { runArm } = await import('./flag-qualify-gpu.mjs');
  const dist = resolve(values.dist ?? join(ROOT, 'apps/viewer/dist'));
  const models = resolveModels((values.models ?? 'samples').split(','), { root: ROOT, realDir: values['real-dir'] ?? null,
    listDir: (dir) => (existsSync(dir) ? readdirSync(dir) : []) });
  const previous = existsSync(join(out, 'gpu.json')) ? JSON.parse(readFileSync(join(out, 'gpu.json'), 'utf8')) : { models: {} };
  const frames = join(out, 'frames');
  mkdirSync(join(out, 'diffs'), { recursive: true });
  await withFlaggedDist(dist, out, flagSet, async (flagged) => {
    for (const model of models) {
      if (model.synthetic) {
        if (!values['models-dir']) throw new Error(`${model.name} needs --models-dir`);
        model.files = generateScenario(resolve(values['models-dir']), { scenario: model.synthetic.scenario, elements: parseTier(model.synthetic.tier) }).files;
      }
      const timeoutMs = Number(values['timeout-min'] ?? 8) * 60000;
      console.log(`flag-qualify gpu: ${model.name} (${model.files.length} file${model.files.length > 1 ? 's' : ''})`);
      const off = await runArm({ dist, model, arm: 'off', dir: frames, timeoutMs });
      const on = await runArm({ dist: flagged, model, arm: 'on', dir: frames, timeoutMs });
      const noise = values.noise ? await runArm({ dist, model, arm: 'off2', dir: frames, timeoutMs }) : null;
      const pixelMaxPct = Number(values['pixel-max-pct'] ?? 0.1);
      const rows = compareArms(off, on, compareOptions(out, pixelMaxPct, model.small, noise));
      previous.models[model.name] = { off, on, noise, small: model.small, pixelMaxPct, rows };
      writeJson(join(out, 'gpu.json'), previous);
      console.log(markdownTable(flagSet, rows, { title: `${model.name}` }));
    }
  });
  return previous;
}

function compareOptions(out, pixelMaxPct, small, noise) {
  const diffs = join(out, 'diffs');
  return { pixelMaxPct, small, noise, readFile: (p) => readFileSync(p),
    writeDiff: (name, png) => { const p = join(diffs, `${name}.png`); writeFileSync(p, png); return p; } };
}

/** The GPU rows again from the saved arms and frames (so a changed rule applies), else the stored rows. */
function gpuRows(out, values, entry) {
  const frames = [entry.off, entry.on, entry.noise].flatMap((arm) => Object.values(arm?.steps ?? {}).map((step) => step.frame?.path)).filter(Boolean);
  if (!entry.off || !entry.on || !frames.every((path) => existsSync(path))) return entry.rows;
  // The gate the run used, unless this report sets one.
  const pixelMaxPct = values['pixel-max-pct'] !== undefined ? Number(values['pixel-max-pct']) : entry.pixelMaxPct ?? 0.1;
  return compareArms(entry.off, entry.on, compareOptions(out, pixelMaxPct, entry.small ?? false, entry.noise ?? null));
}

function report(out, flagSet, values) {
  const read = (name) => (existsSync(join(out, name)) ? JSON.parse(readFileSync(join(out, name), 'utf8')) : null);
  const unit = read('unit.json'), e2e = read('e2e.json'), gpu = read('gpu.json');
  const rows = [...(unit?.rows ?? suiteRows('viewer unit suite', null)), ...(e2e?.rows ?? suiteRows('e2e', null)),
    ...Object.values(gpu?.models ?? {}).flatMap((m) => gpuRows(out, values, m).map((r) => ({ ...r, area: `${r.model}: ${r.area}` })))];
  const md = markdownTable(flagSet, rows);
  writeFileSync(join(out, 'report.md'), md);
  console.log(md);
  return overall(rows);
}

export async function main(argv = process.argv.slice(2)) {
  const [stage, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    flags: { type: 'string' }, out: { type: 'string' }, dist: { type: 'string' }, models: { type: 'string' },
    'real-dir': { type: 'string' }, 'models-dir': { type: 'string' }, 'pixel-max-pct': { type: 'string' }, 'timeout-min': { type: 'string' },
    shards: { type: 'string' }, 'build-deps': { type: 'boolean' }, noise: { type: 'boolean' }, project: { type: 'string' }, grep: { type: 'string' },
  } });
  if (!['unit', 'e2e', 'gpu', 'dist', 'report'].includes(stage) || !values.flags || !values.out) {
    console.error('usage: flag-qualify.mjs unit|e2e|gpu|dist|report --flags SPEC --out DIR [options] (see the file header)');
    return 2;
  }
  const flagSet = parseFlagSet(values.flags, readFileSync(join(ROOT, 'apps/viewer/src/lib/perf/flags.ts'), 'utf8'));
  const out = resolve(stage === 'dist' ? values.out : join(values.out, flagSetLabel(flagSet)));
  if (stage === 'dist') {
    writeFlaggedDist(resolve(values.dist ?? join(ROOT, 'apps/viewer/dist')), out, flagSet);
    console.log(`flagged dist: ${out}`);
    return 0;
  }
  mkdirSync(out, { recursive: true });
  if (stage === 'unit') await unitStage(flagSet, out, values);
  if (stage === 'e2e') await e2eStage(flagSet, out, values);
  if (stage === 'gpu') await gpuStage(flagSet, out, values);
  return report(out, flagSet, values) === 'fail' ? 1 : 0;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main();
