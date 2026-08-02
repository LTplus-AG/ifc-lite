#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B4.3 exam runner - does the per-split salt actually close the clean-twin
 * channel, and can that be measured WITHOUT the hosted scorer?
 *
 * THE INSIGHT THIS SCRIPT TESTS. B4.3's exam clause is "`clean-twin-diff`
 * scores at or below the always-clean anchor on the reporting split", and the
 * finishing plan recorded it as unrunnable until hosting exists. That is true
 * of the TRUST model and false of the MECHANISM. Hosting is how a submitter who
 * cannot regenerate the split receives it; it is not part of what makes the
 * split unregenerable. The salt is. So the exam runs locally today: stand up a
 * salted reporting split in-process, run the committed attack WITHOUT the salt
 * (which is exactly the adversary's position - the salt is the one thing they
 * do not have, and hosting would not have given it to them either), and score
 * it through the real scorer.
 *
 * WHAT IS MEASURED, per exam salt, all on the reporting split (test, 1,000
 * models), every row produced by the REAL submission round-trip (submission
 * JSONL -> parseSubmission -> scoreSubmission):
 *
 *   attack-no-salt      the exam. The committed attack, unchanged, against a
 *                       salted universe.
 *   attack-with-salt    the control. The same attack handed the secret. If this
 *                       is not ~1.000 the harness is broken and the exam number
 *                       means nothing.
 *   attack-wrong-salt   the uninformed reference. The attack run under a
 *                       DIFFERENT salt: a submission built from a valid but
 *                       unrelated universe, i.e. what "knows nothing about this
 *                       split" scores. attack-no-salt should land in this
 *                       distribution.
 *   always-clean        the anchor the exam clause names.
 *   heuristic-text      an HONEST submitter, reading the salted bytes it was
 *                       served. This is the arm that decides whether the salt
 *                       is a fix or just damage: if it fell too, the salt would
 *                       have broken the benchmark rather than defended it.
 *
 * Plus the unsalted control arm (today's state) so the before/after is one
 * table, and a brute-force probe that measures why the salted RNG had to be
 * keyed rather than hashed (lib/salt.mjs explains the reasoning; this measures
 * the number).
 *
 * Usage:
 *   node scripts/moonshot/b43-benchmark-salt/run.mjs [--out-dir <dir>] [--split test]
 *
 * Writes scorecard.json next to this file. Submission JSONLs go to --out-dir
 * (default: a temp dir), never the repo.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { generateModel } from '../../../tools/world-gym/generator.mjs';
import { Rng, mulberry32, hashSeed } from '../../../tools/world-gym/lib/rng.mjs';
import { saltFingerprint } from '../../../tools/world-gym/lib/salt.mjs';
import {
  BENCHMARK_NAME, SPEC_VERSION, CORRUPT_RATE, FAMILY, TASK_NAMES, DEFECT_TYPES,
  REPORTING_SPLIT, seedsForSplit,
} from '../../../tools/world-gym/benchmark/splits.mjs';
import { parseSubmission } from '../../../tools/world-gym/benchmark/submission.mjs';
import { regenerateTruth, scoreSubmission } from '../../../tools/world-gym/benchmark/score.mjs';
import { cleanTwinDiffPrediction } from '../../../tools/world-gym/benchmark/attacks/clean-twin-diff.mjs';
import { alwaysCleanPrediction, heuristicPrediction } from '../../../tools/world-gym/benchmark/baselines.mjs';
import { FAMILIES } from '../../../tools/world-gym/generator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * PUBLISHED exam salts. These are NOT production salts and must never be used
 * as one - they are in the repo so that anyone can re-run this exam and get the
 * same digits. A production salt is 32 CSPRNG bytes that exist only in the
 * scoring service's environment (BENCHMARK.md section 1b).
 */
const EXAM_SALTS = [
  { label: 'exam-A', value: 'b43-exam-salt-A-4f7c0b1e9d2a48c65e81b0f4a7c93d26' },
  { label: 'exam-B', value: 'b43-exam-salt-B-1a9e6c3d70b84f25a6d3e8c9147b0f5a' },
  { label: 'exam-C', value: 'b43-exam-salt-C-c50d2f8b46e91a37d8f0b62c5e4a9713' },
];

/**
 * NUISANCE salts for the null distribution. Each one is a valid universe that
 * has nothing to do with the exam universes, so a submission built under it is
 * a sample of "a well-formed submission that knows nothing about this split".
 * That distribution - not the always-clean floor - is what an information-free
 * attack should be indistinguishable from, and it is the only way to say
 * "retains nothing" with a number instead of an adjective.
 */
const NULL_SALTS = Array.from({ length: 24 }, (_, i) => ({
  label: `null-${i + 1}`,
  value: `b43-null-salt-${i + 1}-6d0f4b8c2e17a935d84c0be6f27a1350`,
}));

const round = (v, d = 6) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

function submissionText(name, split, predictions) {
  const header = { type: 'header', benchmark: BENCHMARK_NAME, specVersion: SPEC_VERSION, split, name, tasks: TASK_NAMES };
  return [header, ...predictions].map((o) => JSON.stringify(o)).join('\n') + '\n';
}

/** Score one prediction set through the real submission path. Returns the row. */
async function scoreThroughRealPipeline({ name, split, predictions, truthBySeed, salt, outDir, write = true }) {
  const text = submissionText(name, split, predictions);
  if (write) await writeFile(join(outDir, `submission-${name}-${split}.jsonl`), text, 'utf-8');
  const parsed = parseSubmission(text, split);
  if (!parsed.ok) {
    throw new Error(`"${name}" produced an invalid submission:\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return scoreSubmission(parsed.header, parsed.lines, split, truthBySeed, { salt });
}

/**
 * Diagnostics the leaderboard row does not carry, computed against the same
 * truth: how often the submission's 7-defect verdict vector is EXACTLY the
 * truth vector, and how often it is exactly right on the models that actually
 * carry a defect. The first is the cleanest statement of what the twin diff
 * was doing (1.000 = it reconstructed the answer key) and of what it does after
 * the salt.
 */
function verdictDiagnostics(predictions, truthBySeed) {
  let exact = 0;
  let exactCorrupted = 0;
  let corrupted = 0;
  let predictedPositives = 0;
  // Confusion counts for "does this model carry ANY defect", used for the
  // Matthews correlation below.
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const p of predictions) {
    const truth = truthBySeed.get(p.seed);
    const isCorrupted = Object.values(truth.defects).some(Boolean);
    const saysCorrupted = DEFECT_TYPES.some((t) => p.defects[t]);
    if (isCorrupted) corrupted++;
    if (saysCorrupted && isCorrupted) tp++;
    else if (saysCorrupted && !isCorrupted) fp++;
    else if (!saysCorrupted && isCorrupted) fn++;
    else tn++;
    let same = true;
    for (const t of DEFECT_TYPES) {
      if (p.defects[t]) predictedPositives++;
      if (Boolean(p.defects[t]) !== Boolean(truth.defects[t])) same = false;
    }
    if (same) exact++;
    if (same && isCorrupted) exactCorrupted++;
  }
  // MATTHEWS CORRELATION, and why this is the statistic that settles the
  // question. Every task score in this benchmark is base-rate sensitive: a
  // submission that emits positives at roughly the corpus rate earns macro-F1
  // near that rate, and a submission that guesses plausible volumes earns
  // partial quantity credit, both while knowing nothing. MCC is not: it is 0
  // for any prediction independent of the truth, whatever its marginal rate,
  // and 1 only for exact agreement. So it separates "scored something because
  // the metric pays for plausible guessing" from "retained information about
  // this split", which is the only question B4.3 is asking.
  const denom = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  const mcc = denom === 0 ? 0 : (tp * tn - fp * fn) / denom;
  return {
    exactVerdictVectorRate: round(exact / predictions.length),
    corruptedModels: corrupted,
    exactVerdictVectorOnCorrupted: round(corrupted > 0 ? exactCorrupted / corrupted : null),
    predictedPositiveVerdicts: predictedPositives,
    mccAnyDefect: round(mcc),
  };
}

/**
 * BRUTE-FORCE PROBE: what a salt bolted onto the EXISTING 32-bit stream would
 * have been worth.
 *
 * The unsalted engine is mulberry32 over an FNV-1a hash: 32 bits of state,
 * whatever you concatenate into the key. A salted-by-concatenation stream is
 * therefore one of 2^32 streams, and the served bytes are a free verification
 * oracle - the parameter draws become dimensions in the file. This measures how
 * fast an attacker can test candidates against that oracle, so the cost of the
 * full sweep is a number rather than an assertion. The shipped salted path is
 * keyed into a 128-bit sfc32 state precisely so this sweep does not exist.
 *
 * Honesty about what is measured: the sweep is not run to completion (that is
 * the point - it is measured, then extrapolated). A window that CONTAINS the
 * true key is swept, so the oracle is shown to actually identify it, and the
 * throughput over that window drives the extrapolation.
 */
function bruteForce32Probe(seed) {
  // A real unsalted model of this seed: the attacker's target.
  const model = generateModel(seed, FAMILY, { corruptRate: CORRUPT_RATE });
  const streamKey = `${seed}:params:${model.family}`;
  const trueKey = hashSeed(streamKey);
  const targetParams = JSON.stringify(model.params);
  const paramSpace = FAMILIES[model.family].paramSpace;

  // One candidate test: seed mulberry32 with the candidate state, redraw the
  // parameter set, compare. Exactly what an attacker holding the bytes does.
  const probe = new Rng(0);
  const test = (candidate) => {
    probe._next = mulberry32(candidate);
    probe.draws = 0;
    try {
      return JSON.stringify(paramSpace(probe)) === targetParams;
    } catch {
      return false;
    }
  };

  const SAMPLE = 2_000_000;
  const start = (trueKey - Math.floor(SAMPLE / 2)) >>> 0;
  let hits = 0;
  let foundTrueKey = false;
  const t0 = performance.now();
  for (let i = 0; i < SAMPLE; i++) {
    const candidate = (start + i) >>> 0;
    if (test(candidate)) {
      hits++;
      if (candidate === trueKey) foundTrueKey = true;
    }
  }
  const elapsedS = (performance.now() - t0) / 1000;
  const candidatesPerSecond = SAMPLE / elapsedS;
  const fullSweepSeconds = 2 ** 32 / candidatesPerSecond;
  return {
    note: 'Cost of defeating a salt CONCATENATED into the existing 32-bit stream. Not the shipped design - the shipped salted stream is a 128-bit keyed sfc32, where this sweep is 2^96 times larger.',
    seed,
    family: model.family,
    streamKey,
    sampledCandidates: SAMPLE,
    oracleIdentifiedTrueKey: foundTrueKey,
    candidatesMatchingOracleInSample: hits,
    candidatesPerSecond: Math.round(candidatesPerSecond),
    fullSweepSecondsPerSeed: round(fullSweepSeconds, 1),
    fullSweepCoreHoursPerSeed: round(fullSweepSeconds / 3600, 3),
    fullSweepCoreHoursForSplit: round((fullSweepSeconds * 1000) / 3600, 1),
    unsaltedPathStateBits: 32,
    saltedPathStateBits: 128,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const split = getFlag('--split') ?? REPORTING_SPLIT;
  const outDir = resolve(getFlag('--out-dir') ?? join(tmpdir(), 'b43-benchmark-salt'));
  await mkdir(outDir, { recursive: true });

  const seeds = seedsForSplit(split);
  const log = (s) => process.stderr.write(`${s}\n`);
  log(`B4.3 exam on the reporting split "${split}" (${seeds.length} models, spec ${SPEC_VERSION})`);
  log(`  submissions -> ${outDir}`);

  const t0 = performance.now();

  // --- prediction sets ------------------------------------------------------
  // The attacker's submission does not depend on the salt: they do not have it.
  // Computed ONCE and scored against every universe, which is precisely the
  // adversary's real position.
  log('Building attacker submission (no salt)...');
  const attackNoSalt = seeds.map((s) => cleanTwinDiffPrediction(s));
  const alwaysClean = seeds.map((s) => alwaysCleanPrediction(s));

  const universes = [
    { label: 'unsalted', salt: '' },
    ...EXAM_SALTS.map((s) => ({ label: s.label, salt: s.value })),
  ];

  // Per-universe: truth, the honest baseline reading THAT universe's bytes, and
  // the attack run with THAT universe's salt (the control).
  const perUniverse = new Map();
  for (const u of universes) {
    log(`Universe ${u.label}: truth + honest baseline + salted attack...`);
    const truthBySeed = regenerateTruth(split, { salt: u.salt });
    const heuristic = seeds.map((s) => heuristicPrediction(
      s, generateModel(s, FAMILY, { corruptRate: CORRUPT_RATE, salt: u.salt }).content,
    ));
    const attackWithSalt = u.salt === '' ? null : seeds.map((s) => cleanTwinDiffPrediction(s, { salt: u.salt }));
    perUniverse.set(u.label, { ...u, truthBySeed, heuristic, attackWithSalt });
  }

  // The null sample: submissions built under salts unrelated to any exam
  // universe. Computed once, scored against every salted universe.
  log(`Building ${NULL_SALTS.length} null-distribution submissions...`);
  const nullPredictions = NULL_SALTS.map((s) => ({
    label: s.label,
    predictions: seeds.map((seed) => cleanTwinDiffPrediction(seed, { salt: s.value })),
  }));

  // --- scoring --------------------------------------------------------------
  const arms = [];
  for (const u of universes) {
    const { truthBySeed, heuristic, attackWithSalt } = perUniverse.get(u.label);
    const rows = {};
    const diagnostics = {};

    const add = async (name, predictions) => {
      rows[name] = await scoreThroughRealPipeline({
        name, split, predictions, truthBySeed, salt: u.salt, outDir,
      });
      diagnostics[name] = verdictDiagnostics(predictions, truthBySeed);
    };

    await add('attack-no-salt', attackNoSalt);
    await add('always-clean', alwaysClean);
    await add('heuristic-text', heuristic);
    if (attackWithSalt) await add('attack-with-salt', attackWithSalt);
    // Uninformed reference: this universe scored against a submission built
    // under a different, equally valid salt.
    if (u.salt !== '') {
      const other = EXAM_SALTS.find((s) => s.value !== u.salt);
      await add('attack-wrong-salt', perUniverse.get(other.label).attackWithSalt);
    }

    // The null distribution for THIS universe.
    let nullDistribution = null;
    if (u.salt !== '') {
      const samples = [];
      const mccSamples = [];
      for (const n of nullPredictions) {
        const row = await scoreThroughRealPipeline({
          name: `null-${n.label}`, split, predictions: n.predictions, truthBySeed, salt: u.salt, outDir, write: false,
        });
        samples.push(row.scores.aggregate);
        mccSamples.push(verdictDiagnostics(n.predictions, truthBySeed).mccAnyDefect);
      }
      const observed = rows['attack-no-salt'].scores.aggregate;
      const observedMcc = diagnostics['attack-no-salt'].mccAnyDefect;
      const band = (xs, obs) => ({
        mean: round(mean(xs)),
        stdev: round(stdev(xs), 8),
        min: round(Math.min(...xs)),
        max: round(Math.max(...xs)),
        samples: xs.map((v) => round(v)),
        observed: obs,
        // How many null samples the attack beats. An information-free attack
        // should land mid-pack; 0 or n is where you start looking harder.
        nullSamplesBelowObserved: xs.filter((v) => v < obs).length,
        zScore: round((obs - mean(xs)) / stdev(xs), 3),
      });
      // IS THE AGGREGATE'S NULL SPREAD ABOUT INFORMATION, OR ABOUT MARGINALS?
      // Every submission here emits a different number of positive verdicts,
      // and macro-F1 pays for that independently of whether any of them is
      // right, so the obvious explanation for an outlying aggregate is that the
      // submission emitted more positives than the null samples did. TESTED AND
      // REFUTED - the correlation is weak and signed inconsistently across
      // universes, and the attack does not out-emit the nulls. Recorded rather
      // than deleted: the hypothesis is the one a reader will reach for, and
      // the honest answer is that it is not the explanation.
      const nullPositives = nullPredictions.map((n) => verdictDiagnostics(n.predictions, truthBySeed).predictedPositiveVerdicts);
      const pearson = (xs, ys) => {
        const mx = mean(xs); const my = mean(ys);
        const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
        const den = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
        return den === 0 ? 0 : num / den;
      };
      nullDistribution = {
        n: samples.length,
        aggregate: band(samples, observed),
        mccAnyDefect: band(mccSamples, observedMcc),
        marginalRateProbe: {
          attackPredictedPositives: diagnostics['attack-no-salt'].predictedPositiveVerdicts,
          nullPredictedPositives: nullPositives,
          nullPositivesVsAggregatePearson: round(pearson(nullPositives, samples), 3),
          attackPositivesExceedEveryNull: nullPositives.every((v) => v < diagnostics['attack-no-salt'].predictedPositiveVerdicts),
        },
        // ANALYTIC null for the Matthews correlation. Under independence
        // between prediction and truth, the phi coefficient satisfies
        // n * phi^2 ~ chi^2(1), so phi * sqrt(n) is a standard normal. This is
        // the test the verdict uses, in preference to a z against 8 empirical
        // samples: with 7 degrees of freedom that sample standard deviation is
        // itself +/-30% noise, which is exactly how a 0.048 correlation on
        // 1,000 models - 1.5 sigma, nothing - can be made to look like 2.8.
        mccAnalyticZ: round(observedMcc * Math.sqrt(truthBySeed.size), 3),
        mccAnalyticSigma: round(1 / Math.sqrt(truthBySeed.size), 6),
      };
    }

    arms.push({
      universe: u.label,
      salted: u.salt !== '',
      saltId: saltFingerprint(u.salt),
      nullDistribution,
      rows: Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, {
        aggregate: r.scores.aggregate,
        'defect-detection': r.scores['defect-detection'],
        'quantity-estimation': r.scores['quantity-estimation'],
        'validity-triage': r.scores['validity-triage'],
        ...diagnostics[k],
      }])),
    });
    log(`  ${u.label}: ${Object.entries(rows).map(([k, r]) => `${k}=${r.scores.aggregate}`).join(' ')}`);
  }

  // --- exam verdict ---------------------------------------------------------
  const unsaltedArm = arms.find((a) => a.universe === 'unsalted');
  const saltedArms = arms.filter((a) => a.salted);
  const anchor = unsaltedArm.rows['always-clean'].aggregate;
  const before = unsaltedArm.rows['attack-no-salt'].aggregate;
  const afterValues = saltedArms.map((a) => a.rows['attack-no-salt'].aggregate);
  const controlValues = saltedArms.map((a) => a.rows['attack-with-salt'].aggregate);
  const nullValues = saltedArms.map((a) => a.rows['attack-wrong-salt'].aggregate);
  const honestBefore = unsaltedArm.rows['heuristic-text'].aggregate;
  const honestAfter = saltedArms.map((a) => a.rows['heuristic-text'].aggregate);
  const zScores = saltedArms.map((a) => a.nullDistribution.aggregate.zScore);
  const mccZScores = saltedArms.map((a) => a.nullDistribution.mccAnalyticZ);
  const mccBeforeZ = round(unsaltedArm.rows['attack-no-salt'].mccAnyDefect * Math.sqrt(seeds.length), 3);
  const mccBefore = unsaltedArm.rows['attack-no-salt'].mccAnyDefect;
  const mccAfter = saltedArms.map((a) => a.rows['attack-no-salt'].mccAnyDefect);
  const max = (xs) => xs.reduce((a, b) => Math.max(a, b));
  const min = (xs) => xs.reduce((a, b) => Math.min(a, b));

  log('Brute-force probe (32-bit stream, the design NOT shipped)...');
  const bruteForce = bruteForce32Probe(seeds[0]);

  const scorecard = {
    bet: 'B4.3',
    exam: 'clean-twin-diff scores at or below the always-clean anchor on the reporting split',
    examRunnableLocally: true,
    examRunnableLocallyBecause:
      'The salt, not the hosting, is what makes the split unregenerable. A salted split can be stood up in-process and the committed attack run against it without the salt, which is exactly the adversary position hosting would have left them in.',
    split,
    models: seeds.length,
    specVersion: SPEC_VERSION,
    corruptRate: CORRUPT_RATE,
    examSalts: EXAM_SALTS.map((s) => ({ label: s.label, saltId: saltFingerprint(s.value), published: true })),
    arms,
    summary: {
      examSaltCount: EXAM_SALTS.length,
      nullSamplesPerUniverse: NULL_SALTS.length,
      alwaysCleanAnchor: anchor,
      attackBefore: before,
      attackAfterMean: round(mean(afterValues)),
      attackAfterMin: min(afterValues),
      attackAfterMax: max(afterValues),
      attackAfterValues: afterValues,
      controlWithSaltValues: controlValues,
      uninformedReferenceValues: nullValues,
      uninformedReferenceMean: round(mean(nullValues)),
      nullDistributionZScores: zScores,
      nullDistributionMaxAbsZ: round(max(zScores.map(Math.abs)), 3),
      attackMccBefore: mccBefore,
      attackMccAfter: mccAfter,
      attackMccAfterMean: round(mean(mccAfter)),
      attackMccAnalyticZBefore: mccBeforeZ,
      attackMccAnalyticZAfter: mccZScores,
      attackMccAnalyticZMaxAbsAfter: round(max(mccZScores.map(Math.abs)), 3),
      nullPositivesVsAggregatePearson: saltedArms.map((a) => a.nullDistribution.marginalRateProbe.nullPositivesVsAggregatePearson),
      attackPositivesExceedEveryNull: saltedArms.map((a) => a.nullDistribution.marginalRateProbe.attackPositivesExceedEveryNull),
      honestBaselineBefore: honestBefore,
      honestBaselineAfterValues: honestAfter,
      honestBaselineAfterMean: round(mean(honestAfter)),
      attackAdvantageOverHonestBefore: round(before - honestBefore),
      attackAdvantageOverHonestAfterMean: round(mean(afterValues) - mean(honestAfter)),
      // The single most legible statistic: how often the attack reproduces a
      // corrupted model's exact 7-defect verdict vector. That is what "it
      // reconstructed the answer key" means, and what it stops meaning.
      attackExactVerdictOnCorruptedBefore: unsaltedArm.rows['attack-no-salt'].exactVerdictVectorOnCorrupted,
      attackExactVerdictOnCorruptedAfter: saltedArms.map((a) => a.rows['attack-no-salt'].exactVerdictVectorOnCorrupted),
      attackDefectF1Before: unsaltedArm.rows['attack-no-salt']['defect-detection'],
      attackDefectF1After: saltedArms.map((a) => a.rows['attack-no-salt']['defect-detection']),
      // Scalar restatements of the arrays above. They exist so that REPORT.md
      // can bind every figure it quotes to ONE named field
      // (scripts/moonshot/ci/check-report-numerals.mjs), which is a stronger
      // clearance than "the artifact holds this number somewhere".
      attackDefectF1AfterMean: round(mean(saltedArms.map((a) => a.rows['attack-no-salt']['defect-detection']))),
      attackDefectF1AfterMax: max(saltedArms.map((a) => a.rows['attack-no-salt']['defect-detection'])),
      attackExactVerdictOnCorruptedAfterMax: max(saltedArms.map((a) => a.rows['attack-no-salt'].exactVerdictVectorOnCorrupted)),
      attackMccAfterMax: max(mccAfter),
      controlWithSaltMin: min(controlValues),
      honestBaselineAfterMin: min(honestAfter),
      alwaysCleanAnchorAllUniverses: saltedArms.every((a) => a.rows['always-clean'].aggregate === anchor),
    },
    verdicts: {
      // The clause exactly as written. It FAILS, and not because the mechanism
      // failed - see REPORT.md: always-clean is a degenerate constant
      // predictor that scores BELOW an information-free submission on two of
      // the three tasks (macro-F1 gives 0 to a predictor that never emits a
      // positive; the quantity metric gives 0 to a predictor that answers 0),
      // so the clause asks the attack to score worse than chance.
      clauseAsWritten: mean(afterValues) <= anchor ? 'PASS' : 'FAIL',
      // What the mechanism claim actually is, and what the clause should have
      // said: the attack retains NOTHING about the salted split. Judged on the
      // Matthews correlation, which is 0 for any prediction independent of the
      // truth REGARDLESS of its marginal rate - unlike the aggregate, whose
      // null spread is driven by how many positives a submission happens to
      // emit and which therefore cannot distinguish "lucky marginals" from
      // "residual signal".
      attackRetainsNoInformation: mccAfter.every((v) => Math.abs(v) <= 0.05)
        && max(mccZScores.map(Math.abs)) <= 2,
      controlRestoresAttack: controlValues.every((v) => v >= 0.999),
      honestSubmitterUnharmed: mean(honestAfter) >= honestBefore - 0.02,
      attackNoLongerBeatsHonestBaseline: mean(afterValues) < mean(honestAfter),
      attackNoLongerReconstructsAnswerKey:
        saltedArms.every((a) => a.rows['attack-no-salt'].exactVerdictVectorOnCorrupted <= 0.02),
    },
    bruteForce32Probe: bruteForce,
    runtimeSeconds: round((performance.now() - t0) / 1000, 1),
  };

  await writeFile(join(HERE, 'scorecard.json'), `${JSON.stringify(scorecard, null, 2)}\n`, 'utf-8');
  process.stdout.write(`${JSON.stringify(scorecard.summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(scorecard.verdicts, null, 2)}\n`);
  log(`scorecard -> ${join(HERE, 'scorecard.json')}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
