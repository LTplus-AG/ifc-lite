#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.2 synthetic side of the delta.
 *
 * The SCORES on the synthetic corpus are already committed at
 * tools/world-gym/benchmark/results/ over the full 1,000-model dev split, and
 * this script deliberately does NOT recompute or replace them - the report
 * quotes the committed rows. What the committed rows do not carry is the
 * three things the foreign comparison needs:
 *
 *  1. PER-MODEL COST. The leaderboard is a score, not a stopwatch. To say
 *     anything about how the instrument scales from a 665-entity synthetic
 *     model to a 1M-entity delivered file, the synthetic per-model wall clock
 *     has to be measured on the same machine, in the same process shape.
 *
 *  2. THE CLEAN-MODEL FALSE-POSITIVE RATE, measured rather than inferred.
 *     The committed row's per-type `fp` is 0 for all seven types over 1,000
 *     models. This re-derives it on the subsample so the foreign number is
 *     compared against a figure produced by the same code path in the same
 *     session, not only against a checked-in one.
 *
 *  3. WHETHER `oracle-kernel`'s CONCEDED GAP IS STILL REAL. baselines.mjs
 *     hardcodes `dangling-ref: false` with the comment "The kernel's validate
 *     has no reference-integrity rule". `computeValidationIssues` in
 *     packages/cli DOES have a `reference-integrity` rule today. This script
 *     asks the kernel directly, on the models whose ground truth plants a
 *     dangling ref, whether that rule fires - which decides whether the
 *     committed 0.857143 understates the kernel by a whole 1/7 of the metric.
 *
 * Usage:
 *   node run-synthetic-anchor.mjs --split dev --sample 60 --out <dir>
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateModel } from '../../../tools/world-gym/generator.mjs';
import { oraclePrediction, heuristicPrediction } from '../../../tools/world-gym/benchmark/baselines.mjs';
import { parseStore, schemaCheckInProcess, initChecks } from '../../../tools/world-gym/lib/checks.mjs';
import { groundTruthForSeed } from '../../../tools/world-gym/benchmark/ground-truth.mjs';
import { DEFECT_TYPES, FAMILY, CORRUPT_RATE, seedsForSplit } from '../../../tools/world-gym/benchmark/splits.mjs';
import { round } from './lib/model-id.mjs';

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const split = flag('--split', 'dev');
const rawSample = flag('--sample', '60');
const sample = Number(rawSample);
const outDir = flag('--out');
if (!outDir) {
  process.stderr.write('Usage: run-synthetic-anchor.mjs [--split dev] [--sample 60] --out <dir>\n');
  process.exit(2);
}
// A NaN or non-positive sample makes stride NaN and the seed loop empty, which
// writes a real-looking anchor over zero models. Same guard as the diagnostics pass.
if (!Number.isInteger(sample) || sample < 1) {
  process.stderr.write(`--sample must be a positive integer (got "${rawSample}")\n`);
  process.exit(2);
}

const allSeeds = seedsForSplit(split);
// Deterministic evenly-spaced subsample: no RNG, so the row is reproducible.
const stride = Math.max(1, Math.floor(allSeeds.length / sample));
const seeds = [];
for (let i = 0; i < allSeeds.length && seeds.length < sample; i += stride) seeds.push(allSeeds[i]);

await initChecks();

const oracleMs = [];
const heuristicMs = [];
const entityCounts = [];
const byteSizes = [];
let cleanModels = 0;
let corruptedModels = 0;
const oracleFpByType = Object.fromEntries(DEFECT_TYPES.map((t) => [t, 0]));
const heuristicFpByType = Object.fromEntries(DEFECT_TYPES.map((t) => [t, 0]));
let oracleFiresOnCleanModels = 0;
let heuristicFiresOnCleanModels = 0;

// (3) reference-integrity probe
let danglingTruthModels = 0;
let danglingDetectedByValidate = 0;

