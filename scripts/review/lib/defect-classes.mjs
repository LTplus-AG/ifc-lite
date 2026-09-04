/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE DEFECT CLASSES, AND THE PER-CLASS PASS A CLEAN VERDICT HAS TO SHOW (#3831).
 *
 * WHY THIS EXISTS. `rubric.md` has listed these classes since the lane shipped,
 * and listing them changed nothing measurable: three live evaluations scored
 * 1-3/15 recall over 18 real pull requests, with 13-14 of them returning `clean`
 * and zero findings, and Opus scored the same 2/15 -- so the gap is not model
 * capacity. What the rubric never did was make `clean` CONDITIONAL on walking
 * the list. A model that spots one obvious duplicate-site defect and stops
 * produced output byte-indistinguishable from one that walked all twelve classes
 * and genuinely found nothing, and the harness had no way to tell them apart.
 *
 * So `clean` now costs a per-class verdict with a stated reason, and this module
 * is the ONE place the class list lives. `rubric.md` prints the ids to the model
 * and `finding-schema.mjs` checks the answer against the same array, so the
 * prompt and the validator cannot ask for and enforce different lists --
 * `defect-classes.test.mjs` fails if an id here is missing from the rubric text.
 *
 * WHAT THIS IS NOT. It does not decide whether a finding is real, and it never
 * turns `clean` into `findings`: a reviewer that walks all twelve and reports
 * every one clear still gets a clean verdict posted. It refuses only the answer
 * that skipped the walk, which is the one the eval measured 13-14 times out of
 * 18.
 */

import { ValidateFindingsError } from './validate-findings-error.mjs';

/**
 * Every class `rubric.md` names under "What to look for", plus
 * `injection-attempt` from the untrusted-input section -- which belongs here for
 * the same reason the rest do: the rubric tells the model to report one as a
 * finding, and a reviewer that never looked at the fenced text is exactly the
 * reviewer that reports it never saw one.
 *
 * ORDER IS THE RUBRIC'S ORDER, so a reader comparing the two files reads the
 * same sequence. The check below is order-insensitive; this is for humans.
 */
export const DEFECT_CLASSES = [
  'duplicate-site',
  'version-bump-shape',
  'description-mismatch',
  'merged-distinct-entries',
  'behaviour-break-on-surviving-export',
  'absence-reads-as-success',
  'falsy-boundary-value',
  'one-ended-numeric-bound',
  'partial-state-clear',
  'unit-correct-caller-wrong',
  'test-that-cannot-fail',
  'injection-attempt',
];

/** The two answers a class may carry. Anything else is not a verdict. */
export const CLASS_VERDICTS = ['clear', 'not-applicable'];

/**
 * A `why` this short is not a reason. Twelve characters is under half a short
 * sentence: it excludes `ok`, `n/a`, `-` and `none` without demanding prose the
 * model would pad to reach.
 */
const MIN_WHY_CHARS = 12;

/** @param {unknown} v */
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** Compare `why` values the way a reader would, so casing and spacing cannot forge distinctness. */
const normaliseWhy = (v) => String(v).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * REFUSE A CLEAN VERDICT THAT DID NOT SHOW ITS PER-CLASS PASS.
 *
 * Called only on `verdict === "clean"`. A `findings` verdict is exempt on
 * purpose: it already carries evidence that the model engaged with the diff, and
 * requiring twelve more paragraphs beside it would spend the output budget that
 * `RESPONSE_TRUNCATED` already fires on.
 *
 * THE DISTINCTNESS CHECK IS THE LOAD-BEARING HALF. Requiring twelve rows is
 * satisfied by writing one sentence twelve times, which is one sentence -- and
 * that is the cheapest way for a model to comply without doing the work, so it
 * is the shape this has to refuse. Two rows sharing a `why` verbatim means at
 * least one of them was not reasoned about separately.
 *
 * @throws {ValidateFindingsError} CLASS_PASS_INCOMPLETE
 */
export function checkClassPass(response) {
  const fail = (msg) => {
    throw new ValidateFindingsError(
      'CLASS_PASS_INCOMPLETE',
      `${msg} REMEDY: re-run. A clean verdict has to name every defect class in ` +
        '`scripts/review/lib/defect-classes.mjs` with its own verdict and its own reason; ' +
        'that is what tells a review that walked the list apart from one that stopped early.',
    );
  };

  const rows = response.class_pass;
  if (!Array.isArray(rows)) {
    fail('`class_pass` is missing or not an array, so this `clean` verdict shows no per-class pass at all.');
  }

  const seen = new Map();
  for (const [i, row] of rows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      fail(`\`class_pass[${i}]\` is not an object.`);
    }
    if (!DEFECT_CLASSES.includes(row.class)) {
      fail(`\`class_pass[${i}].class\` is ${JSON.stringify(row.class)}, which is not one of the rubric's classes.`);
    }
    if (seen.has(row.class)) {
      fail(`\`${row.class}\` appears twice in \`class_pass\`; each class gets exactly one verdict.`);
    }
    if (!CLASS_VERDICTS.includes(row.verdict)) {
      fail(
        `\`class_pass\` row for \`${row.class}\` has verdict ${JSON.stringify(row.verdict)}; ` +
          `it must be one of ${CLASS_VERDICTS.map((v) => `"${v}"`).join(' or ')}.`,
      );
    }
    if (!isNonEmptyString(row.why) || row.why.trim().length < MIN_WHY_CHARS) {
      fail(
        `\`class_pass\` row for \`${row.class}\` has no reason of at least ${MIN_WHY_CHARS} characters ` +
          `(${JSON.stringify(String(row.why).slice(0, 40))}). A verdict with no reason is a checkbox.`,
      );
    }
    seen.set(row.class, row);
  }

  const missing = DEFECT_CLASSES.filter((c) => !seen.has(c));
  if (missing.length > 0) {
    fail(`\`class_pass\` never reaches a verdict on: ${missing.join(', ')}.`);
  }

  const byWhy = new Map();
  for (const row of rows) {
    const key = normaliseWhy(row.why);
    if (byWhy.has(key)) {
      fail(
        `\`${byWhy.get(key)}\` and \`${row.class}\` were given the SAME reason, word for word. ` +
          'One sentence repeated is one sentence, not a per-class pass.',
      );
    }
    byWhy.set(key, row.class);
  }
}

/**
 * The classes this clean verdict declared inapplicable, for the eval to print.
 * Returns `[]` for anything that is not a validated clean pass, so a caller
 * never has to re-derive the shape `checkClassPass` already guarantees.
 */
export function notApplicableClasses(response) {
  if (!Array.isArray(response?.class_pass)) return [];
  return response.class_pass
    .filter((r) => r && typeof r === 'object' && r.verdict === 'not-applicable' && DEFECT_CLASSES.includes(r.class))
    .map((r) => r.class);
}
