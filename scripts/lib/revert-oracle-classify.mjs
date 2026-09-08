/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Diff classification for the revert oracle: which bucket does a changed file
 * belong to, and what does `git diff` already know about it.
 *
 * Split out of `revert-oracle.mjs` by #4137, which found that file at its exact
 * module-size budget (see `scripts/module-size-allowlist.txt`) with zero
 * headroom while the `inert` rule below needed real prose to be readable at
 * all. The seam is genuine rather than budget-driven: everything here is a
 * question about a PATH and git's own metadata, everything left behind in
 * `revert-oracle.mjs` is a question about a RUNNER's output. That file
 * re-exports the public functions, so no caller had to change.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR BUCKETS
 * ---------------------------------------------------------------------------
 *   test        a runner claims this file as a test.
 *   ignored     a hand-maintained list of paths whose change nothing here can
 *               revert usefully (changesets, docs, workflows, lockfiles).
 *   inert       NO runner claims it as a test and NO runner compiles, executes
 *               or loads it as source. See below.
 *   production  everything else: the revert set.
 *
 * ---------------------------------------------------------------------------
 * WHY `inert` EXISTS (#4137)
 * ---------------------------------------------------------------------------
 * Before it, every changed file that was not recognised as a test was
 * production, so a branch that deletes five unreferenced PNGs was told
 * "this branch changes production code and adds/changes NO test file. That is
 * itself the finding: nothing can observe the change." No test can observe a
 * deleted PNG: asserting a deleted file is absent restates the deletion, and
 * asserting anything about a PNG's bytes tests nothing about behaviour. That
 * verdict is a claim about the ORACLE ("I cannot measure this") rendered as a
 * finding about the AUTHOR, which is the defect family #4109 exists for. Seven
 * of the eight PRs that landed `scripts/perf/evidence/` carried
 * `revert-oracle-exempt` for exactly this misclassification, and each such
 * label switches the whole lane off for a whole PR.
 *
 * ---------------------------------------------------------------------------
 * HOW INERTNESS IS DERIVED, AND WHY IT IS NOT A DENY-LIST OF ASSET KINDS
 * ---------------------------------------------------------------------------
 * The tempting fix is `if (path.endsWith('.png') || ...) return 'inert'`. That
 * recreates the family it is meant to close: the list of things the oracle
 * cannot execute is UNBOUNDED (`.png`, `.woff2`, `.ico`, `.parquet`, `.avif`,
 * whatever ships next), the list is maintained by hand, and every miss renders
 * as a finding naming the author. A deny-list makes a NEW file kind
 * misclassified by default.
 *
 * So inertness is derived from what the oracle already knows — the runner set —
 * as a CONJUNCTION of two conditions that fail in opposite directions on
 * purpose:
 *
 *   1. NOT A RUNNER SOURCE KIND. `RUNNER_SOURCE_KINDS` below is an ALLOW-LIST,
 *      one entry per runner family the oracle can actually drive
 *      (`detectRunner` / `cargoRunner` / `pythonRunner`), naming what that
 *      runner compiles, executes, or resolves as a manifest. It is a closed
 *      set because the runner set is: a family the oracle cannot drive cannot
 *      produce a verdict either way, so adding a runner is exactly when this
 *      list grows, and the two live next to each other. Three of the entries
 *      are wired to their one definition rather than copied: the JS/TS
 *      extension array is the SAME array that builds `TEST_FILE_RE` below (so
 *      "a JS runner claims this as a test" and "a JS runner would load this as
 *      source" cannot drift apart), `CARGO_MANIFEST` comes from the module
 *      that walks up looking for it, and `PYTHON_PROJECT_MARKERS` comes from
 *      `pythonTestOwner`'s own array. The rest are honest literals with no
 *      counterpart to wire to: `package.json` (the walk in
 *      `revert-oracle-plan-runs.mjs` inlines the name, and importing it here
 *      would close an import cycle through `revert-oracle.mjs`), `build.rs`,
 *      and `.pyi` (`planRuns` routes on `.py` alone; a `.pyi` is a stub file
 *      no runner executes, listed so a changed stub is not mistaken for an
 *      asset). Adding a runner means editing both places, which is the cost
 *      of a closed list and is stated rather than claimed away.
 *
 *   2. GIT CALLS THE CONTENT BINARY. Supplied by the caller from
 *      `git diff --numstat` (a `-`/`-` row), so it is DERIVED, never
 *      enumerated: a format nobody has heard of yet is inert on the day it
 *      lands, with no list to update. It also covers a pure deletion, since
 *      numstat reports the removed blob the same way.
 *
 *      BUT `-`/`-` DOES NOT MEAN "BINARY". It means "git did not produce a
 *      textual diff", and three different things cause it. Only the first is
 *      evidence about the CONTENT:
 *        - git's own content detection found a NUL byte. The real signal.
 *        - a `.gitattributes` line turned diffing OFF for the path (`-diff`),
 *          or pointed it at a custom driver (`diff=foo`). That is a DECISION
 *          ABOUT DIFFS, and says nothing about the bytes. This repo has such
 *          a line: `.gitattributes` gives every `.ifc` under
 *          `apps/viewer/public/samples/` the attributes
 *          `-filter -diff -merge text` (LFS defense-in-depth). It covers four
 *          committed samples that are plain STEP text and that ~20 tests read
 *          byte-for-byte (`rust/geometry/tests/clash_intersection_real_model.rs`,
 *          `rust/processing/tests/instancing_dont_bake.rs`,
 *          `packages/cli/src/commands/export-usd.test.ts`, and more). Calling
 *          those inert would be the silent miss this whole comment exists to
 *          avoid, so `contentBinaryPaths` asks `git check-attr diff` and keeps
 *          only the paths reporting `unspecified` — i.e. the ones where git
 *          reached its own verdict rather than being told one.
 *        - the blob exceeded `core.bigFileThreshold` (default 512 MiB), which
 *          git also reports as `-`/`-`. That threshold is a LOCAL git config,
 *          so an enormous text file can classify differently on a
 *          contributor's machine than in CI, which runs the default. Not
 *          guarded: nothing in this repo is near 512 MiB, and a guard would
 *          need to re-read every blob's size to say anything. Named here so
 *          the next person reading a surprising `inert` line has the third
 *          cause in front of them.
 *
 * The conjunction is the point, and each half guards a different failure:
 *
 *   - Condition 1 alone (a pure allow-list of source kinds, everything else
 *     inert) is the shape the issue asks about, and on this repo it is a hole:
 *     `Cargo.toml`, `patches/*.patch`, `apps/landing/index.html`, `*.css`,
 *     `scripts/*.sh` and the `.ifc` / `.ids` fixtures that tests read are all
 *     text with real behaviour and none are on any runner's extension list.
 *     Demoting them would turn a visible false positive into a SILENT MISS —
 *     a production change waved through with no test — which is the strictly
 *     worse direction for a gate. Unknown TEXT therefore stays production and
 *     still aborts.
 *
 *   - Condition 2 alone would demote a source file that git happens to call
 *     binary (a minified `.js`, a `.ts` with a stray NUL). Condition 1 vetoes
 *     that: nothing a runner compiles can ever be classified inert, whatever
 *     git says about its bytes. Condition 1 does NOT cover a text FIXTURE with
 *     `-diff` set, which no runner compiles; that is what the `check-attr`
 *     filter in condition 2 is for, and the two are not interchangeable.
 *
 * That is why the allow-list is the safe direction FOR ITS HALF (it can only
 * ever protect a file from being demoted) while a deny-list of asset kinds is
 * not (it can only ever demote). The residual risk is named rather than
 * hidden: a genuinely binary file that a test really does read byte-wise reads
 * as inert. Those live under `__fixtures__/`, `testdata/`, `test-fixtures/`
 * and `tests/` in this repo, all of which `classifyPath` already routes to
 * `test` before inertness is considered.
 *
 * Inertness is a property of the FILE KIND, not of the operation: deleting a
 * `.rs` is still a production change, and `classifyPath` never looks at the
 * diff status.
 */

import { CARGO_MANIFEST } from './revert-oracle-cargo.mjs';
import { PYTHON_PROJECT_MARKERS } from './revert-oracle-python.mjs';

/** Paths whose change can neither be reverted usefully nor observed by a test. */
const IGNORED_PREFIXES = ['.changeset/', '.github/', 'docs/', '.vscode/'];
const IGNORED_EXACT = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'Cargo.lock',
  'CHANGELOG.md',
]);
const IGNORED_SUFFIXES = ['.md', '.mdx', '.txt', '.snap.orig'];

