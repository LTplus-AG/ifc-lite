/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE HUMAN-FACING SUMMARY (module-size budget, #3795 split out of
 * post-review.mjs). `nothingToReviewBody` and `summaryBody` are the two
 * bodies the poster writes for the one issue-comment marker carrier;
 * `indexLine`/`omittedSection`/`inlineCode` are their small rendering
 * helpers. See `summaryBody`'s own doc comment for why the "what this run
 * found" and "what is on the pull request" counts are kept apart rather than
 * reconciled.
 */

import { marker, inlineCode, MAX_POSTED_FINDINGS } from './review-findings.mjs';
import { PostReviewError } from './post-review-error.mjs';
import { sanitizeBody } from '../validate-findings.mjs';

/** Longest index line in the summary. A summary that scrolls is a summary nobody reads. */
const INDEX_BODY_CHARS = 110;

/** How many omitted paths the summary names before summarising the rest. */
const MAX_OMITTED_LISTED = 20;

/**
 * The human half of the partial-review disclosure. The marker's `omitted=<n>`
 * is the machine half; this is the part that tells the author WHICH files
 * nobody read, so "reviewed" cannot quietly mean "reviewed some of it".
 */
function omittedSection(omitted) {
  const shown = omitted.slice(0, MAX_OMITTED_LISTED);
  const rest = omitted.length - shown.length;
  return [
    `⚠️ PARTIAL REVIEW: ${omitted.length} changed file(s) were NOT shown to the reviewer -- too large to fit the model prompt, or too large for GitHub to return a patch for (#3679):`,
    '',
    ...shown.map((p) => `- ${inlineCode(p)}`),
    ...(rest > 0 ? [`- ...and ${rest} more (listed in the review job's log)`] : []),
    '',
    'Nothing vouches for those files. This verdict covers only the files that were reviewed.',
  ];
}

/**
 * The comment for a head with NOTHING REVIEWABLE in it.
 *
 * WHY THIS IS NOT `verdict=clean`. A lockfile-only or generated-code-only PR
 * makes `build-review-input.mjs` exit NO_FILES, so the model is never run. The
 * honest statement about that head is "there was nothing to review", and it is
 * NOT the same statement as "reviewed it and found nothing". Collapsing the two
 * is the exact failure this whole system exists to prevent: if the exclusion
 * list ever grows a bug that swallows real source, a `clean` marker would
 * certify every one of those PRs as reviewed, silently, forever.
 *
 * So it gets its own verdict token. The gate accepts it as evidence that the
 * LANE REACHED THIS HEAD and made a decision -- which is the question the gate
 * actually asks -- and prints it as its own outcome rather than as a pass.
 *
 * The alternative was to leave these PRs with no marker at all. Under
 * `mode: enforcing` that is a red row no re-run and no author action can ever
 * clear, on a class that recurs (PR #3558, a Cargo.lock-only dependabot bump),
 * with a printed remedy -- "re-run the review job" -- that cannot work.
 *
 * `allFindingsDropped` RENDERS A DIFFERENT BODY UNDER A DIFFERENT VERDICT
 * (#3775). There the model DID run, was retried once, and every finding it
 * produced was refused -- so the fixed sentence "the reviewer was NOT run" would
 * be false, and the marker is `dropped` rather than `nothing-to-review`. The gate
 * treats `dropped` as NOT covered, so the head stays open for a real review
 * instead of being sealed by a run that posted nothing.
 */
export function nothingToReviewBody(sha, why = null, { allFindingsDropped = false } = {}) {
  const short = sha.slice(0, 9);
  return [
    allFindingsDropped
      ? `### Claude review - every finding dropped for \`${short}\``
      : `### Claude review - nothing to review for \`${short}\``,
    '',
    // WHY, NOT A GUESS AT WHY. This used to assert the cause -- "every changed
    // path is excluded: lockfiles, generated code, snapshots, fixtures and build
    // output" -- because exclusion was the only caller. It is not any more:
    // NOTHING_FITS reaches here when a single patch is larger than the whole
    // model prompt, and the fixed sentence would have described 500 KB of real
    // source as generated content. A marker whose text is wrong about its own
    // cause is the shape this lane keeps finding in other people's gates.
    why
      ? sanitizeBody(String(why))
      : 'Every changed path in this diff is excluded from review: lockfiles, generated\n' +
        'code, snapshots, fixtures and build output.',
    '',
    ...(allFindingsDropped
      ? [
          // The reviewer ran and produced findings; none survived validation, so
          // there is nothing to post and no verdict the model actually gave.
          // Saying "the reviewer was NOT run" here would be false, and the reason
          // above already names what was dropped.
          'The reviewer DID run, and none of what it produced survived validation, so nothing on this',
          'head has been reviewed to a posted conclusion. This is not a statement that the diff is',
          'fine. Another reviewer must NOT stand down on this head.',
        ]
      : [
          'The reviewer was NOT run, so this is not a statement that the diff is fine -- it',
          'is a statement that nothing here was read. Another reviewer must NOT stand down',
          'on this head.',
        ]),
    '',
    marker(sha, allFindingsDropped ? 'dropped' : 'nothing-to-review', 0),
  ].join('\n');
}

