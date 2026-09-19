/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The gating half of the scorer: per-pair and corpus floors from
 * `thresholds.json`, and the pre-registered target gaps. Split out of
 * `score.mjs` for size; re-exported from there so `run.mjs` imports one
 * module.
 */

/**
 * Check one pair's scorecard against the PRE-REGISTERED per-pair thresholds.
 *
 * Returns `{ failures, skipped }`. A stratum this model does not populate is
 * SKIPPED rather than failed — one model has no arcs to re-sample, another no
 * geometry-free objects — and the corpus clauses below are what guarantee the
 * stratum exists somewhere and clears its floor in aggregate. Skips are
 * reported, so "everything was skipped" can never read as a pass.
 */
export function checkThresholds(score, thresholds) {
  const failures = [];
  const skipped = [];
  const floor = (label, value, minimum) => {
    if (minimum === undefined) return;
    if (value === null || value === undefined) failures.push(`${label}: no measurement (floor ${minimum})`);
    else if (value < minimum) failures.push(`${label}: ${value} < floor ${minimum}`);
  };
  const ceiling = (label, value, maximum) => {
    if (maximum === undefined) return;
    if (value > maximum) failures.push(`${label}: ${value} > ceiling ${maximum}`);
  };

  floor('overall.precision', score.overall.precision, thresholds.overall?.precision);
  floor('overall.recall', score.overall.recall, thresholds.overall?.recall);

  for (const [name, minimum] of Object.entries(thresholds.byTier?.precision ?? {})) {
    const row = score.byTier[name];
    if (!row || row.claimed === 0) skipped.push(`byTier.${name}.precision (no pairs)`);
    else floor(`byTier.${name}.precision`, row.precision, minimum);
  }
  for (const [name, floors] of Object.entries(thresholds.byKind ?? {})) {
    const row = score.byKind[name];
    if (!row || row.population === 0) {
      skipped.push(`byKind.${name} (population 0)`);
      continue;
    }
    floor(`byKind.${name}.recall`, row.recall, floors.recall);
    // An unevaluable clause SAYS SO. Silently not running is how seven
    // precision floors sat inert while thresholds.json read as if they were
    // enforced; a skip line is the difference between "not applicable here"
    // and "quietly not checked".
    if (row.claimed > 0) floor(`byKind.${name}.precision`, row.precision, floors.precision);
    else if (floors.precision !== undefined) skipped.push(`byKind.${name}.precision (no pairs claimed)`);
    if (row.recalled > 0) floor(`byKind.${name}.kindAgreement`, row.kindAgreement, floors.kindAgreement);
    else if (floors.kindAgreement !== undefined) {
      skipped.push(`byKind.${name}.kindAgreement (nothing recalled)`);
    }
  }
  for (const [name, floors] of Object.entries(thresholds.byClass ?? {})) {
    const row = score.byClass[name];
    if (!row || row.population === 0) {
      skipped.push(`byClass.${name} (population 0)`);
      continue;
    }
    floor(`byClass.${name}.recall`, row.recall, floors.recall);
    if (row.claimed > 0) floor(`byClass.${name}.precision`, row.precision, floors.precision);
    else if (floors.precision !== undefined) skipped.push(`byClass.${name}.precision (no pairs claimed)`);
  }

  // Successor strata (issue #4955): recall per EXPECTED profile, precision per
  // expected and per REPORTED profile, confidence agreement. Skips are named
  // for the same reason as above.
  for (const [name, floors] of Object.entries(thresholds.bySuccessor ?? {})) {
    const row = score.bySuccessor?.[name];
    if (!row || row.population === 0) {
      skipped.push(`bySuccessor.${name} (population 0)`);
      continue;
    }
    floor(`bySuccessor.${name}.recall`, row.recall, floors.recall);
    if (row.claimed > 0) floor(`bySuccessor.${name}.precision`, row.precision, floors.precision);
    else if (floors.precision !== undefined) skipped.push(`bySuccessor.${name}.precision (no claims)`);
    if (row.recalled > 0) floor(`bySuccessor.${name}.kindAgreement`, row.kindAgreement, floors.kindAgreement);
    else if (floors.kindAgreement !== undefined) {
      skipped.push(`bySuccessor.${name}.kindAgreement (nothing recalled)`);
    }
  }
  for (const [name, minimum] of Object.entries(thresholds.bySuccessorConfidence?.precision ?? {})) {
    const row = score.bySuccessorConfidence?.[name];
    if (!row || row.claimed === 0) skipped.push(`bySuccessorConfidence.${name}.precision (no claims)`);
    else floor(`bySuccessorConfidence.${name}.precision`, row.precision, minimum);
  }
  if (thresholds.bySplit) {
    const row = score.bySplit;
    // A model with no split population can still receive a WRONG claim, and
    // a per-pair precision floor over one claim would have to be 0 to be
    // green anywhere. So it is skipped here, NAMED with the claim count, and
    // `corpus.bySplit.precision` below is what counts that claim.
    if (!row || row.population === 0) {
      const note = row?.claimed ? `, ${row.claimed} claim(s) counted by corpus.bySplit.precision` : '';
      skipped.push(`bySplit (population 0${note})`);
    } else {
      floor('bySplit.recall', row.recall, thresholds.bySplit.recall);
      if (row.claimed > 0) floor('bySplit.precision', row.precision, thresholds.bySplit.precision);
      else if (thresholds.bySplit.precision !== undefined) skipped.push('bySplit.precision (no claims)');
      if (row.recalled > 0) {
        floor('bySplit.kindAgreement', row.kindAgreement, thresholds.bySplit.kindAgreement);
      } else if (thresholds.bySplit.kindAgreement !== undefined) {
        skipped.push('bySplit.kindAgreement (nothing recalled)');
      }
    }
  }
  // The `merge` direction (issue #4989), mirroring `bySplit` exactly above.
  if (thresholds.byMerge) {
    const row = score.byMerge;
    if (!row || row.population === 0) {
      const note = row?.claimed ? `, ${row.claimed} claim(s) counted by corpus.byMerge.precision` : '';
      skipped.push(`byMerge (population 0${note})`);
    } else {
      floor('byMerge.recall', row.recall, thresholds.byMerge.recall);
      if (row.claimed > 0) floor('byMerge.precision', row.precision, thresholds.byMerge.precision);
      else if (thresholds.byMerge.precision !== undefined) skipped.push('byMerge.precision (no claims)');
      if (row.recalled > 0) {
        floor('byMerge.kindAgreement', row.kindAgreement, thresholds.byMerge.kindAgreement);
      } else if (thresholds.byMerge.kindAgreement !== undefined) {
        skipped.push('byMerge.kindAgreement (nothing recalled)');
      }
    }
  }

  const negative = thresholds.negativeControls ?? {};
  ceiling('falsePairs.deletedBase', score.falsePairs.deletedBase, negative.deletedBase);
  ceiling('falsePairs.insertedHead', score.falsePairs.insertedHead, negative.insertedHead);
  ceiling('falsePairs.wrongPartner', score.falsePairs.wrongPartner, negative.wrongPartner);
  ceiling('falsePairs.unkeyed', score.falsePairs.unkeyed, negative.unkeyed);
  ceiling(
    'falseSuccessors.insertedNearby',
    score.falseSuccessors?.insertedNearby ?? 0,
    negative.successorInsertedNearby,
  );
  ceiling(
    'falseSuccessors.neighbourSuccessor',
    score.falseSuccessors?.neighbourSuccessor ?? 0,
    negative.neighbourSuccessor,
  );
  ceiling(
    'respecifiedControl.reportedRenamed',
    score.respecifiedControl?.reportedRenamed.length ?? 0,
    negative.respecifiedReportedRenamed,
  );

  const cal = thresholds.calibration ?? {};
  ceiling(
    'calibration.matchedByGeometryHash',
    score.calibration.matchedByGeometryHash.length,
    cal.matchedByGeometryHash,
  );
  ceiling('calibration.reportedRenamed', score.calibration.reportedRenamed.length, cal.reportedRenamed);

  if (score.anomalies.length > 0) {
    failures.push(`engine anomalies: ${score.anomalies.join('; ')}`);
  }
  return { failures, skipped };
}

