/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueCommentsLastPage } from './review-poll-page.mjs';

function rows(surface, count) {
  return Array.from({ length: count }, () => ({ surface }));
}

test('issueCommentsLastPage: derives the bound from the issueComments surface alone', () => {
  // #4018: 97 issueComments + 4 reviewComments + 3 reviews = 104 combined,
  // but issueComments alone (97) is one page.
  const comments = [...rows('issueComments', 97), ...rows('reviewComments', 4), ...rows('reviews', 3)];
  assert.equal(comments.length, 104);
  assert.equal(issueCommentsLastPage(comments, 100), 1);
});

test('issueCommentsLastPage boundaries: 100 is one page, 101 is two', () => {
  assert.equal(issueCommentsLastPage(rows('issueComments', 100), 100), 1);
  assert.equal(issueCommentsLastPage(rows('issueComments', 101), 100), 2);
});

test('issueCommentsLastPage: unaffected by other surfaces once issueComments itself spans pages', () => {
  const wide = [...rows('issueComments', 250), ...rows('reviewComments', 50), ...rows('reviews', 50)];
  assert.equal(issueCommentsLastPage(wide, 100), 3);
  assert.equal(issueCommentsLastPage(rows('issueComments', 250), 100), 3);
});

test('issueCommentsLastPage: empty issueComments still probes page 1', () => {
  assert.equal(issueCommentsLastPage(rows('reviewComments', 5), 100), 1);
});
