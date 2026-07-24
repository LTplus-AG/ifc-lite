#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World Gym Benchmark - scoring harness (B2.2).
 *
 * Usage:
 *   node tools/world-gym/benchmark/score.mjs --submission <file.jsonl> --split dev [--out row.json]
 *   node tools/world-gym/benchmark/score.mjs --validate-only --submission <file.jsonl> --split dev
 *
 * Validates the submission (see submission.mjs for the format), REGENERATES
 * the split's ground truth from seed arithmetic (nothing is looked up, so
 * there is no answer-key file to leak or drift), computes per-task scores in
 * [0, 1] plus the aggregate, and writes one leaderboard-row JSON to stdout
 * (and to --out if given).
 *
 * Scoring math (normative; BENCHMARK.md restates it in prose):
 *
 * - defect-detection: macro-F1 over the 7 defect types. Per type t:
 *   F1_t = 2*TP / (2*TP + FP + FN) over all models of the split, with the
 *   convention F1_t = 1 when TP+FP+FN = 0 (no positives exist and none were
 *   predicted). Task score = mean of the 7 F1_t.
 * - quantity-estimation: per model, over the quantity keys whose ground
 *   truth is > 0 (family-applicable keys only):
 *   score_m = mean_k max(0, 1 - |pred_k - truth_k| / truth_k).
 *   Task score = mean of score_m over all models. (Identical shape to the
 *   corpus quantityAccuracy reward channel.)
 * - validity-triage: concordance index against ordinal ground-truth
 *   severity (number of distinct planted defect types, 0-3). Over all model
 *   pairs (i, j) with severity_i != severity_j: 1 if the predicted ordering
 *   agrees, 0.5 if the predictions tie, 0 otherwise; task score = the mean.
 *   0.5 = uninformative, 1 = perfect ranking.
 * - aggregate: unweighted mean of the three task scores; null unless all
 *   three tasks were submitted.
 *
 * The emitted row is deterministic (no timestamps): same submission, same
 * split, same spec version -> byte-identical row.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_NAME, SPEC_VERSION, DEFECT_TYPES, QUANTITY_KEYS, seedsForSplit } from './splits.mjs';
import { groundTruthForSeed } from './ground-truth.mjs';
import { parseSubmission } from './submission.mjs';

function round(v, decimals = 6) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** Macro-F1 over defect types; returns { score, perType }. */
export function scoreDefectDetection(truthBySeed, lines) {
  const perType = {};
  for (const type of DEFECT_TYPES) {
    let tp = 0, fp = 0, fn = 0;
    for (const [seed, truth] of truthBySeed) {
      const predicted = lines.get(seed).defects[type];
      const actual = truth.defects[type];
      if (predicted && actual) tp++;
      else if (predicted && !actual) fp++;
      else if (!predicted && actual) fn++;
    }
    const denom = 2 * tp + fp + fn;
    perType[type] = { tp, fp, fn, f1: denom === 0 ? 1 : round((2 * tp) / denom) };
  }
  const score = round(DEFECT_TYPES.reduce((a, t) => a + perType[t].f1, 0) / DEFECT_TYPES.length);
  return { score, perType };
}

/** Mean per-model quantity agreement; returns { score, perKey }. */
export function scoreQuantityEstimation(truthBySeed, lines) {
  const perKeyAcc = {};
  for (const key of QUANTITY_KEYS) perKeyAcc[key] = { sum: 0, n: 0 };
  let sum = 0;
  let n = 0;
  for (const [seed, truth] of truthBySeed) {
    const pred = lines.get(seed).quantities;
    const scores = [];
    for (const key of QUANTITY_KEYS) {
      const t = truth.quantities[key];
      if (!(t > 0)) continue; // non-applicable for this family
      const s = Math.max(0, 1 - Math.abs(pred[key] - t) / t);
      scores.push(s);
      perKeyAcc[key].sum += s;
      perKeyAcc[key].n += 1;
    }
    if (scores.length === 0) continue;
    sum += scores.reduce((a, b) => a + b, 0) / scores.length;
    n += 1;
  }
  const perKey = {};
  for (const key of QUANTITY_KEYS) {
    perKey[key] = { models: perKeyAcc[key].n, meanScore: perKeyAcc[key].n > 0 ? round(perKeyAcc[key].sum / perKeyAcc[key].n) : null };
  }
  return { score: n > 0 ? round(sum / n) : null, perKey };
}

