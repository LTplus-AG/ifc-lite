#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE MARKER IS WRITTEN LAST, AND THAT ORDER IS THE ENTIRE POINT OF THIS FILE.
 *
 * WHY THIS EXISTS. `anthropics/claude-code-action` #1679 is OPEN (bug, p2,
 * 2026-08-16): "post-buffered-inline-comments exits 0 after failing to post
 * every comment", reported as FORTY CONSECUTIVE RUNS logging `Posted 0/N` while
 * the job went green. The review ran. The findings existed. Zero comments
 * reached the pull request. Nothing in the exit code, and nothing in a
 * `--json-schema` result, can tell that run apart from a successful one: the
 * schema describes what the model PRODUCED, not what the pull request RECEIVED.
 *
 * This repository has already paid for the same defect from the other side: 174
 * of 830 merged PRs in August 2026 (21%, 46,717 lines) carried no review of any
 * kind while showing green, and #3175 then had to correct TWELVE changesets by
 * hand that would have shipped breaking changes as `patch`, with the release one
 * command from publishing. ABSENCE MUST NOT READ AS SUCCESS.
 *
 * `scripts/check-review-posted.mjs` is the gate that adjudicates the marker this
 * script writes. THIS IS THE ONLY WRITER OF THAT MARKER, and it is built so the
 * #1679 shape cannot survive it: the marker is written ONLY after the inline
 * comments have been READ BACK FROM THE PULL REQUEST. A comment we sent is not
 * evidence; a comment GitHub hands back on a subsequent GET is.
 *
 * THE ORDER, and it is not negotiable:
 *
 *   1. RE-READ THE HEAD. If the PR has moved past `--sha`, exit 0 as
 *      SKIPPED_STALE and post NOTHING. The newer event's run owns the new head.
 *      Posting for a dead head would leave a marker the gate then calls
 *      STALE_REVIEW -- a red that no re-run of THIS commit can clear.
 *   2. POST each finding to `pulls/{n}/comments` with `commit_id`, `side=RIGHT`,
 *      `line`, `path`, `body`, checking every response for a comment id. Any
 *      failure aborts with exit 1 and NO marker. Findings already present on
 *      this head (fingerprinted) are SKIPPED, so a crash-and-rerun does not
 *      double-post.
 *   3. READ BACK. `GET pulls/{n}/comments`, count comments from our identity
 *      whose `original_commit_id` is exactly this head -- NOT `commit_id`,
 *      which GitHub relocates onto a later head (#3729). This is the gate's own
 *      FINDINGS_NOT_POSTED predicate, and now literally the same FUNCTION
 *      (`wroteAtCommit`) rather than the same spelling, so the two cannot
 *      drift. Still checked by EXECUTION, not by prose: post-review.test.mjs
 *      feeds what this script actually posted into the real gate as a process
 *      and asserts REVIEW_POSTED.
 *   4. ONLY THEN write one issue comment carrying the marker, whose `count` is
 *      the number CONFIRMED in step 3 -- never the number the model claimed.
 *      That is the whole difference between a marker and a receipt.
 *   5. READ THE MARKER BACK once. A marker we could not read is a marker the
 *      gate may not be able to read either.
 *
 * A failure at ANY step leaves the pull request marker-less, so the gate reads
 * NOT_POSTED (its remedy: re-run the review job) and the re-run is safe.
 *
 * THE OTHER HALF OF THE CONTRACT: THE REVIEWER MUST POST ON EVERY RUN, INCLUDING
 * A CLEAN ONE. A reviewer that stays silent when it finds nothing makes
 * "reviewed and found nothing" byte-identical to "never ran", which is exactly
 * the trap CodeRabbit falls into here. So a clean run posts a `verdict=clean`
 * marker, and silence therefore means failure.
 *
 * FAILURE CLASSES, each with its OWN remedy, because a remedy that contradicts
 * its finding is worse than no remedy:
 *
 *   SKIPPED_STALE       Not a failure. The head moved while we worked; exit 0,
 *                       nothing posted. REMEDY: none. The run triggered by the
 *                       new head owns it.
 *   AUTHOR_NOT_EXPECTED `--author` is not in the gate's `expectedAuthors`. We
 *                       would post a marker the gate ignores -- a green poster
 *                       over a red gate. Refused BEFORE anything is posted.
 *                       REMEDY: add the login to review-posted.config.json (on
 *                       the BASE branch, which is the copy the gate reads), or
 *                       fix `--author`.
 *   NO_FINDINGS_FILE /  The findings file is missing, unparseable, or not one of
 *   BAD_FINDINGS /      the two accepted shapes, or a row lacks a usable
 *   BAD_FINDING         path/line/body. NEVER read as "clean": an unreadable
 *                       findings file is the absence-reads-as-success defect one
 *                       layer below where this gate usually catches it.
 *                       REMEDY: fix the reviewer's findings writer.
 *   HEAD_UNREADABLE     The PR object came back without a 40-hex head sha.
 *                       REMEDY: check the token's `pull-requests` scope; do not
 *                       proceed on a guessed head.
 *   INLINE_POST_FAILED  A `pulls/{n}/comments` POST threw, or returned 2xx with
 *                       no comment id. THIS IS #1679 CAUGHT AT THE SOURCE.
 *                       REMEDY: re-run. A 422 here usually means `line` is not
 *                       in this commit's diff; fix the finding's anchor.
 *   READBACK_SHORT      Fewer findings are visible on the PR than the findings
 *                       file holds. THIS IS #1679 CAUGHT AT THE READ-BACK: every
 *                       POST reported success and the comments are not there.
 *                       REMEDY: re-run. If it recurs, attach the log to
 *                       claude-code-action#1679 rather than re-running forever.
 *   (CLEAN_CONTRADICTED  REMOVED. It threw when this run found nothing while our
 *                       own findings stood on the same head, and its remedy was
 *                       "re-run" -- which reproduced the state exactly, so the
 *                       lane failed forever until a human deleted a comment.
 *                       Measured on #3669: three consecutive runs, no path out.
 *                       The standing findings now simply STAND: the marker says
 *                       `findings` with the confirmed count and the summary
 *                       states the disagreement. Withdrawal is still possible
 *                       and still needs a human, but it is no longer the ONLY
 *                       way out of a red lane.)
 *   SUMMARY_POST_FAILED The marker comment POST/PATCH returned no id.
 *                       REMEDY: check that the posting workflow has write access
 *                       to the pull request, then re-run.
 *   MARKER_NOT_READ_BACK The marker is not readable on the PR one GET after it
 *                       was written. REMEDY: re-run. The gate reads NOT_POSTED
 *                       until it is, which is the correct direction to fail.
 *   COMMENTS_TRUNCATED  A comment surface still had pages after the bounded
 *                       walk, so a finding may be on a page never read. Refuses
 *                       rather than guessing. REMEDY: raise the pager's budget,
 *                       or narrow what the reviewer posts.
 *   BAD_ARGS / NO_PR / NO_REPO / NO_SHA  Broken invocation. REMEDY per message;
 *                       all fail closed, none post.
 *
 * WHY THERE IS NO TEST SEAM IN THIS FILE. There is no `--gh-state`, no injected
 * transport, no `if (process.env.TEST)`. The harness puts a fake `gh` on PATH,
 * so the code CI runs and the code the tests run are the same bytes, ordering
 * included. A seam here would be a second implementation of the one thing this
 * file exists to get right, and it would be the copy nobody exercises.
 *
 * STATED HOLES, so nobody reads a green here as more than it is:
 *
 *   1. It proves the findings REACHED the pull request. It proves nothing about
 *      whether they were any good, or whether the model read the whole diff.
 *      Precision and recall are separate instruments.
 *   2. `--author` is a CLAIM about who we post as. It is verified on a findings
 *      run (the read-back filters on it, so a wrong login yields zero and fails
 *      READBACK_SHORT) and again on the marker read-back. On a CLEAN run with a
 *      wrong login the marker posts before the read-back refuses it: exit 1 with
 *      a marker present is possible only on that one path, and the gate then
 *      reads NOT_POSTED, which is still the safe direction.
 *   3. The dedupe fingerprint uses `path`, `line` and the body, NUL-separated so
 *      no path or body can forge a boundary. GitHub returns
 *      `line: null` for a comment that has gone outdated, so such a comment does
 *      not match and the finding is posted again. A duplicate comment is noise;
 *      a missing one would be a lie, so the fingerprint fails towards noise on
 *      purpose.
 *   4. `--author` is checked against the config path it was GIVEN. The gate reads
 *      the config from the BASE branch. Point `--config` at that same base copy
 *      or the agreement between poster and gate is only as good as the two files
 *      happening to match.
 *   5. Between the read-back and the marker write, a comment could be deleted.
 *      The window is one HTTP call wide and nothing here closes it.
 *   6. THE FALSE-POSITIVE FOOTER IS OMITTED ON A CLEAN RUN. "React with a thumbs
 *      down on a finding" printed where there are no findings is the same class
 *      of lie as a green tick over an unreviewed diff -- the sibling gate's own
 *      harness pins exactly that rule for its advisory notice. A deliberate
 *      deviation from the brief, stated rather than silently applied.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { GhError } from '../lib/gh.mjs';
import { ReviewProvenanceError } from '../lib/review-provenance.mjs';
import { normaliseLogin, readConfig, ReviewPostedError } from '../check-review-posted.mjs';
import { PostReviewError } from './lib/post-review-error.mjs';
// readFindingsDoc/readFindings/readOmitted/marker/MAX_POSTED_FINDINGS moved to
// ./lib/review-findings.mjs (module-size budget, #3795). Imported (not
// `export ... from`) because main() below calls several of them itself, and
// re-exported so every existing import of these names from this file keeps
// working unchanged. `fingerprint` is used only inside
// `postFindingsAndConfirm` now, so it is re-exported directly rather than
// imported.
import { MAX_POSTED_FINDINGS, readFindingsDoc, readFindings, readOmitted, marker } from './lib/review-findings.mjs';
// fetchHeadSha/upsertAndVerify/postNothingToReview/postFindingsAndConfirm
// moved to ./lib/review-comments.mjs (module-size budget, #3795). Imported
// for the same reason as above. `confirmedOnHead` is used only inside that
// module's own helpers now, so it is re-exported directly.
import { fetchHeadSha, upsertAndVerify, postNothingToReview, postFindingsAndConfirm } from './lib/review-comments.mjs';
// summaryBody/readJudgedAway/readCappedCount moved to ./lib/review-summary.mjs
// (module-size budget, #3795). Imported for the same reason as above.
// `nothingToReviewBody` is called only inside `postNothingToReview` now, so
// it is re-exported directly.
import { summaryBody, readJudgedAway, readCappedCount } from './lib/review-summary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(HERE, '..', 'review-posted.config.json');

/**
 * A Map, not an object literal, for the reason the sibling gate records: a
 * `{...}[name]` lookup reaches Object.prototype, so `--constructor x` returns a
 * truthy key, sails past the `!key` guard and writes a junk property instead of
 * refusing.
 */
const FLAGS = new Map([
  ['--pr', 'pr'],
  ['--repo', 'repo'],
  ['--sha', 'sha'],
  ['--findings', 'findings'],
  ['--author', 'author'],
  ['--config', 'config'],
  // The human half of a nothing-to-review marker. Optional, and PASSED THROUGH
  // `sanitizeBody`: it reaches the comment body, and the only caller that sets
  // it interpolates a build-input message that carries a PR-chosen file path.
  ['--reason', 'reason'],
]);

/** Flags that take NO value. Kept separate so the value-consuming loop stays strict. */
const BOOL_FLAGS = new Map([['--nothing-to-review', 'nothingToReview']]);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = {
    pr: null,
    repo: process.env.GITHUB_REPOSITORY || null,
    sha: null,
    findings: null,
    author: null,
    config: DEFAULT_CONFIG,
    reason: null,
    nothingToReview: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const boolKey = BOOL_FLAGS.get(argv[i]);
    if (boolKey) {
      out[boolKey] = true;
      continue;
    }
    const key = FLAGS.get(argv[i]);
    if (!key) throw new PostReviewError('BAD_ARGS', `Unrecognised argument \`${argv[i]}\`.`);
    const v = argv[i + 1];
    if (v === undefined) throw new PostReviewError('BAD_ARGS', `\`${argv[i]}\` needs a value.`);
    out[key] = v;
    i += 1;
  }
  return out;
}

