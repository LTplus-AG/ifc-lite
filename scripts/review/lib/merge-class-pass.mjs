/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `class_pass` MERGE ACROSS MODELS (module-size split out of
 * ensemble-reviewer.mjs, #4981 finding-5). `checkClassPass` in
 * defect-classes.mjs only ever runs against ONE model's answer, so it has no
 * merge semantics of its own to reuse; this is the ensemble-specific rule: a
 * class counts as passed in the POOLED answer only when EVERY schema-valid
 * contributing model shows a valid row for it (present, a real
 * `CLASS_VERDICTS` value, a `why` at least `MIN_WHY_CHARS` long) -- one model
 * silently skipping a class is not covered up by the others having covered
 * it. A class no contributing model shows validly is OMITTED, not invented,
 * so `checkClassPass` sees the true gap.
 *
 * The merged verdict for a class prefers `clear` over `not-applicable`: a
 * model claiming `clear` is claiming it looked at real code for that class
 * and it held up, which is stronger evidence.
 *
 * THE MERGED ROW MUST SURVIVE `checkClassPass`, because that is what decides
 * whether the merge's own consumer -- the real validator, run for real on the
 * pooled envelope -- accepts a `clean` verdict at all. Two of its rules are
 * enforced here, not left for the validator to discover downstream:
 *
 *   - `why` must be at least `MIN_WHY_CHARS` long (never checked on a
 *     single-model run either, since `checkClassPass` runs on the MERGED
 *     array, not on each model's raw answer).
 *   - every `why` in the merged array must be DISTINCT, folded the same way
 *     `checkClassPass` folds it. Two different models' rows for two
 *     different classes can carry the same sentence by coincidence; the
 *     preferred resolution is picking a differently-worded candidate for the
 *     colliding class, and only when every candidate collides too is the
 *     source model's name appended to disambiguate.
 *
 * ONE MODEL IS PREFERRED ACROSS CLASSES where it qualifies, for readability
 * only: the model with a valid row for the most classes is tried first for
 * every class, so the merged array reads as mostly one voice. Not
 * load-bearing -- every class still falls through to whichever contributing
 * model actually has a usable, non-colliding row.
 */

import { DEFECT_CLASSES, CLASS_VERDICTS, MIN_WHY_CHARS, normaliseWhy } from './defect-classes.mjs';

/**
 * @param {{model: string, obj: object}[]} parsed schema-valid answers only
 * @returns {object[]|undefined} a `class_pass` array, or `undefined` when no
 *   contributing model supplied one at all (an all-`findings` ensemble, where
 *   `class_pass` is never asked for and `validate()` never reads this field).
 */
export function mergeClassPass(parsed) {
  const withClassPass = parsed.filter((p) => Array.isArray(p.obj?.class_pass));
  if (withClassPass.length === 0) return undefined;

  const rowFor = (obj, cls) => {
    const row = obj.class_pass.find((r) => r && typeof r === 'object' && r.class === cls);
    if (
      !row ||
      !CLASS_VERDICTS.includes(row.verdict) ||
      typeof row.why !== 'string' ||
      row.why.trim().length < MIN_WHY_CHARS
    ) {
      return null;
    }
    return row;
  };

  // Preference only -- see the module doc comment.
  const validCountByModel = new Map(
    withClassPass.map(({ model, obj }) => [model, DEFECT_CLASSES.filter((cls) => rowFor(obj, cls) !== null).length]),
  );
  const anchorModel = [...validCountByModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const usedWhys = new Set();
  const merged = [];
  for (const cls of DEFECT_CLASSES) {
    const candidates = withClassPass
      .map(({ model, obj }) => ({ model, row: rowFor(obj, cls) }))
      .filter((c) => c.row !== null);
    if (candidates.length !== withClassPass.length) continue; // not every contributing model passed this class

    const verdict = candidates.some((c) => c.row.verdict === 'clear') ? 'clear' : 'not-applicable';
    const verdictCandidates = candidates.filter((c) => c.row.verdict === verdict);
    const ordered = [
      ...verdictCandidates.filter((c) => c.model === anchorModel),
      ...verdictCandidates.filter((c) => c.model !== anchorModel),
    ];

    const nonColliding = ordered.find((c) => !usedWhys.has(normaliseWhy(c.row.why)));
    const chosen = nonColliding ?? ordered[0];
    let why = chosen.row.why.trim();
    if (usedWhys.has(normaliseWhy(why))) {
      // Every candidate for this class collides with a `why` a previous class
      // already claimed. Disambiguated by naming the source model rather than
      // shipping a merged array `checkClassPass` would refuse for a repeated
      // sentence.
      why = `${why} (per ${chosen.model})`;
    }
    usedWhys.add(normaliseWhy(why));
    merged.push({ class: cls, verdict, why });
  }
  return merged;
}
