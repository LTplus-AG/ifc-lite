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
 * prompt and the validator cannot ask for and enforce different lists. The guard
 * that holds them together is in `../validate-findings.test.mjs` ("the rubric
 * names EVERY class the validator enforces"), which is where it has to live:
 * `.github/workflows/test.yml` globs `scripts/review/*.test.mjs` and NOT
 * `scripts/review/lib/`, so a test file next to this one would never run in CI.
 *
 * WHAT THIS IS NOT. It does not decide whether a finding is real, and it never
 * turns `clean` into `findings`: a reviewer that walks all twelve and reports
 * every one clear still gets a clean verdict posted. It refuses only the answer
 * that skipped the walk, which is the one the eval measured 13-14 times out of
 * 18.
 *
 * BOUND TO THE DIFF, NOT TO THE PROSE. The first cut of this check was lexical
 * -- twelve rows, twelve distinct sentences -- and a lexical bar is cleared for
 * free: `why: "no such code in diff (7)"` twelve times over, or
 * `why: "<class> does not apply"` per class, are twelve distinct sentences and
 * not one reason. So `not-applicable` is now allowed only for a class
 * ./class-applicability.mjs says this diff cannot carry, and a class it CAN
 * carry must be `clear` with a `path:line` from the diff in its reason, checked
 * against the added ranges by the same `lineIsAdded` every finding is anchored
 * with.
 */

import { ValidateFindingsError } from './validate-findings-error.mjs';
import { lineIsAdded } from '../quote-line-coupling.mjs';
import { applicableClasses, APPLIES } from './class-applicability.mjs';

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
 * THE APPLICABILITY BINDING IS THE LOAD-BEARING HALF, and the distinctness rule
 * below is not. Requiring twelve rows with twelve different sentences is cleared
 * for free -- `"no such code in diff (0)".."(11)"`, or `"<class> does not
 * apply"` per class, are twelve distinct sentences and not one reason -- so the
 * verdict is checked against the DIFF instead:
 *
 *   - a class ./class-applicability.mjs says this diff CAN carry may not be
 *     `not-applicable`, and its `clear` must cite a `path:line` that is really
 *     an added line of the diff;
 *   - a class the predicates cannot see is free: `not-applicable` needs only a
 *     reason, because the harness has nothing to contradict it with.
 *
 * The predicates under-fire on purpose (see that file), so this is a floor under
 * `not-applicable`, never a claim that the classes it does not name are absent.
 * The remaining gap is printed by the eval as CLASS SKIPPED rather than assumed
 * away.
 *
 * @param {{ response: object, input: { files: Map<string, object>, contextPack?: object|null } }} args
 * @throws {ValidateFindingsError} CLASS_PASS_INCOMPLETE
 */
export function checkClassPass({ response, input }) {
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

  // THE DIFF HAS THE LAST WORD. Everything above is about the answer's shape;
  // this is the only part a model cannot satisfy by writing better sentences.
  const applicable = applicableClasses(input);
  for (const [cls, site] of applicable) {
    const row = seen.get(cls);
    const where = site.path ? `\`${site.path}\`${site.line ? `:${site.line}` : ''}` : 'this diff';
    if (row.verdict === 'not-applicable') {
      fail(
        `\`${cls}\` was declared not-applicable, but ${where} makes it applicable ` +
          `(${JSON.stringify(String(site.text).slice(0, 90))}). Walk it and report \`clear\` with the ` +
          'line you checked, or report the defect.',
      );
    }
    const cited = citedAddedLine(row.why, input);
    if (!cited) {
      fail(
        `\`${cls}\` applies to this diff (${where}) and its \`clear\` cites no line of it. ` +
          'Name a `path:line` you actually checked, in the form `packages/x/y.ts:42`, where the line ' +
          'is one the diff ADDED.',
      );
    }
  }
}

/**
 * The first `path:line` in `why` that is really an added line of the diff.
 *
 * ANCHORED BY `lineIsAdded`, the same check every posted finding's line goes
 * through, and against `input.files` -- so a citation of a file the reviewer was
 * never sent, or of a line this PR did not touch, is not a citation. Without
 * that the rule would be "put a colon and a number in the sentence", which is
 * the lexical bar this round exists to replace.
 */
function citedAddedLine(why, input) {
  for (const m of String(why).matchAll(/([A-Za-z0-9_./@-]+\.[A-Za-z0-9]+):(\d+)/g)) {
    const file = input.files.get(m[1]);
    if (file && lineIsAdded(Number(m[2]), file.addedLineRanges)) return { path: m[1], line: Number(m[2]) };
  }
  return null;
}

/**
 * The classes this clean verdict declared inapplicable, for the eval to print.
 *
 * Returns `[]` for anything that is not a clean verdict carrying a `class_pass`
 * array. The VERDICT check is not decoration: a `findings` response is exempt
 * from the pass entirely, so a `class_pass` sitting on one was never validated
 * against anything, and attributing a class skip to it would be reading a field
 * nothing checked. The docblock claimed this before the code did it.
 */
export function notApplicableClasses(response) {
  if (response?.verdict !== 'clean') return [];
  if (!Array.isArray(response?.class_pass)) return [];
  return response.class_pass
    .filter((r) => r && typeof r === 'object' && r.verdict === 'not-applicable' && DEFECT_CLASSES.includes(r.class))
    .map((r) => r.class);
}
