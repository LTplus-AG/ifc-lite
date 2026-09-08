/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiffLineKind } from './unified-diff.mjs';
import { rowsChangedInPatch } from './base-freshness.mjs';

test('#3634: file headers and same-prefixed hunk content are distinguished by position', () => {
  assert.equal(unifiedDiffLineKind('--- a/file', false), 'header');
  assert.equal(unifiedDiffLineKind('+++ b/file', false), 'header');
  assert.equal(unifiedDiffLineKind('----', true), 'removed');
  assert.equal(unifiedDiffLineKind('+++i;', true), 'added');
});

test('#3634: snapshot rows starting with header prefixes remain changed rows', () => {
  const patch = [
    '--- a/scripts/module-size-allowlist.txt',
    '+++ b/scripts/module-size-allowlist.txt',
    '@@ -1,1 +1,1 @@',
    '--- 99 scripts/review/post-review.mjs',
    '+++ 100 scripts/review/validate-findings.mjs',
  ].join('\n');
  assert.deepEqual(
    [...rowsChangedInPatch(patch, () => true)],
    ['scripts/review/post-review.mjs', 'scripts/review/validate-findings.mjs'],
  );
});
