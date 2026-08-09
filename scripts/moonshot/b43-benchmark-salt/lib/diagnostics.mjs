/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Verdict-vector diagnostics for the B4.3 exam, split out of run.mjs
 * (AGENTS.md: no module over ~400 non-generated lines).
 *
 * These are the figures the leaderboard row does NOT carry, and they are the
 * ones the verdict actually rests on: an exact-reconstruction rate, and a
 * Matthews correlation that is 0 for any prediction independent of the truth
 * REGARDLESS of its marginal rate - unlike the aggregate, whose null spread is
 * driven by how many positives a submission happens to emit.
 */

import { DEFECT_TYPES } from '../../../../tools/world-gym/benchmark/splits.mjs';
import { round } from './stats.mjs';

/**
 * Diagnostics the leaderboard row does not carry, computed against the same
 * truth: how often the submission's 7-defect verdict vector is EXACTLY the
 * truth vector, and how often it is exactly right on the models that actually
 * carry a defect. The first is the cleanest statement of what the twin diff
 * was doing (1.000 = it reconstructed the answer key) and of what it does after
 * the salt.
 */
export function verdictDiagnostics(predictions, truthBySeed) {
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
