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
import { saltFingerprint } from '../../../tools/world-gym/lib/salt.mjs';
import {
  SPEC_VERSION, CORRUPT_RATE, FAMILY,
  REPORTING_SPLIT, seedsForSplit,
} from '../../../tools/world-gym/benchmark/splits.mjs';
import { regenerateTruth } from '../../../tools/world-gym/benchmark/score.mjs';
import { cleanTwinDiffPrediction } from '../../../tools/world-gym/benchmark/attacks/clean-twin-diff.mjs';
import { alwaysCleanPrediction, heuristicPrediction } from '../../../tools/world-gym/benchmark/baselines.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

import { EXAM_SALTS, NULL_SALTS } from './lib/salts.mjs';

import { round, mean, pearson, band } from './lib/stats.mjs';
import { scoreThroughRealPipeline } from './lib/submission-run.mjs';
import { verdictDiagnostics } from './lib/diagnostics.mjs';
import { bruteForce32Probe } from './lib/brute-force.mjs';


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
  // Two sigma of the analytic null for a correlation on `seeds.length` models.
  // Under independence n*phi^2 ~ chi^2(1), so sigma is 1/sqrt(n) and this is
  // the z<=2 clause expressed in MCC units. Derived, never hard-coded.
  const mccTwoSigmaBound = round(2 / Math.sqrt(seeds.length), 6);
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
      // The bound the verdict applies, derived from n rather than chosen, with
      // the observed worst case beside it so the margin is legible without
      // knowing that 2 sigma at 1,000 models is 0.063.
      mccTwoSigmaBound,
      mccWorstArmMarginSigma: round(max(mccZScores.map(Math.abs)), 3),
      // WHY AN ARM CAN SIT AT n-of-n ON THE AGGREGATE AND STILL PASS. exam-C
      // beats every null on the aggregate. That is DIAGNOSTIC: macro-F1's null
      // spread is driven by how many positives a submission emits, so it cannot
      // separate lucky marginals from residual signal, and the per-arm
      // marginal-rate probe shows the attack does not out-emit the nulls. The
      // verdict is the Matthews correlation, which is 0 for any prediction
      // independent of the truth. Recorded so the outlier is not read as an
      // unexplained anomaly next to a PASS.
      aggregateOutlierArms: saltedArms
        .filter((a) => a.nullDistribution.aggregate.nullSamplesBelowObserved === a.nullDistribution.n)
        .map((a) => a.universe),
      aggregateOutlierIsDiagnosticNotVerdict: true,
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
      //
      // THE BOUND IS IN SIGMA, NOT A CONSTANT. This used to AND a bare
      // `|mcc| <= 0.05` with the z clause; at n=1000 that constant is 1.58
      // sigma, so it was the binding one and exam-C sat 3% under it. A
      // correlation threshold that does not scale with n is a coincidence, not
      // a threshold. It is now 2 sigma = 2/sqrt(n) - the z clause in MCC units,
      // so the two cannot drift apart.
      //
      // STATE THE DIRECTION HONESTLY: this LOOSENED the binding bound, from
      // 1.581 sigma to 2.000 sigma (0.05 -> 0.063246, +26.5%), on the one arm
      // that was closest to failing. The reason that is a correction and not a
      // convenient one is NOT the third clause below - it is that the old bound
      // still passes on today's numbers (0.048437 <= 0.05), so no measurement
      // was made to pass by changing it. If that ever stops being true, this
      // reparametrization must be re-argued rather than relied on.
      //
      // The third clause is genuinely weak and is not offered as the offset: it
      // can only bind outside the nulls' own spread, which for exam-C reaches
      // 0.072645 - past the 2 sigma bound - so on the arm that motivated it the
      // clause has no power at all. It is kept because it is the only clause
      // that is RANGE-valued: it asks whether the observation lies inside the
      // interval the nulls actually produced, at BOTH ends. A large negative
      // correlation is as much a leak as a positive one - an inverted predictor
      // is a predictor - and the original `observed <= max` form let one
      // through. Range containment is strictly stronger than comparing
      // magnitudes: an observation below every null still fails it even when
      // some null happens to have a larger positive magnitude.
      attackRetainsNoInformation: mccAfter.every((v) => Math.abs(v) <= mccTwoSigmaBound)
        && max(mccZScores.map(Math.abs)) <= 2
        && saltedArms.every((a) => a.nullDistribution.mccAnyDefect.observed
            >= a.nullDistribution.mccAnyDefect.min
          && a.nullDistribution.mccAnyDefect.observed
            <= a.nullDistribution.mccAnyDefect.max),
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
