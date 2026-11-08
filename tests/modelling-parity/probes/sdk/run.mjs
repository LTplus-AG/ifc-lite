#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run the modelling-parity SDK probes (#9296, lane L1).
 *
 * Each `<capability>.js` next to this file runs in its own
 * `node packages/cli/dist/index.js run <probe> <blank.ifc>` process on a fresh
 * one-storey blank model, so probes cannot leak state into each other. A
 * probe that crashes, times out or writes no result is an `error`, never a
 * pass. Results follow `ifclite-parity-result/1` and land in
 * `$PARITY_OUT/sdk/<capability>.json` (default `tests/modelling-parity/.out/L1`).
 *
 * Usage:
 *   node tests/modelling-parity/probes/sdk/run.mjs [--only id,id] [--out DIR] [--jobs N]
 *     [--build-root DIR]   use another checkout's built CLI/wasm (results record it)
 *
 * Needs a built CLI: `pnpm turbo build --filter=@ifc-lite/cli...` and the wasm
 * runtime (`pnpm build:wasm:fetch`).
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const rel = (p) => relative(ROOT, p).split('\\').join('/');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Where the built CLI, `@ifc-lite/create` dist and wasm runtime live (default: this checkout). */
const BUILD = resolve(arg('--build-root', process.env.PARITY_BUILD_ROOT ?? ROOT));
const CLI = join(BUILD, 'packages/cli/dist/index.js');

const OUT = resolve(arg('--out', process.env.PARITY_OUT ?? join(ROOT, 'tests/modelling-parity/.out/L1')));
const ONLY = arg('--only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const JOBS = Math.max(1, Number(arg('--jobs', '4')));
const TIMEOUT_MS = Number(arg('--timeout', '180000'));
/** Timing probes run alone, after the rest, so parallel probes do not distort them. */
const SERIAL = new Set(['large-tall-model-performance']);

export function sourceInfo(root = ROOT) {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

async function makeBlank(path) {
  const { IfcCreator } = await import(pathToFileURL(join(BUILD, 'packages/create/dist/index.js')).href);
  const c = new IfcCreator({ Name: 'Modelling parity probe' });
  c.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  writeFileSync(path, c.toIfc().content);
}

function runOne(capability, script, blank, work, source) {
  const resultFile = join(work, `${capability}.result.json`);
  rmSync(resultFile, { force: true });
  const cli = BUILD === ROOT ? 'packages/cli/dist/index.js' : CLI;
  const runner = `node ${cli} run ${rel(script)} ${rel(blank)}`;
  const t0 = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, 'run', script, blank], {
      cwd: ROOT,
      env: {
        ...process.env,
        PARITY_ROOT: ROOT,
        PARITY_BUILD_ROOT: BUILD,
        PARITY_LIB: pathToFileURL(join(HERE, 'lib/parity.mjs')).href,
        PARITY_WORK: work,
        PARITY_RESULT_FILE: resultFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const keep = (d) => { log = (log + d.toString()).slice(-20000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(join(work, `${capability}.log`), log);
      const ms = Date.now() - t0;
      let body = null;
      if (existsSync(resultFile)) {
        try { body = JSON.parse(readFileSync(resultFile, 'utf8')); } catch { body = null; }
      }
      const tail = log.trim().split('\n').slice(-3).join(' | ');
      if (!body || body.capability !== capability) {
        body = {
          capability, status: 'error',
          reason: timedOut ? `probe timed out after ${TIMEOUT_MS} ms` : `probe wrote no result (exit ${code}): ${tail}`,
          metrics: { ms }, evidence: [],
        };
      } else if (code !== 0 && body.status === 'pass') {
        body.status = 'error';
        body.reason = `probe exited ${code} after reporting pass: ${tail}`;
      }
      const result = {
        schema: 'ifclite-parity-result/1',
        capability,
        probe: 'sdk',
        id: `sdk.${capability}`,
        status: body.status,
        ...(body.status === 'pass' ? {} : { reason: body.reason ?? 'no reason given' }),
        metrics: { ...body.metrics, wallMs: ms },
        evidence: [...(body.evidence ?? []), rel(join(work, `${capability}.log`))],
        source,
        runner,
        ...(body.checks ? { checks: body.checks } : {}),
        ...(body.artifacts ? { artifacts: body.artifacts } : {}),
      };
      done(result);
    });
  });
}

async function main() {
  if (!existsSync(CLI)) {
    console.error(`SDK probes need a built CLI at ${rel(CLI)}: run pnpm build:wasm:fetch && pnpm turbo build --filter=@ifc-lite/cli...`);
    process.exit(2);
  }
  const catalogue = JSON.parse(readFileSync(join(ROOT, 'tests/modelling-parity/catalogue.json'), 'utf8'));
  const known = new Set(catalogue.capabilities.map((c) => c.id));
  const scripts = readdirSync(HERE).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3));
  for (const s of scripts) if (!known.has(s)) throw new Error(`probe ${s}.js names no catalogue capability`);
  const wanted = catalogue.capabilities.filter((c) => c.probes?.sdk?.script && (!ONLY || ONLY.includes(c.id)));
  const missing = wanted.filter((c) => !scripts.includes(c.id));
  if (missing.length) throw new Error(`catalogue rows with an sdk probe but no script: ${missing.map((c) => c.id).join(', ')}`);

  const sdkOut = join(OUT, 'sdk'), work = join(OUT, 'work');
  mkdirSync(sdkOut, { recursive: true });
  mkdirSync(work, { recursive: true });
  const blank = join(work, 'blank.ifc');
  await makeBlank(blank);
  const source = sourceInfo();
  const t0 = Date.now();

  const results = [];
  const queue = wanted.filter((c) => !SERIAL.has(c.id));
  const write = (r) => {
    results.push(r);
    writeFileSync(join(sdkOut, `${r.capability}.json`), JSON.stringify(r, null, 2) + '\n');
    console.log(`${r.status.padEnd(7)} ${r.capability} (${r.metrics.wallMs} ms)${r.reason ? ` — ${r.reason.slice(0, 220)}` : ''}`);
  };
  const workers = Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
    for (let c; (c = queue.shift());) write(await runOne(c.id, join(HERE, `${c.id}.js`), blank, work, source));
  });
  await Promise.all(workers);
  for (const c of wanted.filter((x) => SERIAL.has(x.id))) write(await runOne(c.id, join(HERE, `${c.id}.js`), blank, work, source));

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  console.log(`\nSDK probes: ${results.length} in ${Math.round((Date.now() - t0) / 1000)} s — ${JSON.stringify(counts)} -> ${rel(sdkOut)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
