/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pre-registered-target GAP reports (issue #4955/#4989): corpus-level and
 * per-pair, both reported-never-gating. Split out of `score-thresholds.mjs`
 * for the module-size house rule (AGENTS.md); re-exported from there so
 * `score.mjs` (and `run.mjs` through it) imports one module.
 */

/**
 * Corpus-level strata measuring BELOW (or, for ceilings, above) their
 * pre-registered target — reported, never gating, like {@link targetGaps}.
 */
export function corpusTargetGaps(scores, targets) {
  const gaps = [];
  const sum = (pick) => scores.reduce((total, score) => total + (pick(score) ?? 0), 0);
  const compare = (label, hits, total, target) => {
    if (target === undefined || total === 0) return;
    const value = Number((hits / total).toFixed(6));
    if (value < target) gaps.push(`${label}: ${value} < target ${target}`);
  };
  compare(
    'corpus.bySplit.precision',
    sum((score) => score.bySplit?.correct),
    sum((score) => score.bySplit?.claimed),
    targets.bySplit?.precision,
  );
  compare(
    'corpus.bySplit.recall',
    sum((score) => score.bySplit?.recalled),
    sum((score) => score.bySplit?.population),
    targets.bySplit?.recall,
  );
  compare(
    'corpus.byMerge.precision',
    sum((score) => score.byMerge?.correct),
    sum((score) => score.byMerge?.claimed),
    targets.byMerge?.precision,
  );
  compare(
    'corpus.byMerge.recall',
    sum((score) => score.byMerge?.recalled),
    sum((score) => score.byMerge?.population),
    targets.byMerge?.recall,
  );
  for (const [name, wanted] of Object.entries(targets.bySuccessor ?? {})) {
    compare(
      `corpus.bySuccessor.${name}.recall`,
      sum((score) => score.bySuccessor?.[name]?.recalled),
      sum((score) => score.bySuccessor?.[name]?.population),
      wanted.recall,
    );
  }
  const exceed = (label, total, target) => {
    if (target !== undefined && total > target) gaps.push(`${label}: ${total} > target ${target}`);
  };
  exceed(
    'corpus.falseSuccessors.insertedNearby',
    sum((score) => score.falseSuccessors?.insertedNearby),
    targets.negativeControls?.successorInsertedNearby,
  );
  exceed(
    'corpus.falseSuccessors.neighbourSuccessor',
    sum((score) => score.falseSuccessors?.neighbourSuccessor),
    targets.negativeControls?.neighbourSuccessor,
  );
  return gaps;
}

/**
 * Strata measuring BELOW their pre-registered target — reported, never gating.
 *
 * The gating floors are a ratchet against regression; these are the original
 * pre-registration, and the difference between them is a standing debt. A
 * fixture that quietly replaced its aspiration with its measurement would be
 * green and would have forgotten what it was for, which is the same failure as
 * a check that cannot fail, one level up.
 */
export function targetGaps(score, targets) {
  const gaps = [];
  const compare = (label, value, target) => {
    if (target === undefined || value === null || value === undefined) return;
    if (value < target) gaps.push(`${label}: ${value} < target ${target}`);
  };

  compare('overall.precision', score.overall.precision, targets.overall?.precision);
  compare('overall.recall', score.overall.recall, targets.overall?.recall);
  for (const [name, target] of Object.entries(targets.byTier?.precision ?? {})) {
    const row = score.byTier[name];
    if (row && row.claimed > 0) compare(`byTier.${name}.precision`, row.precision, target);
  }
  for (const [name, wanted] of Object.entries(targets.byKind ?? {})) {
    const row = score.byKind[name];
    if (!row || row.population === 0) continue;
    compare(`byKind.${name}.recall`, row.recall, wanted.recall);
    if (row.claimed > 0) compare(`byKind.${name}.precision`, row.precision, wanted.precision);
    if (row.recalled > 0) {
      compare(`byKind.${name}.kindAgreement`, row.kindAgreement, wanted.kindAgreement);
    }
  }
  for (const [name, wanted] of Object.entries(targets.byClass ?? {})) {
    const row = score.byClass[name];
    if (!row || row.population === 0) continue;
    compare(`byClass.${name}.recall`, row.recall, wanted.recall);
    if (row.claimed > 0) compare(`byClass.${name}.precision`, row.precision, wanted.precision);
  }
  for (const [name, wanted] of Object.entries(targets.bySuccessor ?? {})) {
    const row = score.bySuccessor?.[name];
    if (!row || row.population === 0) continue;
    compare(`bySuccessor.${name}.recall`, row.recall, wanted.recall);
    if (row.claimed > 0) compare(`bySuccessor.${name}.precision`, row.precision, wanted.precision);
    if (row.recalled > 0) {
      compare(`bySuccessor.${name}.kindAgreement`, row.kindAgreement, wanted.kindAgreement);
    }
  }
  for (const [name, target] of Object.entries(targets.bySuccessorConfidence?.precision ?? {})) {
    const row = score.bySuccessorConfidence?.[name];
    if (row && row.claimed > 0) compare(`bySuccessorConfidence.${name}.precision`, row.precision, target);
  }
  if (targets.bySplit && score.bySplit && score.bySplit.population > 0) {
    compare('bySplit.recall', score.bySplit.recall, targets.bySplit.recall);
    if (score.bySplit.claimed > 0) {
      compare('bySplit.precision', score.bySplit.precision, targets.bySplit.precision);
    }
    if (score.bySplit.recalled > 0) {
      compare('bySplit.kindAgreement', score.bySplit.kindAgreement, targets.bySplit.kindAgreement);
    }
  }
  if (targets.byMerge && score.byMerge && score.byMerge.population > 0) {
    compare('byMerge.recall', score.byMerge.recall, targets.byMerge.recall);
    if (score.byMerge.claimed > 0) {
      compare('byMerge.precision', score.byMerge.precision, targets.byMerge.precision);
    }
    if (score.byMerge.recalled > 0) {
      compare('byMerge.kindAgreement', score.byMerge.kindAgreement, targets.byMerge.kindAgreement);
    }
  }
  // Ceilings have targets too: a negative control whose gating ceiling had to
  // be raised to the measured count still reports the distance to zero.
  const exceed = (label, value, target) => {
    if (target === undefined || value === undefined) return;
    if (value > target) gaps.push(`${label}: ${value} > target ${target}`);
  };
  const negative = targets.negativeControls ?? {};
  exceed(
    'falseSuccessors.insertedNearby',
    score.falseSuccessors?.insertedNearby,
    negative.successorInsertedNearby,
  );
  exceed(
    'falseSuccessors.neighbourSuccessor',
    score.falseSuccessors?.neighbourSuccessor,
    negative.neighbourSuccessor,
  );
  exceed(
    'respecifiedControl.reportedRenamed',
    score.respecifiedControl?.reportedRenamed.length,
    negative.respecifiedReportedRenamed,
  );
  return gaps;
}
