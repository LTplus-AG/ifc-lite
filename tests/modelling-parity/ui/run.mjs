#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Modelling parity UI run (#9296): probes, exercise runs and council frames
 * on the real GPU.
 *
 *   IFC_GPU_CDP_URL=<chrome cdp url> node tests/modelling-parity/ui/run.mjs --dist apps/viewer/dist \
 *     [--out <dir>] [--only ui.storeys,ui.roof] [--exercises F1,F2] [--no-probes] [--no-frames]
 *     [--themes light,dark] [--label <name>] [--cdp <url>] [--baseline <file>] [--dist-commit <sha>]
 *
 * Serves `--dist` with `vite preview` (as tests/ui-scenes/capture.mjs does)
 * and connects to the Chrome given by `--cdp` or `IFC_GPU_CDP_URL`, which
 * a GPU-check helper starts on the machine's GPU. A browser without a hardware WebGPU
 * adapter is refused: an empty model canvas would read as a UI failure.
 *
 * Writes to `--out` (default `$PARITY_OUT`, else tests/modelling-parity/.out/ui):
 * - `probes.json`, `exercises.json`: contract results (`ifclite-parity-result/1`);
 * - `shots/`: probe and exercise screenshots;
 * - `frames/`: the council checkpoint set with a `manifest.json` that
 *   `tests/ui-scenes/pair.mjs` reads (candidate vs baseline);
 * - `artifacts/<capability or exercise>/`: the files the UI produced (exported IFC,
 *   drawing SVG/DXF/PDF, sheet PDF), listed in each result's `artifacts` and
 *   `evidence`, for the output probes to validate.
 * `--baseline <file>` also writes the combined result file to commit, with
 * `--dist-commit` naming the commit the dist was built from.
 *
 * @unwired-by-design needs a real GPU and Windows Chrome; run by the parity loop, not CI.
 */

import { hardwareAdapter, themedResult } from './lib/oracles.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { gitSource, openSession, sha256, startPreview, VIEWPORT, waitForHttp } from './lib/driver.mjs';
import { PROBES, runProbe } from './probes.mjs';
import { EXERCISES, runExercise } from './exercises.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCHEMA = 'ifclite-parity-result/1';