/** The one-line index entry for a finding. */
function indexLine(f, n) {
  const text = (f.title ?? f.body.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  const short = text.length > INDEX_BODY_CHARS ? `${text.slice(0, INDEX_BODY_CHARS - 3)}...` : text;
  return `${n}. ${inlineCode(`${f.path}:${f.line}`)} - ${short}`;
}

/**
 * How many findings the judge removed, taken from the document the findings came
 * from. Returns 0 for any shape that does not carry the count: this decorates a
 * message, and a malformed count must never be the reason a review fails to post.
 *
 * It used to re-read the file and warn when it could not, which was the right
 * behaviour for a reader that re-read; now that `readFindingsDoc` has already
 * parsed it, there is no such failure left to report.
 */
export function readJudgedAway(doc) {
  // `counts.dropped` MEANS TWO DIFFERENT THINGS in the two files this poster
  // can be handed. In judged.json it is findings the judge rejected as not
  // worth a human's time. In the validator's findings.json -- which the
  // workflow's crash backstop copies verbatim -- it is findings REFUSED as
  // malformed. Reading it without checking `judged` told the author "N
  // finding(s) were dropped as too vague" about findings that were actually
  // rejected for quoting a line that is not in the diff. Only a real judging
  // has judge-dropped findings to disclose.
  if (doc?.judged !== true) return 0;
  const n = doc?.counts?.dropped;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * How many validated findings the posting cap withheld. 0 for any shape that
 * does not say: this decorates a message and must never be the reason a review
 * fails to post.
 */
export function readCappedCount(doc, shown) {
  const total = Array.isArray(doc)
    ? doc.length
    : Array.isArray(doc?.findings)
      ? doc.findings.length
      : undefined;
  return Number.isInteger(total) && total > shown ? total - shown : 0;
}

/**
 * The human half of the comment.
 *
 * TWO NUMBERS, KEPT APART ON PURPOSE. The heading and the index describe what
 * THIS REVIEW FOUND (`findings.length`); the confirmed line and the marker
 * describe WHAT IS ON THE PULL REQUEST (`count`, straight from the read-back).
 * They are usually equal. When they are not -- a finding from an earlier run of
 * the same head that this run no longer lists -- the difference is PRINTED
 * rather than reconciled, because the whole point of the marker is that its
 * count is an observation and not a claim. Collapsing them into one number is
 * how the marker would quietly become a receipt for the model's own file again.
 */
export function summaryBody({ sha, findings, count, verdict, judgedAway = 0, capped = 0, omitted = [], resolutionIncomplete = false }) {
  const short = sha.slice(0, 9);
  const n = findings.length;
  // The partial-review block sits ABOVE the marker in both branches, and the
  // marker carries `omitted=<n>` whenever it is non-empty, so a clean-but-
  // partial run can never read as a silent clean -- on either the human or the
  // machine surface. A full review renders byte-identically to before.
  const partial = omitted.length > 0 ? ['', ...omittedSection(omitted)] : [];
  if (count === 0) {
    // THE VERDICT IS AN ARGUMENT, NOT A DEFAULT (#3862). This branch used to
    // hardcode `clean` while main() computed the very same string a second
    // time -- two answers to one question, agreeing until one of them changed,
    // which is what the `clean-by-judge` split made happen. A default here
    // would have made the forgotten wire-up silent and posted the stronger
    // verdict, so an unpassed verdict REFUSES instead: nothing is posted, the
    // gate reads NOT_POSTED, and the remedy is a code fix.
    if (verdict !== 'clean' && verdict !== 'clean-by-judge') {
      throw new PostReviewError(
        'BAD_ARGS',
        `\`summaryBody\` was given verdict ${JSON.stringify(verdict)} for a zero-count review. It must ` +
          'be the value `markerVerdict` returned, so the marker and the prose above it cannot disagree. ' +
          'REMEDY: pass it through from the caller.',
      );
    }
    // Reachable only when `n` is 0 as well: `count >= n` is enforced one step
    // earlier, and the `n === 0 && count > 0` case is handled by the branch below.
    // A REVIEW JUDGED TO NOTHING IS NOT A REVIEW THAT FOUND NOTHING. The judge
    // can reject every validated finding, and without this line the only record
    // that they ever existed is a runner log that expires -- while the PR shows
    // "found nothing to flag". That is the absence-reads-as-success shape this
    // module is built around, and the judge is what created the path: before it,
    // every validated finding was posted.
    const judged =
      judgedAway > 0
        ? [
            '',
            `${judgedAway} finding(s) were written and then dropped as too vague or already ` +
              'covered before this was posted. Nothing here is a claim that they were wrong, ' +
              'only that they were not worth your time; the run log lists each one and why.',
          ]
        : [];
    return [
      `### Claude review - no findings for \`${short}\`${omitted.length > 0 ? ' (partial)' : ''}`,
      '',
      omitted.length > 0
        ? 'Reviewed everything that fit the model prompt and found nothing to flag there.'
        : 'Reviewed this diff and found nothing to flag.',
      ...judged,
      // WHAT THE WEAKER VERDICT MEANS, said on the human surface too. The
      // marker tells the gate; this tells the author why the pull request is
      // not going to be marked as reviewed, so the label's absence is not a
      // mystery they have to open a workflow log to explain.
      ...(verdict === 'clean-by-judge'
        ? [
            '',
            'This is NOT a clean bill of health. The reviewer answered `findings`, so it was never ' +
              'asked to show a verdict on every defect class -- and nothing it wrote survived. Another ' +
              'reviewer must not stand down on this head.',
          ]
        : []),
      ...partial,
      '',
      // No thumbs-down footer here on purpose: see STATED HOLES 6.
      marker(sha, verdict, 0, omitted.length),
    ].join('\n');
  }
  // AN INCOMPLETE RESOLUTION WALK, SAID OUT LOUD. Failing closed keeps the count
  // SAFE -- an unread thread stays standing -- but silently, and a count that may
  // be too high for a reason nobody can see is the shape this lane exists to
  // catch. It cannot be too low, so this is a disclosure, not a warning to act
  // on. Not in the marker token: MARKER_RE is parsed strictly by the gate, and
  // the fail-closed direction needs no machine consumer.
  const resolutionNote = resolutionIncomplete
    ? [
        '',
        'Note: the resolution of the review threads could not be read in full this run, so any thread ' +
          'that could not be accounted for is counted as still standing. The count above can therefore ' +
          'be too high, never too low.',
      ]
    : [];
  if (n === 0) {
    // `count > 0` with `n === 0`: this run found nothing while earlier findings
    // stand on the same commit. Without this branch the generic form below
    // renders "0 findings" as a heading over "1 inline comment confirmed" -- a
    // body contradicting itself in two consecutive lines. Say the state instead.
    return [
      `### Claude review - ${count} standing finding${count === 1 ? '' : 's'} for \`${short}\``,
      '',
      `This run reviewed the diff and found nothing to flag, but ${count} inline ` +
        `comment${count === 1 ? '' : 's'} from an earlier run ${count === 1 ? 'is' : 'are'} still ` +
        'anchored to this commit and nobody has withdrawn them.',
      '',
      'They stand. Two runs disagreed about the same code, and this note records that rather than ' +
        'resolving it by fiat: the marker below says `findings`, so nothing reads this as a pass. ' +
        'If the earlier findings are wrong, RESOLVE their review threads and re-run; the verdict ' +
        'becomes `clean` on its own once every one of them is resolved. Deleting the comments also ' +
        'works and destroys the audit trail, which is why resolving is the documented way out (#3768).',
      ...resolutionNote,
      '',
      marker(sha, 'findings', count),
    ].join('\n');
  }
  return [
    `### Claude review - ${n} finding${n === 1 ? '' : 's'} for \`${short}\`${omitted.length > 0 ? ' (partial)' : ''}`,
    '',
    ...findings.map((f, i) => indexLine(f, i + 1)),
    '',
    // "unless this run reported them again" is not a hedge. `standing` KEEPS a
    // resolved thread whose finding this run produced again -- the comment is
    // deduped rather than re-posted, and dropping it would report fewer standing
    // findings than the run actually made. A reader reconciling this count
    // against a thread they resolved needs the exception in the sentence.
    `${count} inline comment${count === 1 ? '' : 's'} from this reviewer stand${count === 1 ? 's' : ''} ` +
      'on this commit. Resolved threads are not counted, unless this run reported them again.',
    ...resolutionNote,
    // THE CAP FIRES ROUTINELY NOW. Validation allows twelve and the rubric asks
    // the model for up to twelve, where the poster shows five -- so the slice
    // that used to be unreachable is the common path, and its only trace was a
    // line in a runner log that expires. The clean branch above already discloses
    // judge-dropped findings; saying nothing here would leave the disclosure on
    // the branch where it happens least.
    ...(capped > 0
      ? [
          '',
          `${capped} further finding(s) passed validation and are not shown: this comment is capped ` +
            `at ${MAX_POSTED_FINDINGS} so it stays readable. They are in the run log, and re-running after ` +
            'these are addressed will surface them.',
        ]
      : []),
    ...partial,
    '',
    // Honest about what happens next. The earlier wording said a reaction would
    // "log it as a false positive", and nothing logs anything: that is a note
    // that fails to fire, which this repository has a name for. Reactions are a
    // durable surface a later tally can read; until that tally exists, the line
    // says only what is true today.
    'React with 👎 on a finding you think is wrong. Reactions are read when this lane\'s precision is assessed.',
    '',
    marker(sha, 'findings', count, omitted.length),
  ].join('\n');
}
