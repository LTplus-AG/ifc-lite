#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.2 addendum pass: the geometry kernel's OWN typed defect channel
 * (`GeometryDiagnostics`), on foreign models and on the synthetic corpus.
 *
 * This pass exists because of something the first foreign run printed to
 * stderr and no benchmark task can see: CSG boolean failures. The World Gym
 * defect vocabulary has seven types, and the only geometric one
 * (`degenerate-geometry`) is probed through exactly one signal - whether an
 * `IfcColumn` produced a mesh. Real files fail geometrically in ways that
 * signal cannot express: an opening that could not be subtracted, a host
 * emptied by a boolean, a cutter the kernel refused as too large. ifc-lite
 * already emits all of that as a versioned contract
 * (`packages/geometry/diagnostics.ts`, mirroring the Rust aggregator), and
 * `diagnoseGeometry()` is its headless surface.
 *
 * Running it on both sides answers a question the score delta cannot: is the
 * synthetic corpus exercising the kernel's failure modes at all?
 *
 * PRIVACY: `worstHosts[].bbox` carries world coordinates, which on a
 * georeferenced model is location data. Only the type, opening count and
 * failure count of a worst host are emitted; the bbox is dropped.
 *
 * Usage:
 *   node --max-old-space-size=10240 run-diagnostics-pass.mjs \
 *     --model <abs path> --alias model-a --out <dir>
 *   node run-diagnostics-pass.mjs --synthetic --sample 60 --out <dir>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { initChecks } from '../../../tools/world-gym/lib/checks.mjs';
import { generateModel } from '../../../tools/world-gym/generator.mjs';
import { FAMILY, CORRUPT_RATE, seedsForSplit } from '../../../tools/world-gym/benchmark/splits.mjs';
import { coarseMegabytes, round } from './lib/model-id.mjs';

const { mergeGeometryDiagnostics } = await import('../../../packages/geometry/dist/index.js');

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const synthetic = process.argv.includes('--synthetic');
const modelPath = flag('--model');
const alias = flag('--alias', synthetic ? 'synthetic' : undefined);
const outDir = flag('--out');
if (!outDir || (!synthetic && (!modelPath || !alias))) {
  process.stderr.write('Usage: run-diagnostics-pass.mjs (--model <path> --alias <id> | --synthetic [--sample N]) --out <dir>\n');
  process.exit(2);
}

const processor = await initChecks();

/** Strip world coordinates out of the worst-host list. */
const safeWorstHosts = (hosts) => (hosts ?? []).slice(0, 10).map((h) => ({
  ifcType: h.ifcType,
  openings: h.openings,
  csgFailures: h.csgFailures,
  firstFailureLabel: h.firstFailureLabel ?? null,
  triangleCount: h.triangleCount ?? null,
}));

function summarize(diag) {
  if (!diag) {
    return {
      present: false,
      totalCsgFailures: 0,
      productsWithFailures: 0,
      hostsWithOpenings: 0,
      silentNoOps: 0,
      classification: { rectangular: 0, diagonal: 0, nonRectangular: 0, total: 0 },
      failuresByReason: [],
      worstHosts: [],
    };
  }
  return {
    present: true,
    schemaVersion: diag.schemaVersion,
    totalCsgFailures: diag.totalCsgFailures,
    productsWithFailures: diag.productsWithFailures,
    hostsWithOpenings: diag.hostsWithOpenings,
    silentNoOps: diag.silentNoOps,
    classification: diag.classification,
    failuresByReason: diag.failuresByReason,
    rectFast: diag.rectFast,
    worstHosts: safeWorstHosts(diag.worstHosts),
  };
}

let out;
if (synthetic) {
  const rawSample = flag('--sample', '60');
  const sample = Number(rawSample);
  // Without this, `--sample abc` makes stride NaN, the seed loop never runs,
  // and the pass writes a real-looking artifact over zero models.
  if (!Number.isInteger(sample) || sample < 1) {
    process.stderr.write(`--sample must be a positive integer (got "${rawSample}")\n`);
    process.exit(2);
  }
  const allSeeds = seedsForSplit('dev');
  const stride = Math.max(1, Math.floor(allSeeds.length / sample));
  const seeds = [];
  for (let i = 0; i < allSeeds.length && seeds.length < sample; i += stride) seeds.push(allSeeds[i]);

  let merged = null;
  let modelsWithAnyDiagnostics = 0;
  let modelsWithFailures = 0;
  const t0 = performance.now();
  for (const seed of seeds) {
    const model = generateModel(seed, FAMILY, { corruptRate: CORRUPT_RATE });
    const diag = processor.diagnoseGeometry(new TextEncoder().encode(model.content));
    if (diag) {
      modelsWithAnyDiagnostics += 1;
      if (diag.totalCsgFailures > 0) modelsWithFailures += 1;
      merged = mergeGeometryDiagnostics(merged, diag);
    }
  }
  out = {
    bet: 'B5.2',
    pass: 'diagnostics',
    side: 'synthetic',
    split: 'dev',
    sampledModels: seeds.length,
    modelsWithAnyDiagnostics,
    modelsWithCsgFailures: modelsWithFailures,
    elapsedMs: round(performance.now() - t0, 1),
    diagnostics: summarize(merged),
  };
} else {
  const bytes = await readFile(modelPath);
  const t0 = performance.now();
  const diag = processor.diagnoseGeometry(bytes);
  out = {
    bet: 'B5.2',
    pass: 'diagnostics',
    side: 'foreign',
    alias,
    approxMegabytes: coarseMegabytes(bytes.byteLength),
    elapsedMs: round(performance.now() - t0, 1),
    diagnostics: summarize(diag),
  };
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `diagnostics-${synthetic ? 'synthetic' : alias}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