export { PostReviewError };
export { MAX_POSTED_FINDINGS, readFindingsDoc, readFindings, readOmitted, marker };
export { fingerprint } from './lib/review-findings.mjs';
export { confirmedOnHead } from './lib/review-comments.mjs';
export { nothingToReviewBody } from './lib/review-summary.mjs';
export { summaryBody, readJudgedAway, readCappedCount };

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.pr || !/^\d+$/.test(String(args.pr))) {
    throw new PostReviewError('NO_PR', `Pass \`--pr <number>\`; got ${JSON.stringify(args.pr)}.`);
  }
  if (!args.repo) {
    throw new PostReviewError(
      'NO_REPO',
      'Pass `--repo owner/name` or set GITHUB_REPOSITORY. Guessing it would mean posting a review into a ' +
        'repository this script never confirmed.',
    );
  }
  if (!args.sha || !/^[0-9a-f]{40}$/.test(args.sha)) {
    throw new PostReviewError(
      'NO_SHA',
      `Pass \`--sha <40-hex>\`, the head the review READ; got ${JSON.stringify(args.sha)}. Deriving it ` +
        'here would let the marker name a commit different from the one the model was shown.',
    );
  }
  if (!args.findings && !args.nothingToReview) {
    throw new PostReviewError('BAD_ARGS', 'Pass `--findings <findings.json>` or `--nothing-to-review`.');
  }
  if (args.findings && args.nothingToReview) {
    throw new PostReviewError(
      'BAD_ARGS',
      '`--nothing-to-review` and `--findings` are mutually exclusive: one says the model never ran, the ' +
        'other carries what it produced. Passing both means the caller does not know which happened.',
    );
  }
  if (!args.author) {
    throw new PostReviewError(
      'BAD_ARGS',
      'Pass `--author <login>`, the identity this workflow posts as. Without it the read-back cannot tell ' +
        "our own comments from anyone else's, and counting a stranger's comment as a posted finding is " +
        'how a read-back would certify a review that never landed.',
    );
  }

  const author = normaliseLogin(args.author);
  const cfg = readConfig(args.config);
  if (!cfg.expectedAuthors.has(author)) {
    throw new PostReviewError(
      'AUTHOR_NOT_EXPECTED',
      `\`${args.author}\` is not in \`expectedAuthors\` (${[...cfg.expectedAuthors].join(', ')}) in ` +
        `\`${args.config}\`. A marker from an unexpected author is invisible to check-review-posted.mjs, ` +
        'so posting one would produce a GREEN poster over a RED gate. Refused before anything is posted. ' +
        'REMEDY: add the login to the config on the BASE branch -- that is the copy the gate reads -- or ' +
        'fix `--author`.',
    );
  }

  // THE NOTHING-TO-REVIEW PATH, taken before any findings handling because there
  // are none by construction. Extracted to `postNothingToReview`
  // (lib/review-comments.mjs, module-size budget, #3795); every branch inside
  // it calls `process.exit(0)` itself, so control never returns here.
  if (args.nothingToReview) {
    postNothingToReview({ repo: args.repo, pr: args.pr, sha: args.sha, author, reason: args.reason });
  }

  // Read BEFORE the first network call. A malformed findings file must refuse
  // with nothing posted, not halfway through the loop.
  const doc = readFindingsDoc(args.findings);
  const findings = readFindings(doc, args.findings);
  const omitted = readOmitted(doc, args.findings);

  // ------------------------------------------------------------------ STEP 1
  const head = fetchHeadSha(args.repo, args.pr);
  if (head !== args.sha) {
    console.log(
      `SKIPPED_STALE: this review read ${args.sha.slice(0, 9)}; the PR head is now ${head.slice(0, 9)}.`,
    );
    console.log('   Nothing posted. A marker for a dead head is one the gate calls STALE_REVIEW, and no');
    console.log('   re-run of THIS commit could clear it. The run triggered by the new head owns it.');
    process.exit(0);
  }

  // ------------------------------------------------------------ STEPS 2 + 3
  // Extracted to `postFindingsAndConfirm` (lib/review-comments.mjs,
  // module-size budget, #3795): posts every not-yet-present finding, then
  // reads the surface back and confirms what is on the pull request. Throws
  // READBACK_SHORT with no marker written -- see that function's own comment.
  const { posted, skipped, confirmed } = postFindingsAndConfirm({
    repo: args.repo,
    pr: args.pr,
    sha: args.sha,
    author,
    findings,
  });

  // This run found nothing while our own findings stand on this commit. They
  // STAND: marker `findings`, summary states the disagreement, exit 0. A
  // disagreement between two runs is a fact to record, not a failure to post.
  // Withdrawal still needs a human but is no longer the only way out of a red
  // lane. Why this replaced a throw: see CLEAN_CONTRADICTED in the header.
  if (findings.length === 0 && confirmed > 0) {
    console.log(
      `CONTRADICTED: this run found nothing, yet ${confirmed} inline finding(s) from ` +
        `\`${author}\` are anchored to ${args.sha.slice(0, 9)}. Those findings STAND: the marker ` +
        'records `findings`, not `clean`, so the gate does not read this as a pass. If they are ' +
        'genuinely withdrawn, delete the inline comments and re-run.',
    );
  }

  // ------------------------------------------------------------------ STEP 4+5
  const verdict = confirmed === 0 ? 'clean' : 'findings';
  upsertAndVerify({
    repo: args.repo,
    pr: args.pr,
    sha: args.sha,
    author,
    body: summaryBody({
      sha: args.sha,
      findings,
      count: confirmed,
      judgedAway: readJudgedAway(doc),
      capped: readCappedCount(doc, findings.length),
      omitted,
    }),
    want: marker(args.sha, verdict, confirmed, omitted.length),
  });

  console.log(`Head: ${args.sha.slice(0, 9)}`);
  console.log(`Findings: ${findings.length} (posted ${posted}, already present ${skipped})`);
  console.log(`Confirmed on this head: ${confirmed}`);
  if (omitted.length > 0) {
    console.log(`PARTIAL: ${omitted.length} file(s) were never sent to the reviewer; the marker says so.`);
  }
  console.log('');
  console.log(
    `✅ REVIEW_POSTED: wrote a ${verdict} marker for ${args.sha.slice(0, 9)} with count=${confirmed}, AFTER ` +
      'reading every finding back from the pull request.',
  );
  console.log('   The count is what GitHub handed back, never what the model claimed.');
  process.exit(0);
}

if (isMainEntry(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (
      err instanceof PostReviewError ||
      err instanceof GhError ||
      err instanceof ReviewPostedError ||
      err instanceof ReviewProvenanceError
    ) {
      console.error(`❌ ${err.reason}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
