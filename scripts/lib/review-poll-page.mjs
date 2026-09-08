/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which page of the `issueComments` endpoint alone the poll probe in
 * scripts/check-review-posted.mjs should ask for, so the page bound is
 * derived from the SAME surface being queried.
 *
 * The probe reads only `repos/{repo}/issues/{pr}/comments` -- the
 * issue-comment surface -- because that is where the marker lands. The page
 * bound has to be sized to that one endpoint's own length; sizing it to the
 * three-surface union `normaliseComments` produces (issueComments +
 * reviewComments + reviews) asks for a page number the issueComments endpoint
 * alone may not have, once the other two surfaces push the combined count
 * over a page boundary the issueComments count alone never crosses. That is
 * exactly the failure on PR #4018: 97 issueComments + 4 reviewComments + 3
 * reviews = 104 combined -> page 2, but issueComments alone is a single page
 * of 97, so every probe fetched an empty page 2 for the whole poll window and
 * the marker on page 1 was never seen.
 *
 * Pure over the already-normalised, surface-tagged comment list (see
 * `normaliseComments` in check-review-posted.mjs) so this is testable without
 * a network call.
 *
 * @param {{ surface: string }[]} comments
 * @param {number} perPage
 * @returns {number}
 */
export function issueCommentsLastPage(comments, perPage) {
  const issueCommentCount = comments.filter((c) => c.surface === 'issueComments').length;
  return Math.max(1, Math.ceil(issueCommentCount / perPage));
}
