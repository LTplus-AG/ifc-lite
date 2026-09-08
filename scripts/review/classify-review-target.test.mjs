/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReviewTarget } from './classify-review-target.mjs';

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
