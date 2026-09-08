/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchForRange } from './refresh-eval-case.mjs';

test('#3834: fixture refresh stores only the GitHub patch, not diff headers', () => {
  const seen = [];
  const patch = patchForRange('a'.repeat(40), 'b'.repeat(40), 'src/a.ts', { exec: (cmd, args) => {
    seen.push([cmd, args]);
    return 'diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  } });
  assert.equal(patch, '@@ -1 +1 @@\n-old\n+new');
  assert.deepEqual(seen[0], ['git', ['diff', '--no-ext-diff', '--unified=3', 'a'.repeat(40), 'b'.repeat(40), '--', 'src/a.ts']]);
});

test('#3834: a path absent from the defective range is refused', () => {
  assert.throws(
    () => patchForRange('a'.repeat(40), 'b'.repeat(40), 'src/a.ts', { exec: () => '' }),
    /no textual diff/,
  );
});
