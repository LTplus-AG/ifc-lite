/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * POSTING AND READING BACK GITHUB COMMENTS (module-size budget, #3795 split
 * out of post-review.mjs). `fetchSurface`/`fetchHeadSha` read; `postFinding`
 * posts one inline comment and checks the response for a comment id (the
 * #1679 shape caught at the source); `confirmedOnHead` is the gate's own
 * "which commit did this row see" predicate, imported as one function rather
 * than one spelling so the two cannot drift; `upsertAndVerify` writes the
 * marker comment and proves it is readable afterwards -- the read-back is the
 * whole contract this file exists to keep.
 */

import { gh, GhError } from '../../lib/gh.mjs';
import { wroteAtCommit } from '../../lib/review-provenance.mjs';
import { MARKER_RE, pageAll, normaliseLogin } from '../../check-review-posted.mjs';
import { PostReviewError } from './post-review-error.mjs';
import { marker, fingerprint } from './review-findings.mjs';
import { nothingToReviewBody } from './review-summary.mjs';
import { resolvedCommentIds } from './resolved-threads.mjs';

/**
 * Walk one comment surface to exhaustion within a REAL page bound.
 *
 * `pageAll` is the gate's, imported: a second pager would be a second set of
 * boundary conditions to get wrong, and this one is already pinned by tests at
 * the exactly-full-last-page boundary.
 */
function fetchSurface(repo, pr, surface) {
  const base = `repos/${repo}/${surface}`;
  const { rows, truncated } = pageAll((page, perPage) =>
    gh(
      ['api', `${base}?per_page=${perPage}&page=${page}`, '--method', 'GET'],
      `${surface} page ${page}`,
      PostReviewError,
    ),
  );
  if (truncated) {
    throw new PostReviewError(
      'COMMENTS_TRUNCATED',
      `\`${surface}\` still had pages after the bounded walk, so a finding may sit on a page this script ` +
        'never read. Refusing to count what it could not finish reading. REMEDY: raise the pager budget ' +
        'in check-review-posted.mjs, or narrow what the reviewer posts.',
    );
  }
  return rows;
}

/** STEP 1. The head as GitHub sees it now, not as the workflow was told at dispatch. */
export function fetchHeadSha(repo, pr) {
  const pull = gh(['api', `repos/${repo}/pulls/${pr}`, '--method', 'GET'], `pull request #${pr}`, PostReviewError);
  const sha = pull?.head?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new PostReviewError(
      'HEAD_UNREADABLE',
      `\`repos/${repo}/pulls/${pr}\` returned no 40-hex \`head.sha\` (got ${JSON.stringify(sha)}). ` +
        'Proceeding on a head this script never confirmed would post findings against a guess. REMEDY: ' +
        "check the token's `pull-requests` scope and re-run.",
    );
  }
  return sha;
}

/**
 * THE GATE'S OWN PREDICATE, and now literally the same code rather than the same
 * SPELLING. Both sides call `wroteAtCommit`, so they cannot drift.
 *
 * IT USED TO READ `commit_id === sha`, AND THAT DEFEATED THREE THINGS AT ONCE
 * (#3729 -- the measurement is in scripts/lib/review-provenance.mjs). A stale
 * row relocated onto this head:
 *
 *   - STEP 2 (dedup) read as "already present at this head", so the finding was
 *     SKIPPED and never posted -- and step 3 then counted that same stale row as
 *     the confirmation that it had been. The two cancel.
 *   - STEP 3 (read-back), the check that exists because #1679 reports success
 *     over comments that do not exist, was satisfied by comments on another
 *     commit.
 *   - `CLEAN_CONTRADICTED` fired on a genuinely clean run, because someone
 *     else's stale finding had been relocated onto its head.
 *
 * THE VISIBLE CONSEQUENCE, STATED RATHER THAN DISCOVERED: after a rebase, rows
 * GitHub relocated onto the new head no longer dedup, so a re-run POSTS the
 * findings again and the PR carries the relocated copies alongside the new
 * ones. That is the intended reading -- a row written against a tree that no
 * longer exists is not a review of this one -- but it is duplication a reader
 * will see, and it is the price of the read-back meaning what it says.
 */
