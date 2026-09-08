/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * File kinds no runner in this repo (vitest, node --test, cargo, pytest) ever
 * compiles or executes: an image's bytes, a font's glyphs, an archive's
 * contents. Changing one — including deleting it — leaves nothing for a test
 * to observe, so it is neither test nor production (#4137).
 *
 * Observed on two real branches before this existed: #4114 (five deleted
 * PNGs) and #4117 (an 87-file archive of JSON/patch/PNG evidence) both
 * tripped `check-test-revert-oracle.mjs`'s "changes production code and
 * adds/changes NO test file" ABORT — a false positive about the classifier,
 * not a finding about either branch, since no test can observe a deleted
 * PNG's absence.
 *
 * Deliberately narrow: this must NOT swallow anything a runner builds or
 * runs. `.json` stays production (e.g. `package.json` gates behaviour via
 * scripts/deps) — only formats with no runner-observable content at all are
 * listed here.
 */
const INERT_SUFFIXES = [
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.avif', '.bmp', '.tiff', '.tif',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // other binaries with no observable behaviour of their own
  '.zip', '.gz', '.tar', '.pdf',
];

/** @param {string} path */
export function isInertPath(path) {
  const lower = path.toLowerCase();
  return INERT_SUFFIXES.some((s) => lower.endsWith(s));
}