/**
 * Vercel deploy config: read by Vercel's build pipeline, imported by nothing
 * here, so no test can observe it — the same reason `.github/` is ignored.
 * Anchored on the basename on purpose; a blanket `scripts/**` or `*.sh` would
 * swallow `scripts/lib/*.mjs`, which is real tested logic. Both directions are
 * pinned in revert-oracle.test.mjs, which carries the full rationale.
 */
const DEPLOY_CONFIG_RE = /(^|\/)(vercel\.json|\.vercelignore|vercel-[a-z0-9-]*\.sh)$/;

/**
 * What each runner family the oracle can drive compiles, executes or resolves.
 * One entry per family in `detectRunner` / `cargoRunner` / `pythonRunner`; the
 * header above says why this is an allow-list and what it is and is not
 * allowed to decide on its own.
 */
const RUNNER_SOURCE_KINDS = [
  {
    // `vitest run` and `node --test` / `tsx --test` (detectRunner,
    // rootScriptsRunner). A JS/TS runner loads any of these as a module.
    runner: 'vitest / node --test',
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    // `scripts.test` is where detectRunner reads the command from, so a
    // package.json edit can change what runs. A lockfile cannot; it is in
    // IGNORED_EXACT above.
    basenames: ['package.json'],
  },
  {
    // `cargo test -p <crate>` (cargoRunner). `build.rs` is compiled and run by
    // cargo before the crate is; the manifest name comes from the module that
    // walks up looking for it, so the two cannot drift.
    runner: 'cargo test',
    extensions: ['.rs'],
    basenames: [CARGO_MANIFEST, 'build.rs'],
  },
  {
    // `python3 -m pytest` (pythonRunner). The markers are the same array
    // pythonTestOwner walks up looking for.
    runner: 'python3 -m pytest',
    extensions: ['.py', '.pyi'],
    basenames: PYTHON_PROJECT_MARKERS,
  },
];