/** Concordance index of predicted triage vs ordinal severity. */
export function scoreValidityTriage(truthBySeed, lines) {
  // Group by severity to iterate only cross-severity pairs.
  const bySeverity = new Map();
  for (const [seed, truth] of truthBySeed) {
    const arr = bySeverity.get(truth.severity) ?? [];
    arr.push(lines.get(seed).triage);
    bySeverity.set(truth.severity, arr);
  }
  const severities = [...bySeverity.keys()].sort((a, b) => a - b);
  let concordant = 0;
  let ties = 0;
  let total = 0;
  for (let i = 0; i < severities.length; i++) {
    for (let j = i + 1; j < severities.length; j++) {
      const low = bySeverity.get(severities[i]);
      const high = bySeverity.get(severities[j]);
      for (const l of low) {
        for (const h of high) {
          total += 1;
          if (h > l) concordant += 1;
          else if (h === l) ties += 1;
        }
      }
    }
  }
  if (total === 0) return { score: null, pairs: 0, concordant, ties };
  return { score: round((concordant + 0.5 * ties) / total), pairs: total, concordant, ties };
}

/** Score a validated submission; returns the leaderboard row object. */
export function scoreSubmission(header, lines, split, truthBySeed) {
  const tasks = header.tasks;
  const scores = {};
  const detail = {};

  if (tasks.includes('defect-detection')) {
    const r = scoreDefectDetection(truthBySeed, lines);
    scores['defect-detection'] = r.score;
    detail['defect-detection'] = { metric: 'macro-F1 over 7 defect types', perType: r.perType };
  }
  if (tasks.includes('quantity-estimation')) {
    const r = scoreQuantityEstimation(truthBySeed, lines);
    scores['quantity-estimation'] = r.score;
    detail['quantity-estimation'] = { metric: 'mean per-model 1 - relative error (clamped)', perKey: r.perKey };
  }
  if (tasks.includes('validity-triage')) {
    const r = scoreValidityTriage(truthBySeed, lines);
    scores['validity-triage'] = r.score;
    detail['validity-triage'] = { metric: 'concordance index vs planted severity (0.5 = uninformative)', pairs: r.pairs, concordant: r.concordant, ties: r.ties };
  }

  const complete = tasks.length === 3 && Object.values(scores).every((s) => typeof s === 'number');
  const aggregate = complete
    ? round((scores['defect-detection'] + scores['quantity-estimation'] + scores['validity-triage']) / 3)
    : null;

  return {
    benchmark: BENCHMARK_NAME,
    specVersion: SPEC_VERSION,
    split,
    name: header.name,
    tasks,
    models: truthBySeed.size,
    scores: { ...scores, aggregate },
    detail,
  };
}

/** Regenerate ground truth for a whole split. */
export function regenerateTruth(split, { onProgress } = {}) {
  const seeds = seedsForSplit(split);
  const truthBySeed = new Map();
  let done = 0;
  for (const seed of seeds) {
    truthBySeed.set(seed, groundTruthForSeed(seed));
    done++;
    if (onProgress && done % 200 === 0) onProgress(done, seeds.length);
  }
  return truthBySeed;
}

// ============================================================================
// CLI entry point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const submissionPath = getFlag('--submission');
  const split = getFlag('--split');
  const outPath = getFlag('--out');
  const validateOnly = args.includes('--validate-only');

  if (!submissionPath || !split) {
    process.stderr.write('Usage: node score.mjs --submission <file.jsonl> --split train|dev|test [--out row.json] [--validate-only]\n');
    process.exit(1);
  }

  const text = await readFile(submissionPath, 'utf-8');
  const parsed = parseSubmission(text, split);
  if (!parsed.ok) {
    process.stderr.write(`Submission INVALID (${parsed.errors.length}${parsed.errors.length >= 25 ? '+' : ''} error(s)):\n`);
    for (const e of parsed.errors) process.stderr.write(`  - ${e}\n`);
    process.exit(2);
  }
  if (validateOnly) {
    process.stdout.write(JSON.stringify({ valid: true, name: parsed.header.name, split, tasks: parsed.header.tasks, models: parsed.lines.size }, null, 2) + '\n');
    return;
  }

  process.stderr.write(`Regenerating ground truth for split "${split}" (${seedsForSplit(split).length} seeds, spec ${SPEC_VERSION})...\n`);
  const t0 = performance.now();
  const truthBySeed = regenerateTruth(split, {
    onProgress: (done, total) => process.stderr.write(`  ${done}/${total}\n`),
  });
  process.stderr.write(`  done in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);

  const row = scoreSubmission(parsed.header, parsed.lines, split, truthBySeed);
  const json = JSON.stringify(row, null, 2);
  if (outPath) await writeFile(outPath, `${json}\n`, 'utf-8');
  process.stdout.write(`${json}\n`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