export function confirmedOnHead(rows, author, sha) {
  return rows.filter((r) => normaliseLogin(r?.user?.login) === author && wroteAtCommit(r, sha));
}

/** STEP 2. One finding, posted and checked. */
function postFinding(repo, pr, sha, f, n, total) {
  const res = gh(
    [
      'api',
      `repos/${repo}/pulls/${pr}/comments`,
      '--method',
      'POST',
      '-f',
      `commit_id=${sha}`,
      '-f',
      `path=${f.path}`,
      '-F',
      `line=${f.line}`,
      '-f',
      'side=RIGHT',
      '-f',
      `body=${f.body}`,
    ],
    `inline finding ${n}/${total} at ${f.path}:${f.line}`,
    PostReviewError,
  );
  // A 2xx with no id is not a posted comment. #1679's whole shape is a success
  // report over a comment that does not exist, so the RESPONSE is checked rather
  // than the exit code -- the exit code is exactly the evidence that bug teaches
  // us not to accept.
  if (!res || res.id === undefined || res.id === null) {
    throw new PostReviewError(
      'INLINE_POST_FAILED',
      `POST of finding ${n}/${total} at ${f.path}:${f.line} returned no comment id. Aborting with NO ` +
        'MARKER, so the gate reads NOT_POSTED and a re-run is safe. REMEDY: re-run. A 422 here usually ' +
        `means line ${f.line} is not in this commit's diff; fix the finding's anchor.`,
    );
  }
  return res;
}

/**
 * Write the marker comment and PROVE it is readable afterwards.
 *
 * ONE COPY, used by both the review path and the nothing-to-review path. The
 * read-back is the whole contract this file exists to keep -- "it posted, trust
 * me" is exactly the claim the gate refuses -- so a second path that wrote a
 * marker without verifying it would be a hole in the shape of the bug.
 *
 * Idempotent by construction: a marker already written for THIS head is updated
 * in place. Two markers for one sha would leave the gate reading whichever came
 * first in fetch order, which is not a decision anyone made.
 */
export function upsertAndVerify({ repo, pr, sha, author, body, want }) {
  const carrier = fetchSurface(repo, pr, `issues/${pr}/comments`).find(
    (c) =>
      normaliseLogin(c?.user?.login) === author &&
      MARKER_RE.exec(String(c?.body ?? ''))?.[1] === sha,
  );
  const res = carrier
    ? gh(
        ['api', `repos/${repo}/issues/comments/${carrier.id}`, '--method', 'PATCH', '-f', `body=${body}`],
        'the review summary (update in place)',
        PostReviewError,
      )
    : gh(
        ['api', `repos/${repo}/issues/${pr}/comments`, '--method', 'POST', '-f', `body=${body}`],
        'the review summary',
        PostReviewError,
      );
  if (!res || res.id === undefined || res.id === null) {
    throw new PostReviewError(
      'SUMMARY_POST_FAILED',
      'The marker comment returned no comment id, so the gate has nothing to read. REMEDY: check that the ' +
        'posting workflow has write access to the pull request, then re-run.',
    );
  }
  const readable = fetchSurface(repo, pr, `issues/${pr}/comments`).some(
    (c) => normaliseLogin(c?.user?.login) === author && String(c?.body ?? '').includes(want),
  );
  if (!readable) {
    throw new PostReviewError(
      'MARKER_NOT_READ_BACK',
      `The marker \`${want}\` is not readable on PR #${pr} one GET after it was written. A marker this ` +
        'script cannot read is one the gate may not be able to read either, and reporting success here ' +
        'would be the exact "it posted, trust me" claim this file exists to refuse. REMEDY: re-run; if ' +
        '`--author` is wrong the marker is on the PR under a different login, and the gate will keep ' +
        'reading NOT_POSTED until the login is fixed.',
    );
  }
}

/**
 * THE NOTHING-TO-REVIEW PATH, taken before any findings handling because there
 * are none by construction. It still checks the head first -- a marker for a
 * dead head is one the gate calls STALE_REVIEW -- and it posts ONE comment and
 * no inline anything. See `nothingToReviewBody` for why this is a verdict of
 * its own and not `clean`.
 *
 * Every branch below calls `process.exit(0)` itself, matching the other
 * early-exit paths in `main()` (e.g. the STALE_REVIEW check on the findings
 * path) -- control never returns to the caller.
 */