/**
 * Check the corpus as a whole: does the exam ask its questions at all, and do
 * the rates whose stratum a single model may not populate hold in aggregate?
 *
 * The population floors are the anti-vacuity clauses. Without them a mutation
 * that silently stopped being applied — an eligibility predicate that now
 * matches nothing, a model swapped for one without arcs — would show up as a
 * *green* run over a smaller exam, which is exactly the failure mode this
 * whole fixture exists to make impossible.
 */
export function checkCorpusThresholds(scores, thresholds) {
  const failures = [];
  const sum = (pick) => scores.reduce((total, score) => total + (pick(score) ?? 0), 0);

  for (const [kind, minimum] of Object.entries(thresholds.populations ?? {})) {
    const total =
      kind === 'curved'
        ? sum((score) => score.byClass.curved?.population)
        : kind === 'inserted'
          ? sum((score) => score.inserted)
          : kind === 'insertedNearby'
            ? sum((score) => score.insertedNearby)
            : // #4989: `score.populations.merged` counts `key.elements` ROWS (two
              // per pair — a primary and its donor), but the pre-registered
              // count is PAIRS (mirroring `splitLength`, one row per split).
              // `byMerge.population` is the pair count `scoreMerges` itself
              // uses as its recall denominator, so this is the same number
              // that stratum's floors are measured against.
              kind === 'merged'
              ? sum((score) => score.byMerge?.population)
              : sum((score) => score.populations[kind]);
    if (total < minimum) failures.push(`corpus.populations.${kind}: ${total} < floor ${minimum}`);
  }
  for (const [tier, minimum] of Object.entries(thresholds.tierPairs ?? {})) {
    const total = sum((score) => score.byTier[tier]?.claimed);
    if (total < minimum) failures.push(`corpus.tierPairs.${tier}: ${total} < floor ${minimum}`);
  }

  const rate = (label, hits, total, minimum) => {
    if (minimum === undefined) return;
    if (total === 0) failures.push(`${label}: nothing measured (floor ${minimum})`);
    else if (hits / total < minimum) {
      failures.push(`${label}: ${(hits / total).toFixed(4)} < floor ${minimum}`);
    }
  };
  rate(
    'corpus.calibration.recoveredByLowerTiers',
    sum((score) => score.calibration.recovered),
    sum((score) => score.calibration.population),
    thresholds.calibration?.recoveredByLowerTiers,
  );
  rate(
    'corpus.duplicateContainment.rate',
    sum((score) => score.duplicateContainment.contained),
    sum((score) => score.duplicateContainment.population),
    thresholds.duplicateContainment?.rate,
  );
  rate(
    'corpus.moveDistance.agreement',
    sum((score) => score.moveDistance.agreed),
    sum((score) => score.moveDistance.checked),
    thresholds.moveDistance?.agreement,
  );
  // The claim strata in aggregate (issue #4955). Per-pair floors skip a model
  // whose population is 0, so a wrong split claim on such a model — AC20's
  // duplicated stair, finding F5 — is only ever counted here; and the
  // `position` profile's recall is a corpus question because one model's
  // unnamed building (F4) switches the profile off there entirely.
  rate(
    'corpus.bySplit.precision',
    sum((score) => score.bySplit?.correct),
    sum((score) => score.bySplit?.claimed),
    thresholds.bySplit?.precision,
  );
  rate(
    'corpus.bySplit.recall',
    sum((score) => score.bySplit?.recalled),
    sum((score) => score.bySplit?.population),
    thresholds.bySplit?.recall,
  );
  // The `merge` direction (issue #4989), mirroring `bySplit` immediately above.
  rate(
    'corpus.byMerge.precision',
    sum((score) => score.byMerge?.correct),
    sum((score) => score.byMerge?.claimed),
    thresholds.byMerge?.precision,
  );
  rate(
    'corpus.byMerge.recall',
    sum((score) => score.byMerge?.recalled),
    sum((score) => score.byMerge?.population),
    thresholds.byMerge?.recall,
  );
  for (const [name, floors] of Object.entries(thresholds.bySuccessor ?? {})) {
    rate(
      `corpus.bySuccessor.${name}.recall`,
      sum((score) => score.bySuccessor?.[name]?.recalled),
      sum((score) => score.bySuccessor?.[name]?.population),
      floors.recall,
    );
    rate(
      `corpus.bySuccessor.${name}.precision`,
      sum((score) => score.bySuccessor?.[name]?.correct),
      sum((score) => score.bySuccessor?.[name]?.claimed),
      floors.precision,
    );
  }
  // Corpus-TOTAL ceilings on the successor negative controls: a per-pair
  // ceiling raised to one model's measured count would let every other
  // model climb to it unnoticed.
  const totalCeiling = (label, total, maximum) => {
    if (maximum === undefined) return;
    if (total > maximum) failures.push(`${label}: ${total} > ceiling ${maximum}`);
  };
  totalCeiling(
    'corpus.falseSuccessors.insertedNearby',
    sum((score) => score.falseSuccessors?.insertedNearby),
    thresholds.falseSuccessors?.insertedNearby,
  );
  totalCeiling(
    'corpus.falseSuccessors.neighbourSuccessor',
    sum((score) => score.falseSuccessors?.neighbourSuccessor),
    thresholds.falseSuccessors?.neighbourSuccessor,
  );
  return failures;
}

export { corpusTargetGaps, targetGaps } from './score-thresholds-gaps.mjs';