const JS_TEST_EXTENSIONS = RUNNER_SOURCE_KINDS[0].extensions.map((e) => e.slice(1)).join('|');

/** A file that IS a test: JS/TS `*.test.*`/`*.spec.*`, or Python's `test_*.py` / `*_test.py` (#4050). */
const TEST_FILE_RE = new RegExp(
  `(^|/)(?:[^/]*\\.(?:test|spec)\\.(?:${JS_TEST_EXTENSIONS})|test_[^/]*\\.py|[^/]*_test\\.py)$`,
);
/** Directories whose entire contents are test scaffolding, not production. */
const TEST_DIR_RE = /(^|\/)(__tests__|__snapshots__|__fixtures__|test-fixtures|testdata)(\/|$)/;
/** `tests/` and `test/` as a directory segment (but not `src/test-utils.ts`). */
const TEST_SEGMENT_RE = /(^|\/)tests?(\/)/;

/**
 * Rust puts unit tests INSIDE the production file behind `#[cfg(test)]`. Such a
 * file is production, but reverting it takes its tests with it — the Rust form
 * of the export-removal trap. Callers get a warning, not a reclassification.
 */
export function isRustFile(path) {
  return path.endsWith('.rs');
}

/** Would any runner the oracle can drive compile, execute or resolve this file? */
export function isRunnerSource(path) {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  for (const kind of RUNNER_SOURCE_KINDS) {
    if (kind.extensions.some((e) => basename.endsWith(e))) return true;
    if (kind.basenames.includes(basename)) return true;
  }
  return false;
}

/**
 * @param {string} path
 * @param {{binary?: boolean}} [evidence] what `git diff --numstat` says about
 *   the content: a `-`/`-` row means git could not diff it as text. Defaults to
 *   false so a path-only caller keeps the pre-#4137 answer.
 */