function parseArgs(argv) {
  const args = { probes: true, frames: true, exercises: ['F1', 'F2'], themes: ['light', 'dark'], only: null, label: 'candidate' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${key} needs a value`);
      return v;
    };
    if (key === '--dist') args.dist = resolve(value());
    else if (key === '--out') args.out = resolve(value());
    else if (key === '--only') args.only = value().split(',');
    else if (key === '--exercises') args.exercises = value().split(',').filter(Boolean);
    else if (key === '--no-probes') args.probes = false;
    else if (key === '--no-frames') args.frames = false;
    else if (key === '--themes') args.themes = value().split(',');
    else if (key === '--label') args.label = value();
    else if (key === '--cdp') args.cdp = value();
    else if (key === '--baseline') args.baseline = resolve(value());
    else if (key === '--dist-commit') args.distCommit = value();
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.dist) throw new Error('usage: run.mjs --dist <built viewer dist> [--out dir] [--only ids] [--exercises F1,F2] [--cdp url]');
  args.cdp ??= process.env.IFC_GPU_CDP_URL;
  if (!args.cdp) throw new Error('no browser: set IFC_GPU_CDP_URL (a GPU-check helper exports it) or pass --cdp');
  args.out ??= resolve(process.env.PARITY_OUT ?? join(ROOT, 'tests/modelling-parity/.out/ui'));
  for (const id of args.only ?? []) if (!PROBES.some((p) => p.id === id)) throw new Error(`unknown probe ${id}`);
  for (const id of args.exercises) if (!EXERCISES[id]) throw new Error(`unknown exercise ${id}`);
  for (const theme of args.themes) if (!['light', 'dark'].includes(theme)) throw new Error(`invalid theme ${theme}`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const shots = join(args.out, 'shots');
  const frames = join(args.out, 'frames');
  await Promise.all([shots, frames].map((d) => mkdir(d, { recursive: true })));
  /** Write a produced file to artifacts/<group>/<name>; returns its path relative to --out. */
  const saveArtifact = async (group, name, bytes) => {
    const rel = `artifacts/${group}/${name}`;
    await mkdir(join(args.out, 'artifacts', group), { recursive: true });
    await writeFile(join(args.out, rel), bytes);
    return rel;
  };
  const source = gitSource(ROOT);
  const distIndexSha256 = sha256(await readFile(join(args.dist, 'index.html')));
  // Machine paths stay out of results that may be committed: --dist and --out become placeholders.
  const argv = process.argv.slice(2).map((a, i, all) => (['--dist', '--out', '--cdp'].includes(all[i - 1]) ? `<${all[i - 1].slice(2)}>` : a));
  const runner = `node tests/modelling-parity/ui/run.mjs ${argv.join(' ')}`.trim();
  const base = { schema: SCHEMA, source, runner };

  const preview = startPreview(ROOT, args.dist);
  const probeResults = [];
  const exerciseResults = [];
  const frameResults = [];
  const frameFailures = [];
  let adapter = null;
  try {
    await waitForHttp(preview.url, 90000).catch((error) => { throw new Error(`${error.message}\n${preview.log()}`); });
    const browser = await chromium.connectOverCDP(args.cdp);
    const probe = await browser.newContext();
    const page = await probe.newPage();
    await page.goto(`${preview.url}/favicon.ico`).catch(() => page.goto(preview.url));
    adapter = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description, fallback: !!(a.isFallbackAdapter || a.info?.isFallbackAdapter) } : null;
    });
    await probe.close();
    if (!hardwareAdapter(adapter)) {
      throw new Error(`no hardware WebGPU adapter in the browser (${JSON.stringify(adapter)}); the model canvas would be empty`);
    }
    console.log(`adapter ${adapter.vendor} ${adapter.architecture ?? ''}`);
    const openFresh = (label, theme = 'light', shotsDir = shots) => openSession(browser, preview.url, { theme, shotsDir, label });

    if (args.probes) {
      for (const p of PROBES.filter((x) => !args.only || args.only.includes(x.id))) {
        const { result } = await runProbe(p, openFresh, base, { saveArtifact });
        probeResults.push(result);
        console.log(`${result.status.padEnd(7)} ${p.id.padEnd(20)} actions ${String(result.metrics.actions).padStart(3)}  ${String(result.metrics.ms).padStart(6)} ms${result.reason ? `  ${result.reason.slice(0, 160)}` : ''}`);
      }
      await writeFile(join(args.out, 'probes.json'), `${JSON.stringify(probeResults, null, 2)}\n`);
    }

    for (const id of args.exercises) {
      // The first theme's run is the measured one; every theme's run writes council frames.
      for (const [i, theme] of args.themes.entries()) {

        const run = await runExercise(EXERCISES[id], { openFresh, theme, shots, frames: args.frames ? frames : null, saveArtifact, base, measured: i === 0 });
        {
          exerciseResults.push(themedResult(run.result,theme));
          console.log(`${run.result.status.padEnd(7)} ${run.result.id.padEnd(20)} actions ${String(run.result.metrics.actions).padStart(3)}  ${String(run.result.metrics.ms).padStart(6)} ms${run.result.reason ? `  ${run.result.reason.slice(0, 160)}` : ''}`);
        }
        frameResults.push(...run.frames);
        frameFailures.push(...run.frameFailures);
      }
    }
    if (args.exercises.length) await writeFile(join(args.out, 'exercises.json'), `${JSON.stringify(exerciseResults, null, 2)}\n`);
    await browser.close().catch(() => {});
  } finally {
    preview.stop();
  }

  if (args.frames && args.exercises.length) {
    await writeFile(join(frames, 'manifest.json'), `${JSON.stringify({
      version: 1, label: args.label, capturedAt: new Date().toISOString(), kind: 'modelling-parity', viewport: VIEWPORT,
      distIndexSha256, source, adapter, results: frameResults, failures: frameFailures,
    }, null, 2)}\n`);
  }

  if (args.baseline) {
    const rel = (p) => relative(args.out, p);
    await mkdir(dirname(args.baseline), { recursive: true });
    await writeFile(args.baseline, `${JSON.stringify({
      schema: 'ifclite-parity-ui-baseline/1',
      issue: 9296,
      round: 0,
      label: args.label,
      source,
      distIndexSha256,
      ...(args.distCommit ? { distSource: { commit: args.distCommit, build: 'pnpm turbo build --filter=@ifc-lite/viewer' } } : {}),
      adapter: { vendor: adapter?.vendor ?? null, architecture: adapter?.architecture ?? null },
      viewport: VIEWPORT,
      runner,
      results: [...probeResults, ...exerciseResults],
      frames: frameResults.map((f) => ({ id: `${f.scene}.${f.theme}`, file: `${rel(frames)}/${f.file}`, sha256: f.sha256, metrics: f.metrics })),
      frameFailures,
    }, null, 2)}\n`);
  }
  const bad = [...probeResults, ...exerciseResults].filter((r) => r.status === 'error' || r.status === 'fail').length;
  console.log(`${probeResults.length} probes, ${exerciseResults.length} exercises, ${frameResults.length} frames (${frameFailures.length} failed) -> ${args.out}`);
  if (bad || frameFailures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
