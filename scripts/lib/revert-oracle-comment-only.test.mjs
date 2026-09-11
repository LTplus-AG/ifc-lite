/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isCommentOnlyDiff } from './revert-oracle-comment-only.mjs';

test('a comment paragraph added above a value is comment-only (the #4165 shape)', () => {
  const diff = [
    '--- a/scripts/lib/revert-oracle-inert.mjs',
    '+++ b/scripts/lib/revert-oracle-inert.mjs',
    '@@ -21,7 +21,17 @@',
    '-  // images',
    "+  // images. `.svg` is the one exception to \"no runner in this repo compiles",
    '+  // or executes it\": apps/viewer/vite.config.ts DOES transform real SVG bytes',
    '+  // (string-replace theming, then `svgo.optimize()`) for the icons under',
    '+  // apps/viewer/src/icons/ -- verified #4137 follow-up. It stays inert anyway',
    "   '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif', '.bmp', '.tiff', '.tif',",
  ].join('\n');
  assert.equal(isCommentOnlyDiff('scripts/lib/revert-oracle-inert.mjs', diff), true);
});

test('a real code change alongside the comment is NOT comment-only', () => {
  // The must-not-regress direction: adding a real suffix to the deny-list in
  // the SAME diff as the comment must keep counting as production, or a
  // genuinely unobserved behaviour change would slip past the oracle.
  const diff = [
    '--- a/scripts/lib/revert-oracle-inert.mjs',
    '+++ b/scripts/lib/revert-oracle-inert.mjs',
    '@@ -21,3 +21,4 @@',
    '-  // images',
    '+  // images, now including HEIC',
    "-  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',",
    "+  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.heic',",
  ].join('\n');
  assert.equal(isCommentOnlyDiff('scripts/lib/revert-oracle-inert.mjs', diff), false);
});

test('a line that mixes code with a trailing comment is NOT comment-only', () => {
  // Must fail closed: a line is only a comment line if the WHOLE trimmed line
  // is a comment. `x = 1; // note` starts with code, not `//`.
  const diff = ['@@ -1 +1 @@', '-const x = 1;', '+const x = 1; // note'].join('\n');
  assert.equal(isCommentOnlyDiff('scripts/lib/revert-oracle.mjs', diff), false);
});

test('a JSDoc block (opening /**, continuation *, and code-free) is comment-only', () => {
  const diff = [
    '@@ -1 +1,3 @@',
    '+/**',
    '+ * A new paragraph.',
    '+ */',
  ].join('\n');
  assert.equal(isCommentOnlyDiff('scripts/lib/revert-oracle.mjs', diff), true);
});

test('an empty diff (no changed lines) is NOT comment-only -- nothing to certify', () => {
  assert.equal(isCommentOnlyDiff('scripts/lib/revert-oracle.mjs', ''), false);
});

test('a non-JS/TS file is never comment-only, even with an all-# diff', () => {
  // `#` is Python's comment token, not covered by this module -- scoped
  // narrow on purpose, same as isVersionOnlyManifestDiff.
  const diff = ['@@ -1 +1 @@', '-# old note', '+# new note'].join('\n');
  assert.equal(isCommentOnlyDiff('tools/ifcopenshell_reference/canonical.py', diff), false);
});

test('a .rs file is never comment-only even with an all-// diff', () => {
  const diff = ['@@ -1 +1 @@', '-// old note', '+// new note'].join('\n');
  assert.equal(isCommentOnlyDiff('crates/ifc-lite-geom/src/walk.rs', diff), false);
});
