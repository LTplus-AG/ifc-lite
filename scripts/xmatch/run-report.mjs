/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The console rendering of a scorecard, and the JSON replacer that keeps the
 * stopwatch out of the committed artifact. Split out of `run.mjs` for size;
 * nothing here measures anything.
 */

/** Durations are wall clock and would churn the committed artifact on every
 *  run; the scorecard keeps the measurements, not the stopwatch. */
export function replacer(key, value) {
  return key === 'durationSeconds' ? undefined : value;
}

export function report(scorecard) {
  const line = (text) => process.stdout.write(`${text}\n`);
  for (const pair of scorecard.pairs) {
    line('');
    line(`${pair.model}  (seed ${pair.seed}, ${pair.schema})`);
    line(`  applied: ${JSON.stringify(pair.applied)}`);
    const score = pair.score;
    line(
      `  overall  precision ${score.overall.precision}  recall ${score.overall.recall}` +
        `  (${score.overall.correctPairs}/${score.overall.claimedPairs} pairs, ` +
        `${score.overall.recalled}/${score.overall.recallPopulation} elements, ` +
        `${score.overall.abstained} abstained)`,
    );
    for (const [tier, row] of Object.entries(score.byTier)) {
      line(`  tier  ${tier.padEnd(14)} claimed ${String(row.claimed).padStart(5)}  precision ${row.precision}`);
    }
    for (const [kind, row] of Object.entries(score.byKind)) {
      line(
        `  kind  ${kind.padEnd(14)} n=${String(row.population).padStart(4)}  recall ${row.recall}` +
          `  precision ${row.precision}  kindAgreement ${row.kindAgreement}`,
      );
    }
    for (const [name, row] of Object.entries(score.byClass)) {
      line(`  class ${name.padEnd(14)} n=${String(row.population).padStart(4)}  recall ${row.recall}  precision ${row.precision}`);
    }
    line(
      `  calibration  population ${score.calibration.population}` +
        `  matchedByGeometryHash ${score.calibration.matchedByGeometryHash.length}` +
        `  reportedRenamed ${score.calibration.reportedRenamed.length}` +
        `  recoveredByLowerTiers ${score.calibration.recoveredByLowerTiers}`,
    );
    for (const [name, row] of Object.entries(score.bySuccessor ?? {})) {
      line(
        `  successor ${name.padEnd(10)} n=${String(row.population).padStart(4)}  recall ${row.recall}` +
          `  precision ${row.precision}  kindAgreement ${row.kindAgreement}`,
      );
    }
    for (const [name, row] of Object.entries(score.bySuccessorConfidence ?? {})) {
      line(
        `  reported  ${name.padEnd(10)} claimed ${String(row.claimed).padStart(5)}  precision ${row.precision}`,
      );
    }
    if (score.bySplit) {
      line(
        `  split     n=${String(score.bySplit.population).padStart(4)}  recall ${score.bySplit.recall}` +
          `  precision ${score.bySplit.precision}  kindAgreement ${score.bySplit.kindAgreement}` +
          `  ${JSON.stringify(score.bySplit.byConfidence)}`,
      );
    }
    if (score.byMerge) {
      line(
        `  merge     n=${String(score.byMerge.population).padStart(4)}  recall ${score.byMerge.recall}` +
          `  precision ${score.byMerge.precision}  kindAgreement ${score.byMerge.kindAgreement}` +
          `  ${JSON.stringify(score.byMerge.byConfidence)}`,
      );
    }
    line(
      `  respecified  population ${score.respecifiedControl.population}` +
        `  matchedByGeometryOnly ${score.respecifiedControl.matchedByGeometryOnly}` +
        `  reportedRenamed ${score.respecifiedControl.reportedRenamed.length}`,
    );
    line(`  negative controls  ${JSON.stringify(score.falsePairs)}  ${JSON.stringify(score.falseSuccessors)}`);
    line(
      `  missed  abstained ${score.missed.abstained}  silent ${score.missed.silent}` +
        `  ${JSON.stringify(score.missed.byType)}`,
    );
    line(`  duplicates contained ${score.duplicateContainment.contained}/${score.duplicateContainment.population}`);
    line(`  move distance agreement ${score.moveDistance.agreed}/${score.moveDistance.checked}`);
    for (const skip of pair.thresholdsSkipped) line(`  skipped: ${skip}`);
    for (const gap of pair.targetGaps) line(`  BELOW PRE-REGISTERED TARGET: ${gap}`);
    for (const failure of pair.fixtureFailures) line(`  FIXTURE FAILURE: ${failure}`);
    for (const failure of pair.thresholdFailures) line(`  THRESHOLD FAILURE: ${failure}`);
  }
  line('');
  for (const gap of scorecard.corpusTargetGaps) line(`BELOW PRE-REGISTERED TARGET (corpus): ${gap}`);
  for (const failure of scorecard.corpusFailures) line(`CORPUS FAILURE: ${failure}`);
  line(`verdict: ${scorecard.verdict}`);
}
