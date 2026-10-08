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

/**
 * Test-support modules outside any test directory and not named `*.test.*`,
 * which exist only to serve a test entrypoint: `shard-refusal-boundary`
 * registers assertions for `scripts/test-wasm-contract.mjs`, and
 * `relocated-gate-source` prepares the copy of the source-text gate that
 * `check-source-text-assertions.test.mjs` and its identity twin run in a
 * synthetic tree; nothing else imports either. Editing one changes what a
 * test asserts or runs. Classifying it as production tripped the "changes
 * production code and adds/changes NO test file" ABORT on #4501, and
 * reverting one as production takes the tests that import it down at load
 * time — an attribution gap (INCONCLUSIVE), never a verdict (#4536). The
 * same classifier false-positive shape the inert list above fixed for
 * binary assets. Kept exact, not a pattern: `scripts/lib/` is otherwise real
 * production tooling and must keep reading as such.
 *
 * `host-preconditions` and the xmatch `build-output-guard` (#7030) compute the
 * `skip` value script tests pass to `node:test` when a tool or build output is
 * missing; only test files import them.
 */
const TEST_SUPPORT_EXACT = new Set([
  'scripts/lib/shard-refusal-boundary.mjs',
  'scripts/lib/relocated-gate-source.mjs',
  'scripts/lib/wasm-rtc-precision-contracts.mjs',
  'scripts/lib/host-preconditions.mjs',
  'scripts/xmatch/build-output-guard.mjs',
]);

export function isTestSupportPath(path) {
  return TEST_SUPPORT_EXACT.has(path);
}

/**
 * Playwright specs (#4404, #4340, #6267): a `*.spec.ts` that imports
 * `@playwright/test` runs only under `playwright test`, against a built
 * viewer, in a real browser. No package `scripts.test` can run it, so the
 * dispatcher partitions these out of the node/cargo/pytest planning and hands
 * them to the browser observer (`revert-oracle-browser-run.mjs`), which runs
 * them only when no cheaper changed test already observed the revert.
 */
const PLAYWRIGHT_IMPORT_RE = /(^|\n)\s*import\s[^;]*?\sfrom\s+['"]@playwright\/test['"]/;

/** @param {string} source file text */
export function isBrowserSpecSource(source) {
  return typeof source === 'string' && PLAYWRIGHT_IMPORT_RE.test(source);
}

/**
 * Split `paths` (repo-relative) into the tests a repo runner can drive and the
 * Playwright specs only a browser can; `read(path)` returns the file text
 * (callers pass only paths that exist). Only `*.spec.*` files are read:
 * `*.test.*` files are never Playwright specs in this repo.
 * @returns {{ runnable: string[], browser: string[] }}
 */
export function partitionBrowserSpecs(paths, read) {
  const runnable = [], browser = [];
  for (const p of paths) {
    const spec = /\.spec\.[cm]?[jt]sx?$/.test(p) && isBrowserSpecSource(read(p));
    (spec ? browser : runnable).push(p);
  }
  return { runnable, browser };
}
