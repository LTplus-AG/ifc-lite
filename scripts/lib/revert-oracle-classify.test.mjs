/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4137: the `inert` bucket, unit level. The end-to-end half — the six verdict
 * cases run against real scratch repos through the CLI — is
 * `revert-oracle-inert.test.mjs`. Both directions are asserted here for every
 * rule, because an instrument that can only say one of its answers has not
 * been exercised.
 *
 * The numstat fixtures are verbatim `git diff --numstat --no-renames -z`
 * output captured from a scratch repo (git 2.51), NUL separators written as
 * `\0`, for the same reason the runner-output fixtures in `revert-oracle.test.mjs`
 * are verbatim: the parser's contract is with git's real format, not with a
 * remembered one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPath,
  classifyDiff,
  isRunnerSource,
  parseNumstat,
  parseDiffAttrOverrides,
  contentBinaryPaths,
} from './revert-oracle-classify.mjs';

// ---------------------------------------------------------------------------
// isRunnerSource — the allow-list half of the rule
// ---------------------------------------------------------------------------

test('isRunnerSource claims exactly what a runner the oracle can drive would load', () => {
  // vitest / node --test
  for (const p of ['packages/core/src/a.ts', 'apps/viewer/src/B.tsx', 'scripts/lib/x.mjs', 'a/b.cjs', 'a/b.mts', 'a/b.cts', 'a/b.js', 'a/b.jsx']) {
    assert.equal(isRunnerSource(p), true, p);
  }
  // cargo
  for (const p of ['rust/core/src/lib.rs', 'rust/core/Cargo.toml', 'rust/core/build.rs']) {
    assert.equal(isRunnerSource(p), true, p);
  }
  // pytest
  for (const p of ['tools/x/canonical.py', 'rust/python/ifclite_geom.pyi', 'tools/x/pyproject.toml', 'tools/x/requirements.lock', 'tools/x/setup.py']) {
    assert.equal(isRunnerSource(p), true, p);
  }
  // `scripts.test` is where detectRunner reads the command from.
  assert.equal(isRunnerSource('packages/core/package.json'), true);

  // Nothing in the runner set compiles, executes or resolves these.
  for (const p of ['apps/landing/assets/logo.png', 'apps/viewer/public/fonts/Inter.woff2', 'a/b.ico', 'a/b.parquet', 'pnpm-lock.yaml']) {
    assert.equal(isRunnerSource(p), false, p);
  }
});

// ---------------------------------------------------------------------------
// classifyPath — the conjunction
// ---------------------------------------------------------------------------

test('#4137: a binary non-runner file is inert; the identical path with text content is production', () => {
  // The ONLY difference between these two calls is what git said about the
  // content, which is the half of the rule that is derived rather than listed.
  assert.equal(classifyPath('apps/landing/assets/logo.png', { binary: true }), 'inert');
  assert.equal(classifyPath('apps/landing/assets/logo.png'), 'production');
});

test('#4137: inertness is about the file KIND, so a runner source file is never inert', () => {
  // Condition 1 vetoes condition 2: a minified bundle, a stray NUL or a
  // `.gitattributes` binary marker must not demote something cargo/vitest/
  // pytest compiles. This is the direction whose miss would be SILENT.
  for (const p of ['rust/geometry/src/kernel.rs', 'packages/core/src/index.ts', 'apps/viewer/src/App.tsx', 'scripts/lib/revert-oracle.mjs', 'tools/x/canonical.py']) {
    assert.equal(classifyPath(p, { binary: true }), 'production', p);
  }
});

test('#4137: an unknown TEXT kind stays production, so the allow-list can never open a silent hole', () => {
  // These are real repo paths with real behaviour that no runner extension
  // list names. A pure allow-list of source kinds would call every one of them
  // inert and wave the change through with no test.
  //
  // `classifyPath` only ever sees the boolean, so calling it here without the
  // flag proves nothing about the `.ifc` samples, which arrive with the flag
  // SET in the real repo (`.gitattributes` `-diff`). The claim that they stay
  // production lives where the flag is computed — `contentBinaryPaths` below,
  // and case 7 in `revert-oracle-inert.test.mjs` end to end.
  for (const p of ['rust/Cargo.toml', 'patches/vite-plugin-top-level-await@1.6.0.patch', 'apps/landing/index.html', 'apps/viewer/src/index.css', 'scripts/build-wasm.sh', 'apps/viewer/public/samples/hello-wall.ifc', 'packages/cli/examples/delivery/walls-must-have-tag.ids']) {
    assert.equal(classifyPath(p), 'production', p);
  }
});

