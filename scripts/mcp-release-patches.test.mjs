/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { matchesPostimage, patchPostimages } from '../packages/mcp/release/patch-postimage.mjs';

function patch(original, hunk) {
  const id = createHash('sha1').update(`blob ${Buffer.byteLength(original)}\0${original}`).digest('hex');
  return [
    'diff --git a/code.js b/code.js',
    `index ${id}..1111111 100644`,
    '--- a/code.js',
    '+++ b/code.js',
    hunk,
  ].join('\n');
}

test('#11619 rejects an old standalone line even if the replacement contains it', () => {
  const [file] = patchPostimages(patch('send();\n', '@@ -1 +1 @@\n-send();\n+if (enabled) send();\n'));
  assert.equal(matchesPostimage('if (enabled) send();\n', file), true);
  assert.equal(matchesPostimage('if (enabled) send();\nsend();\n', file), false);
});

test('#11619 rejects any retained removal and allows upstream duplicates outside the hunk', () => {
  const diff = patch('oldA();\noldB();\n\noldA();\n', '@@ -1,2 +1 @@\n-oldA();\n-oldB();\n+replacement();\n');
  const [file] = patchPostimages(diff.replaceAll('\n', '\r\n'));
  assert.equal(matchesPostimage('replacement();\r\n\r\noldA();\r\n', file), true);
  assert.equal(matchesPostimage('replacement();\noldA();\n\noldA();\n', file), false);
  assert.equal(matchesPostimage('replacement();\noldB();\n\noldA();\n', file), false);
});

test('#11619 requires exact hunk positions and preserves a missing final newline', () => {
  const diff = patch('intro\nold', '@@ -2 +2 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  const [file] = patchPostimages(diff);
  assert.equal(matchesPostimage('intro\nnew', file), true);
  assert.equal(matchesPostimage('new\nintro', file), false);
  assert.equal(matchesPostimage('intro\nnew\n', file), false);
});
