/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Unit tests for the Rust major-offset arithmetic and its readers.
 *
 * The gate's own end-to-end behaviour over synthetic trees lives in
 * scripts/check-rust-major-offset.test.mjs; this file covers the pieces both
 * that gate and `scripts/sync-versions.js` compute FROM, which is the pair
 * that must never disagree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMajorOffset,
  getWorkspacePackagePaths,
  computeReleaseVersions,
  MIN_WORKSPACE_PACKAGES,
  parseSemver,
  readMajorOffset,
  scanWorkspaceVersions,
  WORKSPACE_VERSION_PATTERN,
} from './rust-major-offset.mjs';

/** A tree with `count` public workspace packages, the highest at `maxVersion`. */
function makeTree(t, { offsetFile, maxVersion = '6.0.1', count = MIN_WORKSPACE_PACKAGES + 2, rootVersion } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rust-major-offset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', version: rootVersion ?? maxVersion }));
  mkdirSync(join(root, 'packages'));
  for (let i = 0; i < count; i++) {
    const dir = join(root, 'packages', `p${i}`);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: `@ifc-lite/p${i}`, version: i === 0 ? maxVersion : '0.1.0' })
    );
  }
  if (offsetFile !== undefined) {
    writeFileSync(join(root, 'rust-major-offset.json'), offsetFile);
  }
  return root;
}

const VALID_OFFSET_1 = JSON.stringify({
  majorOffset: 1,
  reason: 'ifc-lite-processing MeshData gained a public field (#3210), which is a breaking Rust change under an npm minor.',
  refs: ['#3210', '#3216'],
});

test('applyMajorOffset shifts only the major, leaving minor and patch on npm', () => {
  assert.equal(applyMajorOffset('6.1.0', 1), '7.1.0');
  assert.equal(applyMajorOffset('6.0.1', 0), '6.0.1');
  assert.equal(applyMajorOffset('6.0.1', 2), '8.0.1');
});

test('applyMajorOffset refuses a version it cannot parse rather than producing NaN', () => {
  assert.throws(() => applyMajorOffset('6.1', 1), (err) => err.code === 'BAD_VERSION');
  assert.throws(() => applyMajorOffset('', 1), (err) => err.code === 'BAD_VERSION');
  assert.throws(() => applyMajorOffset('6.0.1-rc.1', 1), (err) => err.code === 'BAD_VERSION');
});

test('parseSemver accepts a plain triple and nothing else', () => {
  assert.deepEqual(parseSemver('10.20.30'), { major: 10, minor: 20, patch: 30 });
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('v1.2.3'), null);
  assert.equal(parseSemver(undefined), null);
});

test('readMajorOffset fails closed when the file is absent', (t) => {
  const root = makeTree(t, {});
  assert.throws(() => readMajorOffset(root), (err) => err.code === 'NO_OFFSET_FILE');
});

test('readMajorOffset fails closed on an empty or unparseable file', (t) => {
  assert.throws(() => readMajorOffset(makeTree(t, { offsetFile: '' })), (err) => err.code === 'BAD_JSON');
  assert.throws(() => readMajorOffset(makeTree(t, { offsetFile: '{oops' })), (err) => err.code === 'BAD_JSON');
});

test('readMajorOffset rejects an offset that is not a non-negative integer', (t) => {
  for (const bad of [{}, { majorOffset: '1' }, { majorOffset: -1 }, { majorOffset: 1.5 }, { majorOffset: null }]) {
    assert.throws(
      () => readMajorOffset(makeTree(t, { offsetFile: JSON.stringify(bad) })),
      (err) => err.code === 'BAD_OFFSET',
      `expected BAD_OFFSET for ${JSON.stringify(bad)}`
    );
  }
});

test('a non-zero offset must carry a reason and at least one ref', (t) => {
  assert.throws(
    () => readMajorOffset(makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 1, refs: ['#1'] }) })),
    (err) => err.code === 'NO_REASON'
  );
  assert.throws(
    () => readMajorOffset(makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 1, reason: 'x', refs: ['#1'] }) })),
    (err) => err.code === 'NO_REASON'
  );
  assert.throws(
    () =>
      readMajorOffset(
        makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 1, reason: 'a'.repeat(40), refs: [] }) })
      ),
    (err) => err.code === 'NO_REFS'
  );
});

