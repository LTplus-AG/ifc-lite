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
 * real: `residual`, `follow-up`, and `out of scope` are ordinary words for
 * describing work genuinely unrelated to the closed issue (a PR that closes
 * #N cleanly and separately notes "follow-up: consider caching this" about an
 * unrelated tangent will be flagged). That is accepted, not hidden, because
 * the gate that would avoid it -- same-paragraph scope -- was measured to
 * miss most of the confirmed cases.
 *
 * STATED LIMIT, NOT SOLVED HERE: a PR that partly closes an issue and says
 * NOTHING about it is invisible to a phrase scan and always will be. This
 * only catches the case where the body told the truth in prose and the
 * closing keyword overrode it anyway -- it narrows the problem, it does not
 * solve it.
 *
 * `stripNonProse` (from `./issue-refs.mjs`, #4161) removes fenced code,
 * inline code spans and blockquote lines before the phrase scan runs, for the
 * same reason `check-issue-queue.mjs`'s referenced-issue path needs it: a
 * `Closes #N (item 1 only)` quoted inside a code fence -- someone else's
 * commit message, an example diff -- is not this PR author's own claim.
 */

import { stripNonProse } from './issue-refs.mjs';

/**
 * Candidate phrases, drawn from the real PR bodies #4154 found (#4114,
 * #4082, #4133, #4134). Matched case-insensitively, word-bounded so `partial`
 * inside `impartially` does not fire, against the WHOLE stripped body -- see
 * the module header for why whole-body over same-paragraph.
 *
 * `label` is the exact phrase printed back in the warning line, so a reviewer
 * reading CI output sees which words tripped it without re-reading the body.
 */
export const ADMISSION_PHRASES = [
  { label: '(item N only)', re: /\(item\s+\d+\s+only\)/i },
  { label: 'only the', re: /\bonly the\b/i },
  { label: 'does not address', re: /\bdoes not address\b/i },
  { label: 'deliberately leaves', re: /\bdeliberately leaves\b/i },
  { label: 'leaves the rest', re: /\bleaves the rest\b/i },
  { label: 'remains open', re: /\bremains open\b/i },
  { label: 'out of scope', re: /\bout of scope\b/i },
  { label: 'residual', re: /\bresidual\b/i },
  { label: 'follow-up', re: /\bfollow-up\b/i },
  { label: 'not attempted', re: /\bnot attempted\b/i },
  { label: 'partially', re: /\bpartially\b/i },
];

/**
 * Every admission phrase found in `body`, in the fixed order of
 * `ADMISSION_PHRASES` (not first-seen order in the text -- the caller wants a
 * stable, readable list, not a transcript). Runs `stripNonProse` first so a
 * fenced code block, inline span or blockquote can never supply a match.
 *
 * @param {unknown} body
 * @returns {string[]}
 */
export function findAdmissionPhrases(body) {
  if (typeof body !== 'string' || body === '') return [];
  const prose = stripNonProse(body);
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
