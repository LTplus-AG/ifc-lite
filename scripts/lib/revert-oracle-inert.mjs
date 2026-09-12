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
 * which exist only to register assertions for a test entrypoint
 * (`scripts/test-wasm-contract.mjs` imports the one below; nothing else does).
 * Editing one changes what a test asserts. Classifying it as production tripped
 * the "changes production code and adds/changes NO test file" ABORT on #4501 —
 * the same classifier false-positive shape the inert list above fixed for
 * binary assets. Kept exact, not a pattern: `scripts/lib/` is otherwise real
 * production tooling and must keep reading as such.
 */
const TEST_SUPPORT_EXACT = new Set([
  'scripts/lib/shard-refusal-boundary.mjs',
]);

export function isTestSupportPath(path) {
  return TEST_SUPPORT_EXACT.has(path);
}

/**
 * Playwright specs (#4404, #4340): a `*.spec.ts` that imports `@playwright/test`
 * runs only under `playwright test`, against a built viewer, in a real browser.
 * The repo's `tests/e2e/` specs are owned by the root package, whose
 * `scripts.test` is `turbo test` — no runner the oracle can derive, so a
 * branch that added one alongside real production code ABORTed with "no
 * runner could be derived" (#4340 merged over that red). The spec cannot count
 * as observation either (the oracle never launches a browser), so it is set
 * aside: reported, removed from the run set, and the remaining node/cargo/
 * pytest tests still have to observe the change on their own.
 */
const PLAYWRIGHT_IMPORT_RE = /(^|\n)\s*import\s[^;]*?\sfrom\s+['"]@playwright\/test['"]/;

/** @param {string} source file text */
export function isBrowserSpecSource(source) {
  return typeof source === 'string' && PLAYWRIGHT_IMPORT_RE.test(source);
}

/** A test entrypoint by name (`*.test.*` / `*.spec.*`), as opposed to a helper module. */
const ENTRYPOINT_RE = /\.(test|spec)\.[^/]+$/;

/**
 * Split `paths` (repo-relative) into the tests a repo runner can drive and the
 * Playwright specs it cannot; `read(path)` returns the file text (callers
 * pass only paths that exist). Only `*.spec.*` files are read: `*.test.*`
 * files are never Playwright specs in this repo.
 *
 * A spec's SUPPORT modules leave with it (#4446): a page object, a relay
 * launcher, a fixture builder under the spec's directory, not an entrypoint
 * by name, and owned by the root package (`ownedByRoot(path)` — the caller
 * knows the package layout). They exist only for the spec and have no runner
 * either; left in the set they would keep the root group runner-less, and
 * the branch's unit tests could never be judged. Package-owned helpers are
 * never set aside: their package's runner handles them as it always did.
 * @returns {{ runnable: string[], browser: string[], support: string[] }}
 */
export function partitionBrowserSpecs(paths, read, ownedByRoot = () => false) {
  const rest = [], browser = [];
  for (const p of paths) {
    const spec = /\.spec\.[cm]?[jt]sx?$/.test(p) && isBrowserSpecSource(read(p));
    (spec ? browser : rest).push(p);
  }
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const under = (p, dir) => dir === '' || p.startsWith(`${dir}/`);
  const specDirs = browser.map(dirOf);
  const support = rest.filter((p) => !ENTRYPOINT_RE.test(p) && specDirs.some((d) => under(p, d)) && ownedByRoot(p));
  return { runnable: rest.filter((p) => !support.includes(p)), browser, support };
}

/** Dispatcher hook: log every set-aside Playwright spec (and its support) and return the runnable rest. */
export function withoutBrowserSpecs(paths, read, log, ownedByRoot) {
  const { runnable, browser, support } = partitionBrowserSpecs(paths, read, ownedByRoot);
  for (const p of browser) log(`  set aside: ${p} is a Playwright spec; it runs only under \`playwright test\` in a real browser, which the oracle cannot drive, so it neither observes the change nor blocks the verdict`);
  for (const p of support) log(`  set aside: ${p} is a root-owned support module of a set-aside Playwright spec; it has no runner of its own`);
  return runnable;
}
