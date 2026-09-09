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
  // images. `.svg` is the one exception to "no runner in this repo compiles
  // or executes it": apps/viewer/vite.config.ts DOES transform real SVG bytes
  // (string-replace theming, then `svgo.optimize()`) for the icons under
  // apps/viewer/src/icons/ — verified #4137 follow-up. It stays inert anyway
  // because no test observes that output today: node --test's
  // apps/viewer/src/test/vite-module-hooks-impl.mjs collapses every `~icons/*`
  // import onto one stub component before a test ever sees it, so the real
  // svgo/theming pipeline runs only under `vite build`/`vite dev`, which the
  // revert-oracle never invokes. If a test ever imports icon output through a
  // path that isn't stubbed, `.svg` needs to come back off this list — don't
  // delete this paragraph without re-checking that first.
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