test('offset 0 needs no reason — there is nothing to justify', (t) => {
  const root = makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 0 }) });
  assert.equal(readMajorOffset(root).majorOffset, 0);
});

test('scanWorkspaceVersions refuses a scan that found (almost) nothing', (t) => {
  const root = makeTree(t, { offsetFile: VALID_OFFSET_1, count: 1 });
  assert.throws(() => scanWorkspaceVersions(root), (err) => err.code === 'PACKAGE_FLOOR');
});

test('computeReleaseVersions keeps npm on its own version and lifts only the crates', (t) => {
  const root = makeTree(t, { offsetFile: VALID_OFFSET_1, maxVersion: '6.1.0' });
  const got = computeReleaseVersions(root);
  assert.equal(got.npmVersion, '6.1.0');
  assert.equal(got.crateVersion, '7.1.0');
  assert.equal(got.majorOffset, 1);
  assert.ok(got.scanned >= MIN_WORKSPACE_PACKAGES);
});

test('computeReleaseVersions still takes the highest version, root package included', (t) => {
  const root = makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 0 }), maxVersion: '6.0.1', rootVersion: '9.9.9' });
  assert.equal(computeReleaseVersions(root).npmVersion, '9.9.9');
  assert.equal(computeReleaseVersions(root).crateVersion, '9.9.9');
});

test('a private package cannot drag the release version up', (t) => {
  const root = makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 0 }) });
  const dir = join(root, 'packages', 'secret');
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'secret', private: true, version: '99.0.0' }));
  assert.equal(computeReleaseVersions(root).npmVersion, '6.0.1');
});

/**
 * `rust-version` contains the substring `version`, so a `[workspace.package]`
 * that declares an MSRV — the ordinary thing to do — offers the pattern two
 * candidate keys. Every ordering is pinned here because the failure is silent:
 * `sync-versions.js` writes through this same pattern, so reading the MSRV
 * means WRITING the release version into the MSRV field and publishing the
 * crates at the stale one. Same shape as `.includes('METRE')` swallowing
 * `MILLIMETRE` (#3274).
 */
function workspacePackage(...lines) {
  return `[workspace]\nmembers = ["rust/core"]\n\n[workspace.package]\n${lines.join('\n')}\n\n[workspace.dependencies]\nifc-lite-core = { version = "6.0.1", path = "rust/core" }\n`;
}

function readWorkspaceVersion(text) {
  const m = WORKSPACE_VERSION_PATTERN.exec(text);
  return m ? m[2] : null;
}

test('the workspace version is read past a rust-version MSRV in either order', () => {
  assert.equal(readWorkspaceVersion(workspacePackage('version = "6.0.1"', 'rust-version = "1.80"')), '6.0.1');
  assert.equal(readWorkspaceVersion(workspacePackage('rust-version = "1.80"', 'version = "6.0.1"')), '6.0.1');
  assert.equal(readWorkspaceVersion(workspacePackage('version = "6.0.1"', 'edition = "2021"')), '6.0.1');
});

test('a rust-version with no version at all is no match, so NO_WORKSPACE_VERSION fires', () => {
  assert.equal(readWorkspaceVersion(workspacePackage('rust-version = "1.80"', 'edition = "2021"')), null);
});

test('the workspace version is not sought outside its own section', () => {
  const text = '[workspace.package]\nrust-version = "1.80"\n\n[package]\nversion = "9.9.9"\n';
  assert.equal(readWorkspaceVersion(text), null);
});

/**
 * TOML permits array values in `[workspace.package]` — `authors`, `keywords`,
 * `categories`, `exclude`. A section bound that rejects the `[` CHARACTER
 * rather than a table HEADER stops at the first such array, so a manifest that
 * declares its arrays before `version` reads as having no version at all. The
 * real root manifest happens to put `version` first, which is why nothing has
 * shipped wrong; nothing enforces that ordering, and both halves fail silently
 * when it changes — the gate reports NO_WORKSPACE_VERSION for a manifest that
 * does declare a version, and `sync-versions.js` performs a no-op `replace`
 * and still logs success. Ordering is pinned here for that reason.
 */