for (const seed of seeds) {
  const model = generateModel(seed, FAMILY, { corruptRate: CORRUPT_RATE });
  const truth = groundTruthForSeed(seed);
  entityCounts.push(model.stats.entityCount);
  byteSizes.push(Buffer.byteLength(model.content, 'utf-8'));
  if (model.corrupted) corruptedModels += 1; else cleanModels += 1;

  const th0 = performance.now();
  const heur = heuristicPrediction(seed, model.content);
  heuristicMs.push(performance.now() - th0);

  const to0 = performance.now();
  const orc = await oraclePrediction(seed, model.content);
  oracleMs.push(performance.now() - to0);

  let orcFired = false;
  let heuFired = false;
  for (const t of DEFECT_TYPES) {
    if (orc.defects[t] && !truth.defects[t]) { oracleFpByType[t] += 1; orcFired = true; }
    if (heur.defects[t] && !truth.defects[t]) { heuristicFpByType[t] += 1; heuFired = true; }
  }
  if (!model.corrupted) {
    if (orcFired) oracleFiresOnCleanModels += 1;
    if (heuFired) heuristicFiresOnCleanModels += 1;
  }

  if (truth.defects['dangling-ref']) {
    danglingTruthModels += 1;
    const store = await parseStore(model.content, `anchor-${seed}.ifc`);
    const schema = schemaCheckInProcess(store);
    if (schema.issues.some((i) => i.rule === 'reference-integrity')) danglingDetectedByValidate += 1;
  }
}

// The sample is even-length by default (200), where the upper middle value is
// not the median. Averaging the two middle values is the definition; the old
// form quietly reported an order statistic under the name "median".
const stats = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  return {
    min: round(s[0], 3),
    median: round(median, 3),
    mean: round(s.reduce((a, b) => a + b, 0) / s.length, 3),
    max: round(s[s.length - 1], 3),
  };
};

const out = {
  bet: 'B5.2',
  pass: 'synthetic-anchor',
  split,
  sampledModels: seeds.length,
  splitModels: allSeeds.length,
  cleanModels,
  corruptedModels,
  entityCount: stats(entityCounts),
  fileBytes: stats(byteSizes),
  oracleMsPerModel: stats(oracleMs),
  heuristicMsPerModel: stats(heuristicMs),
  falsePositives: {
    note: 'a false positive is a defect verdict of true where the plant-time ground truth for that seed says false',
    oracleByType: oracleFpByType,
    oracleTotal: Object.values(oracleFpByType).reduce((a, b) => a + b, 0),
    heuristicByType: heuristicFpByType,
    heuristicTotal: Object.values(heuristicFpByType).reduce((a, b) => a + b, 0),
    cleanModelsInSample: cleanModels,
    oracleModelsFiringOnClean: oracleFiresOnCleanModels,
    heuristicModelsFiringOnClean: heuristicFiresOnCleanModels,
    oracleCleanModelFirePct: cleanModels > 0 ? round((oracleFiresOnCleanModels / cleanModels) * 100, 4) : null,
    heuristicCleanModelFirePct: cleanModels > 0 ? round((heuristicFiresOnCleanModels / cleanModels) * 100, 4) : null,
  },
  referenceIntegrityProbe: {
    note: "baselines.mjs hardcodes dangling-ref:false citing a missing reference-integrity rule; computeValidationIssues has one. This is whether it fires on the corpus's own planted dangling refs.",
    modelsWithPlantedDanglingRef: danglingTruthModels,
    modelsWhereValidateFlaggedReferenceIntegrity: danglingDetectedByValidate,
    detectionPct: danglingTruthModels > 0 ? round((danglingDetectedByValidate / danglingTruthModels) * 100, 4) : null,
  },
};

await mkdir(outDir, { recursive: true });
// The split is in the filename: a dev-split anchor and a test-split anchor are
// different measurements and must not overwrite each other in one runs dir.
await writeFile(join(outDir, `synthetic-anchor-${split}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