test('#4137: a lockfile is inert (already ignored), a package.json is NOT', () => {
  // A lockfile cannot change what runs; `scripts.test` in a package.json can.
  for (const p of ['pnpm-lock.yaml', 'Cargo.lock', 'package-lock.json', 'yarn.lock']) {
    assert.equal(classifyPath(p), 'ignored', p);
    assert.equal(classifyPath(p, { binary: true }), 'ignored', p);
  }
  assert.equal(classifyPath('packages/core/package.json'), 'production');
  assert.equal(classifyPath('packages/core/package.json', { binary: true }), 'production');
});

test('#4137: a binary that a test claims stays a test, not inert', () => {
  // The test rules run BEFORE inertness, so a committed binary fixture under a
  // test directory keeps the classification it had.
  assert.equal(classifyPath('packages/core/src/__fixtures__/model.bin', { binary: true }), 'test');
  assert.equal(classifyPath('tests/models/tiny.ifc', { binary: true }), 'test');
});

test('#4137: packages/bcf/test-data/*.bcf are real zip fixtures — test, not inert', () => {
  // These are read byte-for-byte by packages/bcf/src/reader.test.ts,
  // schema-validation.test.ts and fabricated-*.test.ts. `test-data` matched
  // neither TEST_DIR_RE (which had testdata, test-fixtures) nor
  // TEST_SEGMENT_RE (needs a literal test/tests segment), so once `inert`
  // existed these dropped out of the oracle's reasoning with no test
  // required — the silent-miss direction the bucket exists to avoid.
  for (const p of [
    'packages/bcf/test-data/AC20-FZK-Haus_BIMcollabZoom.bcf',
    'packages/bcf/test-data/AC20-FZK-Haus_BIMcollabZoom-CommentOnly.bcf',
    'packages/bcf/test-data/OrthogonalCamera.bcf',
    'packages/bcf/test-data/PerspectiveCamera.bcf',
  ]) {
    assert.equal(classifyPath(p, { binary: true }), 'test', p);
  }
});

test('#4137: a genuinely inert binary (an icon) still classifies inert', () => {
  assert.equal(classifyPath('apps/viewer/public/favicon.ico', { binary: true }), 'inert');
});

test('#4137: packages/extensions/src/testing/* stays production, not test', () => {
  // Looks like test data by name, but exports public SDK API
  // (runBundleTests, CANONICAL_FIXTURES) — must not be swallowed by a
  // directory-name rule.
  assert.equal(classifyPath('packages/extensions/src/testing/index.ts'), 'production');
  assert.equal(classifyPath('packages/extensions/src/testing/index.ts', { binary: true }), 'production');
});

// ---------------------------------------------------------------------------
// classifyDiff — the buckets a caller acts on
// ---------------------------------------------------------------------------

test('#4137: a mixed diff keeps the production file in the revert set and only sidelines the asset', () => {
  const { production, test: tests, inert, ignored } = classifyDiff([
    { status: 'M', path: 'rust/geometry/src/walk.rs', binary: false },
    { status: 'A', path: 'rust/geometry/src/walk_tests.rs', binary: false },
    { status: 'D', path: 'apps/landing/assets/old-logo.png', binary: true },
    { status: 'M', path: 'pnpm-lock.yaml', binary: false },
  ]);
  assert.deepEqual(production.map((e) => e.path), ['rust/geometry/src/walk.rs']);
  assert.deepEqual(tests.map((e) => e.path), ['rust/geometry/src/walk_tests.rs']);
  assert.deepEqual(inert.map((e) => e.path), ['apps/landing/assets/old-logo.png']);
  assert.deepEqual(ignored.map((e) => e.path), ['pnpm-lock.yaml']);
});

test('#4137: a deleted SOURCE file is production, a deleted asset is inert', () => {
  const { production, inert } = classifyDiff([
    { status: 'D', path: 'packages/core/src/gone.ts', binary: false },
    { status: 'D', path: 'apps/landing/assets/gone.png', binary: true },
  ]);
  assert.deepEqual(production.map((e) => e.path), ['packages/core/src/gone.ts']);
  assert.deepEqual(inert.map((e) => e.path), ['apps/landing/assets/gone.png']);
});

test('classifyDiff without any binary evidence classifies exactly as it did before #4137', () => {
  const { production, inert } = classifyDiff([
    { status: 'M', path: 'apps/landing/assets/logo.png' },
    { status: 'M', path: 'packages/core/src/a.ts' },
  ]);
  assert.deepEqual(production.map((e) => e.path), ['apps/landing/assets/logo.png', 'packages/core/src/a.ts']);
  assert.deepEqual(inert, []);
});

// ---------------------------------------------------------------------------
// parseNumstat — where the binary evidence comes from
// ---------------------------------------------------------------------------

