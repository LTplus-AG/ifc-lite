#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.2 pass 3 of 4: the benchmark's `oracle-kernel` baseline - the leaderboard's
 * upper-bound anchor - run VERBATIM on a foreign model.
 *
 * `oraclePrediction` is imported unmodified from
 * tools/world-gym/benchmark/baselines.mjs. It is the function that scores
 * 0.857143 macro-F1 on the synthetic dev split. Here it is handed a real
 * delivered file and asked for the same seven verdicts. Because the file was
 * not corrupted by this program, every `true` it returns is either a real
 * defect in a delivered model or a false positive, and the report adjudicates
 * each one by hand against the kernel-pass detail.
 *
 * It runs in its own process because it re-parses and re-meshes internally;
 * keeping it separate from run-kernel-pass.mjs holds peak RSS to one parse
 * plus one geometry pass at 1M-entity scale.
 *
 * Usage:
 *   node --max-old-space-size=10240 run-oracle-pass.mjs \
 *     --model <abs path> --alias model-a --out <dir>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { oraclePrediction } from '../../../tools/world-gym/benchmark/baselines.mjs';
import { DEFECT_TYPES, QUANTITY_KEYS } from '../../../tools/world-gym/benchmark/splits.mjs';
import { initChecks } from '../../../tools/world-gym/lib/checks.mjs';
import { coarseMegabytes, round } from './lib/model-id.mjs';

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const modelPath = flag('--model');
const alias = flag('--alias');
const outDir = flag('--out');
if (!modelPath || !alias || !outDir) {
  process.stderr.write('Usage: run-oracle-pass.mjs --model <path> --alias <id> --out <dir>\n');
  process.exit(2);
}

const bytes = await readFile(modelPath);
const content = bytes.toString('utf-8');

await initChecks();
process.stderr.write('oraclePrediction (parse + schema + geometry + clash)...\n');
const t0 = performance.now();
// Seed -1 is outside the benchmark's 0..9999 universe on purpose: this
// prediction is NOT a submission line and must never be mistaken for one.
const pred = await oraclePrediction(-1, content);
const oracleMs = performance.now() - t0;

const out = {
  bet: 'B5.2',
  pass: 'oracle',
  alias,
  approxMegabytes: coarseMegabytes(bytes.byteLength),
  oracleMs: round(oracleMs, 1),
  // RSS sampled once, here, at the end of the pass. It is NOT a high-water
  // mark: nothing samples during the parse or the geometry stage, so a peak
  // reached and released earlier is invisible to it. Named for what it is.
  rssAtExitMb: round(process.memoryUsage().rss / 1e6, 1),
  prediction: {
    defects: Object.fromEntries(DEFECT_TYPES.map((t) => [t, pred.defects[t]])),
    defectsFired: DEFECT_TYPES.filter((t) => pred.defects[t]),
    defectsFiredCount: DEFECT_TYPES.filter((t) => pred.defects[t]).length,
    triage: pred.triage,
    quantities: Object.fromEntries(QUANTITY_KEYS.map((k) => [k, round(pred.quantities[k], 6)])),
    quantityKeysNonZero: QUANTITY_KEYS.filter((k) => pred.quantities[k] > 0).length,
  },
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `oracle-${alias}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
