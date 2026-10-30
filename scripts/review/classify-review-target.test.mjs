/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyReviewTarget, RELEASE_BRANCH, RELEASE_TITLE } from './classify-review-target.mjs';

test('#3771: the generated changesets release PR does not consume a model review', () => {
  const result = classifyReviewTarget({
    headRef: 'changeset-release/main',
    title: 'chore: version packages',
  });
  assert.equal(result.skip, true);
  assert.match(result.reason, /deterministic release/);
});

test('#3771: branch or title near-matches stay on the normal review path', () => {
  for (const input of [
    { headRef: 'feature', title: 'chore: version packages' },
    { headRef: 'changeset-release/main', title: 'chore: version packages with code' },
    { headRef: 'Changeset-release/main', title: 'chore: version packages' },
  ]) {
    assert.deepEqual(classifyReviewTarget(input), { skip: false, reason: null });
  }
});

test('the lane runs on the generated release PR even while it is a draft', () => {
  // release-pr-freshness.yml drafts that PR on every main move and un-drafts it
  // with GITHUB_TOKEN (no ready_for_review event), so the Release run's refresh
  // push is a `synchronize` on a DRAFT. A job `if` that demands draft == false
  // skips it, the head gets no marker, and Review posted reports STALE_REVIEW.
  const workflow = readFileSync(new URL('../../.github/workflows/claude-review.yml', import.meta.url), 'utf8');
  const reviewJob = workflow.slice(workflow.indexOf('\n  review:\n'), workflow.indexOf('\n  stand-down-clear:\n'));
  const condition = reviewJob.match(/\n {4}if: >-\n((?: {6}.*\n)+)/)?.[1] ?? '';
  assert.ok(condition, 'the review job has a multi-line `if`');
  const flat = condition.replace(/\s+/g, ' ');
  assert.ok(
    flat.includes(`github.event.pull_request.head.ref == '${RELEASE_BRANCH}'`) &&
      flat.includes(`github.event.pull_request.title == '${RELEASE_TITLE}'`),
    'the draft exemption names exactly the pair classifyReviewTarget skips',
  );
  assert.match(flat, /draft == false \|\| \(/);
  assert.match(flat, /head\.repo\.full_name == github\.repository/, 'fork PRs stay excluded');
  assert.match(flat, /vars\.CLAUDE_REVIEW_ENABLED == 'true'/, 'the kill switch still applies');
  // The exemption is only safe because the lane then posts a marker without the model.
  assert.equal(classifyReviewTarget({ headRef: RELEASE_BRANCH, title: RELEASE_TITLE }).skip, true);
});