test('parseNumstat reads git\'s own binary marker, in both directions', () => {
  // Verbatim `git diff --numstat --no-renames -z` over a modified text file, a
  // deleted PNG and an added PNG.
  const captured = '-\t-\ta.png\0' + '1\t0\tb.txt\0' + '-\t-\tc.png\0';
  const binary = parseNumstat(captured);
  assert.equal(binary.has('a.png'), true, 'a deleted binary is still reported as binary');
  assert.equal(binary.has('c.png'), true);
  assert.equal(binary.has('b.txt'), false, 'a counted text row is not binary');
  assert.equal(binary.size, 2);
});

test('parseNumstat keeps a path containing a tab, and tolerates an empty diff', () => {
  // -z means git does not quote, so a tab inside a filename arrives raw and
  // the path is everything after the second field.
  assert.equal(parseNumstat('-\t-\tweird\tname.png\0').has('weird\tname.png'), true);
  assert.equal(parseNumstat('').size, 0);
  assert.equal(parseNumstat('\0').size, 0);
});

// ---------------------------------------------------------------------------
// contentBinaryPaths — `-`/`-` is not the same claim as "binary"
// ---------------------------------------------------------------------------

test('parseDiffAttrOverrides keeps only git\'s OWN verdict, in all four attribute states', () => {
  // Verbatim `git check-attr -z --stdin diff` (git 2.51) over four paths.
  const captured =
    'apps/viewer/public/samples/hello-wall.ifc\0diff\0unset\0' +
    'apps/landing/assets/logo.png\0diff\0unspecified\0' +
    'a/forced-text.bin\0diff\0set\0' +
    'a/custom.bin\0diff\0lfs\0';
  const overridden = parseDiffAttrOverrides(captured);
  assert.equal(overridden.has('apps/viewer/public/samples/hello-wall.ifc'), true, '-diff is a decision, not evidence');
  assert.equal(overridden.has('a/forced-text.bin'), true, 'diff is a decision too');
  assert.equal(overridden.has('a/custom.bin'), true, 'a driver name is a decision too');
  assert.equal(overridden.has('apps/landing/assets/logo.png'), false, 'unspecified IS git deciding for itself');
  assert.equal(overridden.size, 3);
});

test('#4137: a `-diff` TEXT sample is not content-binary, while a real PNG in the same diff still is', () => {
  // The exact shape this repo ships: `.gitattributes` turns diffing off for
  // `apps/viewer/public/samples/**` `.ifc`, so numstat reports `-`/`-` for a
  // plain STEP file that ~20 tests read byte-for-byte
  // (rust/geometry/tests/clash_intersection_real_model.rs,
  // rust/processing/tests/instancing_dont_bake.rs,
  // packages/cli/src/commands/export-usd.test.ts, and more). Reading numstat
  // alone classifies it inert and waves the change through — the silent miss.
  const numstat =
    '-\t-\tapps/viewer/public/samples/hello-wall.ifc\0' +
    '-\t-\tapps/landing/assets/logo.png\0' +
    '3\t1\tpackages/core/src/index.ts\0';
  const checkAttr =
    'apps/viewer/public/samples/hello-wall.ifc\0diff\0unset\0' +
    'apps/landing/assets/logo.png\0diff\0unspecified\0';

  const binary = contentBinaryPaths(numstat, checkAttr);
  assert.equal(binary.has('apps/viewer/public/samples/hello-wall.ifc'), false);
  assert.equal(binary.has('apps/landing/assets/logo.png'), true);
  assert.equal(binary.size, 1);

  // And that is what decides the bucket the author is judged on.
  const { production, inert } = classifyDiff([
    { status: 'M', path: 'apps/viewer/public/samples/hello-wall.ifc', binary: binary.has('apps/viewer/public/samples/hello-wall.ifc') },
    { status: 'M', path: 'apps/landing/assets/logo.png', binary: binary.has('apps/landing/assets/logo.png') },
  ]);
  assert.deepEqual(production.map((e) => e.path), ['apps/viewer/public/samples/hello-wall.ifc']);
  assert.deepEqual(inert.map((e) => e.path), ['apps/landing/assets/logo.png']);
});

test('contentBinaryPaths with no attributes set behaves exactly like parseNumstat', () => {
  const numstat = '-\t-\ta.png\0' + '1\t0\tb.txt\0';
  const checkAttr = 'a.png\0diff\0unspecified\0';
  assert.deepEqual([...contentBinaryPaths(numstat, checkAttr)], ['a.png']);
  // The caller skips the check-attr spawn when nothing is undiffable.
  assert.deepEqual([...contentBinaryPaths('1\t0\tb.txt\0', '')], []);
});
