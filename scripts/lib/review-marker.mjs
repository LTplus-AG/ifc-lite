/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE REVIEW MARKER GRAMMAR, IN ONE PLACE.
 *
 * Split out of scripts/check-review-posted.mjs (module-size budget): the gate
 * PARSES this string, scripts/review/lib/review-findings.mjs BUILDS it, and
 * scripts/review/lib/review-comments.mjs matches it to find the comment it
 * should update. Three files, one grammar -- and the grammar keeps growing
 * verdicts, which is exactly the change that goes wrong when the pattern lives
 * inside one of its consumers.
 *
 * THE FORM:
 *
 *     <!-- ifc-lite-review sha=<40-hex> verdict=<one of MARKER_VERDICTS> count=<n> -->
 *
 * with an optional trailing ` omitted=<n>`, present only when n > 0 (#3679), so
 * a full review's marker stays byte-identical to what every earlier version of
 * the gate parsed.
 *
 * THE VERDICTS, and what each one is allowed to buy:
 *
 *   `clean`             The reviewer read the diff, walked every defect class in
 *                       scripts/review/lib/defect-classes.mjs, and found
 *                       nothing. Certifies the diff.
 *   `findings`          The reviewer found something and it is on the pull
 *                       request. Counted, and cross-checked against the inline
 *                       comments by the gate. Certifies the diff.
 *   `clean-by-judge`    NOTHING REACHED THE PULL REQUEST, AND NO PER-CLASS PASS
 *                       STANDS BEHIND IT (#3862). The reviewer answered
 *                       `findings` -- which is exempt from the class pass on
 *                       purpose, see defect-classes.mjs -- and then the judge
 *                       dropped every one of them, leaving the poster looking at
 *                       the same standing count of zero a genuinely clean review
 *                       produces. A findings.json that cannot show the flag at
 *                       all lands here for the same reason: absence is not
 *                       evidence of a pass. The lane REACHED this head, so the
 *                       gate counts it as covered and does not re-run; it did
 *                       not certify the diff, so it does not grant
 *                       `llm-reviewed`.
 *   `nothing-to-review` The model was never run: every changed path is excluded,
 *                       or no part of the diff fits the prompt. COVERED, not
 *                       full, for the same reason.
 *   `dropped`           The model ran, was retried, and every finding it produced
 *                       was refused. NOT covered -- see review-dropped-verdict.mjs.
 *
 * `clean-by-judge` IS LISTED BEFORE `clean`, longest first. The alternation would
 * resolve either way -- a `clean` branch taken against `clean-by-judge` fails at
 * the following `\s+count=` and the engine backtracks into the next branch -- but
 * a reader should not have to derive that, and the ordering is the rule that
 * still holds if a later token makes some other pair a prefix of each other.
 *
 * ANCHORED AT THE TAIL ONLY, and the missing head anchor is deliberate: every
 * real summary carries prose above its marker, so `^` would reject all of them.
 * The tail anchor is what closes the forgery channel the writers already defang
 * from the other side. The summary body renders PR-chosen text BEFORE the
 * marker -- `omitted` paths and the `path:line - title` index lines -- under our
 * own identity, in a comment the gate trusts by author. Unanchored, `exec`
 * returned the FIRST match, so a marker smuggled into one of those lines
 * outranked the real one written at the end. scripts/review/lib/
 * finding-sanitizers.mjs breaks the token before it can get there; this is the
 * second lock on the same door, and it holds even for a body nothing sanitised.
 * `$` without the `m` flag is the end of the whole string, so an embedded marker
 * cannot reach it and only the real trailing one can match. Text after the
 * marker now fails to parse, which the gate reports as MARKER_MALFORMED -- loud,
 * and pointed at the writer that would have to have drifted for it to happen.
 * Raised by CodeRabbit on #3828.
 */

/** Every verdict token the marker may carry, longest-prefix-first. */
export const MARKER_VERDICTS = ['clean-by-judge', 'clean', 'findings', 'nothing-to-review', 'dropped'];

/**
 * The marker the reviewer writes at the END of a successful post, and the `\s*$`
 * says END rather than merely describing it.
 */
export const MARKER_RE = new RegExp(
  `<!--\\s*ifc-lite-review\\s+sha=([0-9a-f]{40})\\s+verdict=(${MARKER_VERDICTS.join('|')})` +
    `\\s+count=(\\d+)(?:\\s+omitted=(\\d+))?\\s*-->\\s*$`,
);

/** The shape a malformed-marker diagnosis should tell the reader to produce. */
export const MARKER_SHAPE =
  `\`<!-- ifc-lite-review sha=<40-hex> verdict=${MARKER_VERDICTS.join('|')} count=<n>` +
  '[ omitted=<n>] -->`';

/**
 * Does this verdict certify that the WHOLE diff was read and found clear?
 *
 * The one question `llm-reviewed` turns on, and therefore the one question
 * CodeRabbit's stand-down turns on. Only `clean` and `findings` say a model read
 * this diff and reached a conclusion about it. `nothing-to-review` never ran the
 * model, `dropped` had every finding refused, and `clean-by-judge` ran the model
 * without ever asking for the per-class pass that makes a clean verdict mean
 * anything -- standing another reviewer down on any of them would leave the pull
 * request reviewed by NOBODY.
 *
 * @param {string} verdict
 */
export const certifiesDiff = (verdict) => verdict === 'clean' || verdict === 'findings';