export function postNothingToReview({ repo, pr, sha, author, reason, allFindingsDropped = false }) {
  const verdictToken = allFindingsDropped ? 'dropped' : 'nothing-to-review';
  // A REAL VERDICT FOR THIS HEAD OUTRANKS THIS ONE. `upsertAndVerify` finds a
  // carrier by sha alone, so without this it would PATCH an existing
  // `verdict=findings count=3` summary into "nothing to review / count=0" --
  // orphaning three inline comments and stepping around the
  // FINDINGS_NOT_POSTED cross-check that exists to catch exactly that gap.
  // Reachable only if the exclusion outcome flipped for one head, which needs
  // dedup to have failed; narrow, and a downgrade this file must never make.
  //
  // `dropped` IS ONE OF THE VERDICTS THAT OUTRANKS THIS ONE (#3775). It reads
  // `covered=false` at the gate, `nothing-to-review` reads `covered=true`, so
  // letting the second overwrite the first would flip the head from "nobody
  // reviewed this, come back" to "the lane decided, skip it" with nothing
  // reviewed in between -- the sealing #3775 exists to prevent, arriving through
  // this guard instead of through the verdict. The two paths are chosen by
  // DIFFERENT inputs for the same head (the exclusion outcome depends on config
  // read from the BASE branch, which can change while the sha does not), so this
  // is not merely theoretical ordering.
  //
  // Only `nothing-to-review` is overwritable, which also makes a repeat of THIS
  // path a no-op rather than a rewrite: a second all-dropped run finds its own
  // marker, reports below, and leaves it alone.
  const existing = fetchSurface(repo, pr, `issues/${pr}/comments`).find((c) => {
    const m = MARKER_RE.exec(String(c?.body ?? ''));
    return normaliseLogin(c?.user?.login) === author && m?.[1] === sha && m[2] !== 'nothing-to-review';
  });
  if (existing) {
    // REPORTED, AND EXIT 0. The refusal is right -- overwriting a real verdict
    // would retract it and orphan any inline findings under it -- but THROWING
    // was wrong: it reddens the lane job for a state that needs no action, the
    // gate is already satisfied by the standing marker, and no re-run could
    // ever clear it. That is precisely the unclearable-red class this branch
    // exists to remove, reintroduced by its own guard. Raised by CodeRabbit on
    // PR #3587.
    const standingVerdict = MARKER_RE.exec(existing.body)[2];
    console.log(
      `WOULD_DOWNGRADE_VERDICT: a \`${standingVerdict}\` marker already stands for ` +
        `${sha.slice(0, 9)}. Overwriting it with \`${verdictToken}\` would retract that ` +
        'verdict and orphan any inline findings under it, so nothing was posted.' +
        // NOT "this head IS covered" unconditionally: `dropped` is deliberately
        // NOT covered, and saying otherwise would tell the reader the opposite of
        // what the gate is about to do.
        (standingVerdict === 'dropped'
          ? ' The standing marker says every finding was dropped, so this head is NOT covered and the' +
            ' lane will review it again; there is nothing to do here.'
          : ' This head IS covered and the gate reads it; there is nothing to do.'),
    );
    process.exit(0);
  }
  const liveHead = fetchHeadSha(repo, pr);
  if (liveHead !== sha) {
    console.log(`SKIPPED_STALE: this run read ${sha.slice(0, 9)}; the PR head is now ${liveHead.slice(0, 9)}.`);
    process.exit(0);
  }
  upsertAndVerify({
    repo,
    pr,
    sha,
    author,
    body: nothingToReviewBody(sha, reason, { allFindingsDropped }),
    want: marker(sha, verdictToken, 0),
  });
  console.log(`Posted a ${verdictToken} marker for ${sha.slice(0, 9)}.`);
  process.exit(0);
}

