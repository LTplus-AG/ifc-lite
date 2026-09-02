/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The property under test: THE PACK MUST SURFACE THE SITE THE PR DID NOT TOUCH.
 *
 * Five of one day's twelve merge-blocking defects were "fixed at one site when
 * the codebase has two", and in every case the unfixed site was the published
 * one. A baseline eval of the current lane scored 1/15 and missed all five.
 * Running the CodeRabbit CLI over three of them found the sibling in none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchKeys, hunkLines, fileEvidence, MAX_WHOLE_FILE_LINES } from './build-context-pack.mjs';

test('search keys come from REMOVED lines first, because the sibling still has them', () => {
  const patch = [
    '@@ -1,3 +1,3 @@',
    ' ctx',
    '-  const legacyHelperName = raw;',
    '+  const legacyHelperName = srgbToLinear(raw);',
  ].join('\n');
  const keys = searchKeys(patch, { path: 'a.ts' });
  assert.ok(keys.includes('legacyHelperName'));
  assert.ok(keys.indexOf('legacyHelperName') < keys.indexOf('srgbToLinear'),
    'what the PR deleted at site A is what site B still contains, so it ranks first');
});

test('PROSE MUST NOT EAT THE KEY BUDGET', () => {
  // Measured on two real cases: every extracted key came from the MPL licence
  // header ("Source, subject, terms, Mozilla, Public, License") or changeset
  // markdown, and the identifiers that actually find the sibling never got a
  // slot. Filtering prose took second-site retrieval from 0/5 to 4/5.
  const licence = [
    '@@ -1,4 +1,5 @@',
    '+/* This Source Code Form is subject to the terms of the Mozilla Public',
    '+ * License, v. 2.0. If a copy of the MPL was not distributed with this',
    '+ * file, You can obtain one at https://mozilla.org/MPL/2.0/. */',
    '+const missingLanes = computeLanes(rollup);',
  ].join('\n');
  const keys = searchKeys(licence, { path: 'a.mjs' });
  assert.ok(keys.includes('missingLanes'), 'the identifier must survive the header');
  for (const junk of ['Mozilla', 'License', 'subject', 'distributed']) {
    assert.ok(!keys.includes(junk), `${junk} is prose, not a second implementation`);
  }
});

test('markdown yields no keys at all: a changeset is not an implementation', () => {
  const md = ['@@ -1,2 +1,3 @@', "+Both tools now share a materialDisplayName helper."].join('\n');
  assert.deepEqual(searchKeys(md, { path: '.changeset/x.md' }), []);
});

test('a long file is windowed around its hunks, not truncated from the top', () => {
  // A defect in count-distortion or dedup lives in the FUNCTION, not the hunk.
  // Truncating from line 1 would reliably cut the part that matters.
  const patch = ['@@ -900,2 +900,3 @@', ' ctx', '+added'].join('\n');
  const big = Array.from({ length: MAX_WHOLE_FILE_LINES + 500 }, (_, i) => `line${i}`).join('\n');
  const e = fileEvidence(patch, big);
  assert.equal(e.kind, 'window');
  assert.ok(e.from < 900 && e.to > 900, 'the window must contain the hunk');
});

test('hunkLines numbers the NEW file, so a window lands where the reader will look', () => {
  assert.deepEqual(hunkLines('@@ -1,2 +10,4 @@\n ctx\n+one\n+two'), [11, 12]);
});
