/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * The detection logic behind `scripts/check-partial-close-admission.mjs`
 * (#4154): a PR whose own body admits, in prose, that it does not finish what
 * a bare `Closes`/`Fixes`/`Resolves #N` is about to close in full.
 *
 * WHY THIS IS A SEPARATE SIGNAL FROM `closingIssuesReferences` ALONE.
 * `check-issue-queue.mjs`'s header already establishes, at length, that a body
 * regex must never REPLACE `closingIssuesReferences` as the source of which
 * issue a PR closes -- GitHub's own keyword scanner is the only field whose
 * answer is the answer GitHub itself acts on. This module does not replace
 * it: `closesAnyIssue` below is expected to come from that same field. What
 * this module adds is a SECOND read of the body -- not to find the link, but
 * to find the author's own words about that link's honesty. #4114 (closing
 * #4111) read `Closes #4111 (item 1 only)`, followed by a "Not in this PR"
 * list of two more items; the closing link was real, the completeness claim
 * behind it was not, and GitHub's scanner has no way to read the parenthetical.
 *
 * WHOLE-BODY SCOPE, CHOSEN OVER SAME-PARAGRAPH, AND WHY. Four confirmed PRs
 * (#4154's own investigation): #4114 and #4082 have the admission phrase in
 * the same sentence as the closing keyword; #4133 has it two paragraphs
 * later, still in the PR's opening section; #4134 has it in a "Scope note"
 * near the BOTTOM of a long body, nowhere near the top-line `Closes #4116`.
 * Same-paragraph scope catches 3 of 4; whole-body catches all 4. Whole-body is
 * chosen here because a MISSED admission is a silent failure of the very
 * thing this gate exists to catch, while a FALSE warning is, by the issue's
 * own design constraint, cheap: this gate warns, it does not fail, so the
 * cost of a wrong flag is one line of CI output a reviewer reads and
 * dismisses, not a blocked PR. The tradeoff runs the other way too, and it is
 * real: `out of scope`, `does not address`, and the rest of the surviving
 * phrase list are ordinary words for describing work genuinely unrelated to
 * the closed issue (a PR that closes #N cleanly and separately notes "the
 * cache invalidation issue is out of scope for this change" about an
 * unrelated tangent will be flagged). That is accepted, not hidden, because
 * the gate that would avoid it -- same-paragraph scope -- was measured to
 * miss most of the confirmed cases. Two phrases originally on this list,
 * `only the` and a bare `residual`, turned out to cross from "occasionally
 * coincidental" into "routinely wrong" -- including firing on this gate's
 * own introducing PR (#4180) -- and were removed or narrowed; see
 * `ADMISSION_PHRASES`'s own comment for the specifics and the bar a phrase
 * has to clear to stay on this list.
 *
 * STATED LIMIT, NOT SOLVED HERE: a PR that partly closes an issue and says
 * NOTHING about it is invisible to a phrase scan and always will be. This
 * only catches the case where the body told the truth in prose and the
 * closing keyword overrode it anyway -- it narrows the problem, it does not
 * solve it.
 *
 * `stripCode` (from `./issue-refs.mjs`, #4161) removes fenced code and
 * inline code spans before the phrase scan runs, for the same reason
 * `check-issue-queue.mjs`'s referenced-issue path needs it: a `Closes #N
 * (item 1 only)` quoted inside a code fence -- someone else's commit
 * message, an example diff -- is not this PR author's own claim.
 *
 * NOT `stripNonProse` -- BLOCKQUOTES ARE LEFT IN, DELIBERATELY (#4180
 * finding F). `issue-refs.mjs` strips blockquotes because its question is
 * "did THIS AUTHOR write a real reference", and a quoted reply is someone
 * else's words. This module's question is different: "does this PR's own
 * record admit partial coverage", and a PR body that quotes a reviewer
 * saying "this only covers half the issue" has put that admission into its
 * own record by choosing to include it, same as if the author had typed it
 * directly. Stripping blockquotes here would hand an author a one-character
 * dodge (prefix the admission with `>`) against a gate whose own header
 * already commits to "maximal sensitivity, false positives accepted" -- see
 * the tradeoff paragraph above. Fenced code and inline spans stay stripped
 * because those really are quoting something else's literal text (a commit
 * message, example output); a blockquoted sentence in a PR body is still
 * the PR body's content, not a foreign artifact.
 */

import { stripCode } from './issue-refs.mjs';

/**
 * Candidate phrases, drawn from the real PR bodies #4154 found (#4114,
 * #4082, #4133, #4134), NARROWED after the #4180 adversarial review found
 * two demonstrably over-broad entries. Matched case-insensitively,
 * word-bounded so `partial` inside `impartially` does not fire, against the
 * WHOLE stripped body -- see the module header for why whole-body over
 * same-paragraph.
 *
 * WHAT THIS LIST IS FOR, so future edits have a test to apply rather than a
 * vibe: each phrase must be a string whose PRESENCE, on its own, is more
 * likely to mean "the author is admitting a `Closes` claim is not fully
 * true" than to mean anything else a PR body ordinarily says. That bar is
 * why two entries were removed or rewritten below, and it is the bar a new
 * entry must clear too.
 *
 * `only the` -- REMOVED. It is not a coverage admission, it is how English
 * scopes almost any sentence ("only the parser module changed", "only the
 * hand-picked fixture catches it"). It fired on #4180's own PR body's
 * design-rationale prose and on #4082's real CodeRabbit-generated summary
 * line, neither an admission. Checked against all four confirmed PRs: none
 * of them need `only the` to be caught (each has a different, load-bearing
 * phrase below), so removing it costs nothing and the false-positive rate
 * was the whole list's worst.
 *
 * `residual` -- TIGHTENED from a bare word to `residual(s) <number>`. A bare
 * "residual" is exactly as likely to be a numerical term (a floating-point
 * residual error, a residual stress) as an admission. What #4082's real
 * body actually does -- "residual 1", later "Residual 2" -- is enumerate
 * remaining ISSUE ITEMS, the same shape as #4114's "(item N only)". `\d+`
 * after the word is what turns a coincidental technical term into that
 * enumeration; it is real in #4082's real, unedited-at-that-point body (see
 * ./partial-close-admission.test.mjs's header) and not present in "residual
 * error".
 *
 * `follow-up` -- TIGHTENED from anywhere-in-prose to a markdown HEADING
 * (`## Follow-up`, `### Follow-ups`, ...). This is the phrase that fired on
 * #4180's own body: a prose sentence *explaining* the false-positive risk
 * ("...separately notes an unrelated \"follow-up\" about future work...")
 * contains the word without being an admission about THIS PR. None of the
 * four confirmed PRs use `follow-up` as their catching phrase (each has a
 * stronger, more specific one below), so this loses no real coverage. A
 * section heading is a much stronger signal of "the author is naming
 * deferred work" than an inline mention, which is used constantly for
 * describing unrelated future ideas.
 *
 * EVERY OTHER PHRASE IS KEPT AS-IS. Each names a specific grammatical
 * admission shape (`does not address`, `deliberately leaves`, `leaves the
 * rest`, `remains open`, `out of scope`, `not attempted`, `partially`) that
 * is a much weaker source of ordinary-prose false positives than a bare
 * scoping word like `only the` was -- none of them turned up in #4180's own
 * body, #4082's CodeRabbit boilerplate, or the boundary-regression fixtures
 * in this module's test file.
 *
 * `label` is the exact phrase printed back in the warning line, so a reviewer
 * reading CI output sees which words tripped it without re-reading the body.
 */
export const ADMISSION_PHRASES = [
  { label: '(item N only)', re: /\(item\s+\d+\s+only\)/i },
  { label: 'does not address', re: /\bdoes not address\b/i },
  { label: 'deliberately leaves', re: /\bdeliberately leaves\b/i },
  { label: 'leaves the rest', re: /\bleaves the rest\b/i },
  { label: 'remains open', re: /\bremains open\b/i },
  { label: 'out of scope', re: /\bout of scope\b/i },
  { label: 'residual N', re: /\bresiduals?\s+\d+\b/i },
  { label: 'follow-up (heading)', re: /^[ \t]{0,3}#{1,6}[ \t]*follow-?up\b/im },
  { label: 'not attempted', re: /\bnot attempted\b/i },
  { label: 'partially', re: /\bpartially\b/i },
];

/**
 * Every admission phrase found in `body`, in the fixed order of
 * `ADMISSION_PHRASES` (not first-seen order in the text -- the caller wants a
 * stable, readable list, not a transcript). Runs `stripCode` first so a
 * fenced code block or inline span can never supply a match; blockquotes are
 * left in -- see the module header's "NOT `stripNonProse`" note.
 *
 * @param {unknown} body
 * @returns {string[]}
 */
export function findAdmissionPhrases(body) {
  if (typeof body !== 'string' || body === '') return [];
  const prose = stripCode(body);
  const found = [];
  for (const { label, re } of ADMISSION_PHRASES) {
    if (re.test(prose)) found.push(label);
  }
  return found;
}

/**
 * The whole verdict, over data already resolved: whether the PR closes at
 * least one issue (from `closingIssuesReferences`, read by the caller -- this
 * function never reads GitHub itself) and the PR body text.
 *
 * BOTH CONDITIONS REQUIRED. `closesAnyIssue: false` means the PR carries no
 * closing keyword at all -- a `Refs #N` PR, however apologetic its body, is
 * not a closing claim and has nothing to warn about; #4147's honest-partial-
 * work path exists for exactly that shape and does not need this gate's help.
 * `closesAnyIssue: true` with no admission phrase means an ordinary `Closes
 * #N` this gate has no evidence to doubt -- most PRs, and the intended silent
 * case.
 *
 * @param {{ body: unknown, closesAnyIssue: boolean }} args
 * @returns {{ warn: boolean, verdict: 'NO_CLOSING_KEYWORD'|'CLEAN'|'PARTIAL_CLOSE_ADMISSION', matches: string[], lines: string[] }}
 */
export function evaluatePartialCloseAdmission({ body, closesAnyIssue }) {
  if (!closesAnyIssue) {
    return {
      warn: false,
      verdict: 'NO_CLOSING_KEYWORD',
      matches: [],
      lines: [
        'ℹ️  NO_CLOSING_KEYWORD: this PR carries no `Closes`/`Fixes`/`Resolves #N` link in ' +
          '`closingIssuesReferences`, so there is no bare closing claim for an admission phrase ' +
          'to contradict.',
      ],
    };
  }
  const matches = findAdmissionPhrases(body);
  if (matches.length === 0) {
    return {
      warn: false,
      verdict: 'CLEAN',
      matches: [],
      lines: [
        '✅ CLEAN: this PR closes at least one issue and its body contains none of the ' +
          'admission-of-partial-coverage phrases this gate looks for.',
      ],
    };
  }
  return {
    warn: true,
    verdict: 'PARTIAL_CLOSE_ADMISSION',
    matches,
    lines: [
      `⚠️  PARTIAL_CLOSE_ADMISSION: this PR's body will close an issue in full (a bare ` +
        '`Closes`/`Fixes`/`Resolves #N`, and GitHub ignores any qualifier after the number), but ' +
        `its own text also says: ${matches.map((m) => `"${m}"`).join(', ')}.`,
      '   That combination closed #4111 in full on #4114\'s merge with two of its three items ' +
        'undone, needing a second PR (#4139) to finish. If this PR only partly covers what it is ' +
        'about to close, use `Refs #N` instead of `Closes #N` and leave the issue open.',
      '   If the PR genuinely finishes the issue and the phrase above is coincidental (e.g. ' +
        '"follow-up" about unrelated future work, or "out of scope" describing something this PR ' +
        'never touched), this warning is a false positive -- it does not fail the build.',
      '   This is a WARNING, not a gate: it does not block merge. It also cannot catch a PR that ' +
        'partly closes an issue and says nothing about it -- silence sails through.',
    ],
  };
}