/**
 * STEPS 2+3. Post every finding not already present on this head (deduped by
 * `fingerprint`), then read the comment surface back and count what is
 * CONFIRMED at this exact commit -- never what this run merely sent. Throws
 * READBACK_SHORT, with no marker written, when fewer are visible than the
 * review has: every POST reported success, so that shape is #1679 caught at
 * the read-back. Compared against `findings.length`, not `posted`,
 * deliberately STRONGER than "what this run sent" -- see the caller's own
 * comment on that choice.
 *
 * @returns {{ posted: number, skipped: number, confirmed: number, standing: number,
 *   resolutionIncomplete: boolean }}
 *   `confirmed` is every finding of ours anchored to this head. `standing` is
 *   the subset a reader should still act on: it drops the ones whose review
 *   thread someone RESOLVED, which is the only question REST cannot answer
 *   (#3768).
 */
export function postFindingsAndConfirm({ repo, pr, sha, author, findings }) {
  const before = fetchSurface(repo, pr, `pulls/${pr}/comments`);
  const already = new Set(
    confirmedOnHead(before, author, sha).map((r) => fingerprint(r.path, r.line, String(r.body ?? ''))),
  );
  let posted = 0;
  let skipped = 0;
  for (const [i, f] of findings.entries()) {
    if (already.has(fingerprint(f.path, f.line, f.body))) {
      skipped += 1;
      continue;
    }
    postFinding(repo, pr, sha, f, i + 1, findings.length);
    posted += 1;
  }

  const after = fetchSurface(repo, pr, `pulls/${pr}/comments`);
  const confirmedRows = confirmedOnHead(after, author, sha);
  const confirmed = confirmedRows.length;

  if (confirmed < findings.length) {
    throw new PostReviewError(
      'READBACK_SHORT',
      `Read back ${confirmed} inline comment(s) from \`${author}\` on ${sha.slice(0, 9)}; the review ` +
        `has ${findings.length} finding(s) (${posted} posted this run, ${skipped} already present). Every ` +
        'POST reported success, so this is the #1679 shape exactly: `Posted 0/N` under a green job. NO ' +
        'MARKER WRITTEN, so the gate reads NOT_POSTED and a re-run is safe. REMEDY: re-run. If it recurs, ' +
        'attach the log to anthropics/claude-code-action#1679 rather than re-running indefinitely.',
    );
  }

  // WITHDRAWAL, THE ONE QUESTION REST CANNOT ANSWER (#3768). `commit_id`
  // relocates onto every later head (#3729), and REST exposes no resolution
  // state at all, so a PR that ever received a finding could never carry a
  // `clean` marker again: RESOLVING the thread -- the intended, non-destructive
  // act -- changed nothing a REST reader could see, and deleting the comment,
  // which destroys the audit trail, was the only way out.
  //
  // CONSULTED ON EVERY RUN, not only on a clean one. Scoping it to the clean
  // branch would keep this REST-only at the cost of a wrong count everywhere
  // else: a run finding one new thing over two RESOLVED old findings would write
  // `count=3` and tell the reader three comments stand when two were withdrawn.
  //
  // A RE-REPORTED FINDING COUNTS EVEN IF ITS THREAD IS RESOLVED. Its comment is
  // deduped rather than re-posted, so excluding it would report fewer standing
  // findings than this run actually produced. That is also what keeps
  // `standing >= findings.length`: every finding here has a confirmed row
  // carrying its fingerprint, by the READBACK_SHORT check just above.
  //
  // Fails CLOSED: a thread this cannot account for stays unresolved and keeps
  // counting, so a GraphQL failure can only make the count too HIGH, never too
  // low. Safe, and invisible -- so the caller discloses it.
  let standing = confirmed;
  let resolutionIncomplete = false;
  if (confirmed > 0) {
    const { ids, warnings, complete } = resolvedCommentIds(repo, pr);
    resolutionIncomplete = !complete;
    for (const w of warnings) console.log(`WARN: ${w} Findings it could not account for still stand.`);
    const reReported = new Set(findings.map((f) => fingerprint(f.path, f.line, f.body)));
    standing = confirmedRows.filter(
      (r) => !ids.has(Number(r?.id)) || reReported.has(fingerprint(r.path, r.line, String(r.body ?? ''))),
    ).length;
    if (standing < confirmed) {
      console.log(
        `RESOLVED: ${confirmed - standing} of ${confirmed} standing finding(s) sit on a resolved review thread.`,
      );
    }
  }
  return { posted, skipped, confirmed, standing, resolutionIncomplete };
}