test('the workspace version is read past an array value in either order', () => {
  assert.equal(readWorkspaceVersion(workspacePackage('version = "6.0.1"', 'authors = ["IFC-Lite Contributors"]')), '6.0.1');
  assert.equal(readWorkspaceVersion(workspacePackage('authors = ["IFC-Lite Contributors"]', 'version = "6.0.1"')), '6.0.1');
  assert.equal(
    readWorkspaceVersion(workspacePackage('keywords = ["ifc", "bim"]', 'categories = ["parser-implementations"]', 'version = "6.0.1"')),
    '6.0.1'
  );
});

test('an array value does not let the search escape the section', () => {
  const text = '[workspace.package]\nauthors = ["a"]\nrust-version = "1.80"\n\n[package]\nversion = "9.9.9"\n';
  assert.equal(readWorkspaceVersion(text), null);
});

test('an indented version key is still the workspace version', () => {
  assert.equal(readWorkspaceVersion('[workspace.package]\n  version = "6.0.1"\n  rust-version = "1.80"\n'), '6.0.1');
});

test('sync-versions rewrites the version key and leaves rust-version alone', () => {
  const before = workspacePackage('version = "6.0.1"', 'rust-version = "1.80"');
  const after = before.replace(WORKSPACE_VERSION_PATTERN, '$17.0.0$3');
  assert.match(after, /^version = "7\.0\.0"$/m);
  assert.match(after, /^rust-version = "1\.80"$/m);
});

/**
 * The writer half's hazard, pinned directly: `replace` on a non-matching
 * pattern returns the input, so `sync-versions.js` used to write the same
 * bytes back and log `✅ Updated Cargo.toml workspace version`. That is why
 * the script now refuses on this same condition instead of trusting the
 * replace — a silent no-op here publishes the crates at the stale version.
 */
test('a non-matching manifest makes the sync-versions replace a silent no-op', () => {
  const before = workspacePackage('rust-version = "1.80"', 'edition = "2021"');
  assert.equal(readWorkspaceVersion(before), null);
  assert.equal(before.replace(WORKSPACE_VERSION_PATTERN, '$17.0.0$3'), before);
});

test('the real root Cargo.toml still yields its workspace version', () => {
  const cargo = readFileSync(join(import.meta.dirname, '..', '..', 'Cargo.toml'), 'utf8');
  assert.match(readWorkspaceVersion(cargo) ?? '', /^\d+\.\d+\.\d+$/);
});

test('a `.DS_Store` dotfile does not emit a version-scan warning, and does not shrink the scan (PR 3350)', (t) => {
  const root = makeTree(t, {});
  // The warning below `getWorkspacePackagePaths` is load-bearing: a directory
  // that fails to be read shrinks the scan, and a shrunken scan syncs the
  // release to a version LOWER than what was published. A macOS Finder
  // artefact must not produce an alarm indistinguishable from that.
  writeFileSync(join(root, 'packages', '.DS_Store'), '\0\0\0');

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let paths;
  try {
    paths = getWorkspacePackagePaths(root);
  } finally {
    console.warn = realWarn;
  }

  assert.deepEqual(warnings, [], `a dotfile must not warn, got: ${warnings.join(' | ')}`);
  assert.ok(
    paths.length >= MIN_WORKSPACE_PACKAGES,
    `the scan must not shrink: ${paths.length} manifests found`,
  );
  assert.ok(
    !paths.some((p) => p.includes('.DS_Store')),
    'the dotfile must not be scanned as a package',
  );
});

test('skipping dotfiles does not silence a REAL unreadable candidate (PR 3350)', (t) => {
  const root = makeTree(t, {});
  // Both in one tree, so this pins that exactly one is ignored and the other
  // still warns. Widening the skip, or swallowing the stat error, would satisfy
  // the test above while destroying the alarm the release path depends on.
  writeFileSync(join(root, 'packages', '.DS_Store'), '\0\0\0');
  writeFileSync(join(root, 'packages', 'not-a-dir'), 'a file where a package directory belongs');

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    getWorkspacePackagePaths(root);
  } finally {
    console.warn = realWarn;
  }

  assert.equal(warnings.length, 1, `expected exactly one warning, got: ${warnings.join(' | ')}`);
  assert.match(warnings[0], /not-a-dir/);
  assert.doesNotMatch(warnings[0], /DS_Store/, 'the dotfile must not be what warned');
});