export function classifyPath(path, { binary = false } = {}) {
  if (IGNORED_EXACT.has(path)) return 'ignored';
  for (const p of IGNORED_PREFIXES) if (path.startsWith(p)) return 'ignored';
  for (const s of IGNORED_SUFFIXES) if (path.endsWith(s)) return 'ignored';
  if (DEPLOY_CONFIG_RE.test(path)) return 'ignored';
  if (TEST_FILE_RE.test(path) || /(^|\/)(?:[^/]+_tests|tests)\.rs$/.test(path)) return 'test';
  if (TEST_DIR_RE.test(path)) return 'test';
  if (TEST_SEGMENT_RE.test(path)) return 'test';
  if (binary && !isRunnerSource(path)) return 'inert';
  return 'production';
}

/**
 * @param {Array<{status: string, path: string, binary?: boolean}>} entries from
 *   `git diff --name-status`, optionally carrying the binary flag `parseNumstat`
 *   derives from the same diff.
 */
export function classifyDiff(entries) {
  const production = [];
  const test = [];
  const ignored = [];
  const inert = [];
  const warnings = [];
  for (const { status, path, binary } of entries) {
    const kind = classifyPath(path, { binary: binary === true });
    if (kind === 'production') production.push({ status, path });
    else if (kind === 'test') test.push({ status, path });
    else if (kind === 'inert') inert.push({ status, path });
    else ignored.push({ status, path });
  }
  if (production.some((e) => isRustFile(e.path))) {
    warnings.push(
      'Rust production files are in the revert set. `#[cfg(test)] mod tests` lives ' +
        'inside the file it tests, so a whole-file revert deletes those tests as well ' +
        'as the code — expect INCONCLUSIVE and use --mutation for a surgical revert.',
    );
  }
  return { production, test, ignored, inert, warnings };
}

/** Parse `git diff --name-status -z`-free plain output. Renames carry two paths. */
export function parseNameStatus(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    // R100 old new / C075 old new -> the NEW path is the one on disk.
    const path = parts.length >= 3 ? parts[2] : parts[1];
    if (path) out.push({ status: status[0], path });
  }
  return out;
}

/**
 * Paths git could not diff as text, from `git diff --numstat --no-renames -z`.
 *
 * `--no-renames` because numstat's rename row collapses both paths into one
 * field (`a.png => c.png`, or the `{old => new}` brace form), which would not
 * match the NEW path `parseNameStatus` reports; with renames off the same
 * change is a delete row plus an add row, each carrying a plain path. `-z`
 * because numstat otherwise C-quotes any path with a space or a non-ASCII byte.
 * Records are `<added>\t<deleted>\t<path>` and binary rows carry `-` for both
 * counts, deletions included.
 */
export function parseNumstat(text) {
  const binary = new Set();
  for (const record of text.split('\0')) {
    if (record === '') continue;
    const fields = record.split('\t');
    if (fields.length < 3) continue;
    const path = fields.slice(2).join('\t');
    if (path && fields[0] === '-' && fields[1] === '-') binary.add(path);
  }
  return binary;
}

/**
 * Paths whose `diff` attribute someone SET, from `git check-attr -z --stdin diff`.
 *
 * Records are `<path>\0diff\0<value>\0`. `unspecified` is the only value that
 * means "nobody said anything, so git decided for itself"; `unset` (`-diff`),
 * `set` (`diff`) and a driver name (`diff=lfs`) are all a human decision about
 * how to DIFF the path, never a statement about its bytes.
 */
export function parseDiffAttrOverrides(text) {
  const overridden = new Set();
  const fields = text.split('\0');
  // Three fields per record; a trailing empty element from the final NUL is
  // simply never reached by the stride.
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i] !== '' && fields[i + 2] !== 'unspecified') overridden.add(fields[i]);
  }
  return overridden;
}

/**
 * The binary evidence `classifyPath` may act on: git could not diff the path as
 * text AND that verdict came from git's own content detection, not from a
 * `.gitattributes` line. See condition 2 in the header for why the difference
 * decides whether a real defect gets waved through.
 *
 * @param {string} numstatText   `git diff --numstat --no-renames -z <base> <head>`
 * @param {string} checkAttrText `git check-attr -z --stdin diff` over those paths
 */
export function contentBinaryPaths(numstatText, checkAttrText) {
  const binary = parseNumstat(numstatText);
  for (const path of parseDiffAttrOverrides(checkAttrText)) binary.delete(path);
  return binary;
}
