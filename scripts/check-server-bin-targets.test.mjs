#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-server-bin-targets.mjs, the server-bin
 * platform parity gate. Hand-testing is what let four false greens through in
 * PR #2642 (its regression table exercised deletion, never commenting-out),
 * so every hostile mutation the adversarial review demonstrated lives here as
 * an executable case, alongside the gate's original deliberate regressions.
 *
 * Method: each case writes a mutated copy of the REAL inputs (platform.ts,
 * package.json, server-binaries.yml) to a temp dir outside the repo, runs the
 * UNMODIFIED checker against it via its --root flag, and asserts the exit
 * code plus the message. The checker is exercised as a black box - nothing
 * here reads the checker's source, and every mutation anchor is asserted to
 * exist in the real input first, so a drifted anchor fails the suite instead
 * of silently testing nothing.
 *
 * Run: node --test scripts/check-server-bin-targets.test.mjs
 * (wired as a step of the CI node-test job in .github/workflows/test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-server-bin-targets.mjs');

const INPUTS = {
  platform: 'packages/server-bin/src/platform.ts',
  pkg: 'packages/server-bin/package.json',
  workflow: '.github/workflows/server-binaries.yml',
};
const real = Object.fromEntries(
  Object.entries(INPUTS).map(([key, rel]) => [key, readFileSync(join(ROOT, rel), 'utf8')]),
);

// GitHub Actions expressions used as literal mutation anchors, not JS templates.
// eslint-disable-next-line no-template-curly-in-string
const ASSET_EXPR = 'ifc-lite-server-${{ matrix.target }}.${{ matrix.archive }}';
// eslint-disable-next-line no-template-curly-in-string
const BRACED_ASSET_ARG = '"${asset}"';
const ASSIGN_LINE = `          asset="${ASSET_EXPR}"`;
const WIN32_ENTRY =
  '          - target: win32-x64\n' +
  '            os: windows-latest\n' +
  '            rust-target: x86_64-pc-windows-msvc\n' +
  '            archive: zip\n';
const RELEASE_UPLOAD = 'gh release upload "$RELEASE_TAG" "$asset" --clobber';
const BACKFILL_UPLOAD = '            else\n              gh release upload "$RELEASE_TAG" "$asset"\n';

/** Replace `from` with `to`, failing loudly if the anchor is not present. */
function mutate(source, from, to) {
  assert.ok(source.includes(from), `mutation anchor not found in real input: ${JSON.stringify(from)}`);
  const out = source.replace(from, to);
  assert.notEqual(out, source, 'mutation did not change the input');
  return out;
}

/**
 * Write the (optionally mutated) real inputs to a fresh temp tree outside the
 * repo and run the checker against it. Returns { code, output }.
 */
function runChecker(mutations = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'server-bin-gate-'));
  try {
    for (const [key, rel] of Object.entries(INPUTS)) {
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, mutations[key] ? mutations[key](real[key]) : real[key]);
    }
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
    return { code: r.status, output: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertGreen({ code, output }) {
  assert.equal(code, 0, `expected a pass, got exit ${code}: ${output}`);
  assert.match(output, /OK - 6 targets/, 'a pass must state the target count, not merely exit 0');
}

function assertRed({ code, output }, messagePattern) {
  assert.equal(code, 1, `expected a failure, got exit ${code}: ${output}`);
  assert.match(output, messagePattern, `failure message must name the actual defect: ${output}`);
}

// Positive control: the harness itself must be able to pass, or every red
// assertion below could be an artifact of a broken temp-tree setup.
test('unmutated real inputs pass', () => {
  assertGreen(runChecker());
});

// ---- The four false greens from the PR #2642 adversarial review. Each was
// exit 0 before the fix; each must now be red and name the right thing.

test('false green 1: commenting out the whole win32-x64 matrix entry is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, WIN32_ENTRY, WIN32_ENTRY.replace(/^( *)(.)/gm, '$1# $2')),
  });
  assertRed(result, /release-server-binaries matrix disagrees with SUPPORTED_TARGETS \(missing: win32-x64\)/);
});

test('false green 2: commenting out win32-x64 inside SUPPORTED_TARGETS is red', () => {
  const result = runChecker({
    platform: (s) => mutate(s, "  'win32-x64',", "  // 'win32-x64',"),
  });
  assertRed(result, /"os" disagrees with SUPPORTED_TARGETS \(unexpected: win32\)/);
});

test('false green 3: renamed upload asset with the old literal in a comment is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(
      s,
      ASSIGN_LINE,
      `          # was: ${ASSET_EXPR}\n${ASSIGN_LINE.replace('ifc-lite-server-', 'server-bin-')}`,
    ),
  });
  assertRed(result, /assigns asset="server-bin-.*but the resolver in .*platform\.ts downloads exactly/);
});

test('false green 4: uploading a different name than the $asset binding is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, RELEASE_UPLOAD, RELEASE_UPLOAD.replace('"$asset"', '"renamed-$asset"')),
  });
  assertRed(result, /passes "renamed-\$asset" as its asset argument instead of "\$asset"/);
});

// Same weakness class, backfill path: both invocations are bound, not just one.
test('backfill-path upload drifting from the $asset binding is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, BACKFILL_UPLOAD, BACKFILL_UPLOAD.replace('"$asset"', '"$asset.bak"')),
  });
  assertRed(result, /passes "\$asset\.bak" as its asset argument instead of "\$asset"/);
});

// Same class: shell single quotes never expand, so '$asset' would upload a
// file literally named $asset - unquoting must not bless it.
test('single-quoted upload argument is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, RELEASE_UPLOAD, RELEASE_UPLOAD.replace('"$asset"', "'$asset'")),
  });
  assertRed(result, /passes '\$asset' as its asset argument/);
});

// Same class: a correct first assignment followed by a rebinding would upload
// a different name while the pinned literal is still present and exact.
test('rebinding asset after the pinned assignment is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, ASSIGN_LINE, `${ASSIGN_LINE}\n          asset="$asset.bak"`),
  });
  assertRed(result, /writes the asset variable 2 times/);
});

// Same class: a commented-out assignment with live uploads has no binding at all.
test('commented-out asset= assignment is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, ASSIGN_LINE, ASSIGN_LINE.replace('          asset=', '          # asset=')),
  });
  assertRed(result, /no longer assigns asset=/);
});

// ---- The three false reds from the review: legitimate states that were
// rejected, or rejected while pointing the operator at the wrong file.

test('false red 5: a TODO comment inside the Set is green', () => {
  const result = runChecker({
    platform: (s) => mutate(s, "  'win32-x64',", "  'win32-x64',\n  // TODO: 'win32-arm64' once runners exist"),
  });
  assertGreen(result);
});

test('false red 6: a matrix entry whose target: is not the first key is green', () => {
  const result = runChecker({
    workflow: (s) => mutate(
      s,
      '          - target: win32-x64\n            os: windows-latest\n',
      '          - os: windows-latest\n            target: win32-x64\n',
    ),
  });
  assertGreen(result);
});

test('false red 7: a quoted target scalar is green', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, '- target: win32-x64', "- target: 'win32-x64'"),
  });
  assertGreen(result);
});

// More members of the same classes, kept green on purpose.
test('a trailing YAML comment after a matrix value is green', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, '- target: win32-x64', '- target: win32-x64  # the one zip target'),
  });
  assertGreen(result);
});

test('a block comment inside the Set is green', () => {
  const result = runChecker({
    platform: (s) => mutate(s, "  'win32-x64',", "  'win32-x64', /* the one zip target */"),
  });
  assertGreen(result);
});

test('an upload argument that braces the asset variable is green', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, RELEASE_UPLOAD, RELEASE_UPLOAD.replace('"$asset"', BRACED_ASSET_ARG)),
  });
  assertGreen(result);
});

// ---- The gate's original eight deliberate regressions, re-confirmed so the
// rewrite cannot have traded old coverage for new.

test('regression: wrong rust-target on a matrix entry is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, 'rust-target: x86_64-pc-windows-msvc', 'rust-target: aarch64-pc-windows-msvc'),
  });
  assertRed(result, /builds rust-target "aarch64-pc-windows-msvc" but the install target requires "x86_64-pc-windows-msvc"/);
});

test('regression: an unmapped platform cannot enter the set silently', () => {
  const result = runChecker({
    platform: (s) => mutate(s, "  'win32-x64',", "  'win32-x64',\n  'freebsd-x64',"),
    pkg: (s) => mutate(s, '"win32"\n', '"win32",\n    "freebsd"\n'),
    workflow: (s) => mutate(s, WIN32_ENTRY, `${WIN32_ENTRY}          - target: freebsd-x64\n            os: ubuntu-latest\n            rust-target: x86_64-unknown-freebsd\n            archive: tar.gz\n`),
  });
  assertRed(result, /no rust-triple mapping for platform "freebsd"/);
});

test('regression: a matrix entry without rust-target is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, WIN32_ENTRY, WIN32_ENTRY.replace('            rust-target: x86_64-pc-windows-msvc\n', '')),
  });
  assertRed(result, /matrix entry "win32-x64" .* has no rust-target: key/);
});

test('regression: an altered upload asset expression is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, ASSIGN_LINE, ASSIGN_LINE.replace('ifc-lite-server-', 'ifc-lite-srv-')),
  });
  assertRed(result, /assigns asset="ifc-lite-srv-.*the two must be identical/);
});

test('regression: deleting win32-x64 from the matrix is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, WIN32_ENTRY, ''),
  });
  assertRed(result, /release-server-binaries matrix disagrees with SUPPORTED_TARGETS \(missing: win32-x64\)/);
});

test('regression: adding win32-arm64 to SUPPORTED_TARGETS alone is red', () => {
  const result = runChecker({
    platform: (s) => mutate(s, "  'win32-x64',", "  'win32-x64',\n  'win32-arm64',"),
  });
  assertRed(result, /matrix disagrees with SUPPORTED_TARGETS \(missing: win32-arm64\)/);
});

test('regression: removing win32 from package.json os is red', () => {
  const result = runChecker({
    pkg: (s) => mutate(s, ',\n    "win32"\n', '\n'),
  });
  assertRed(result, /"os" disagrees with SUPPORTED_TARGETS \(missing: win32\)/);
});

test('regression: renaming SUPPORTED_TARGETS fails closed', () => {
  const result = runChecker({
    platform: (s) => mutate(s, 'const SUPPORTED_TARGETS = new Set([', 'const SUPPORTED_TRIPLES = new Set(['),
  });
  assertRed(result, /cannot find the "const SUPPORTED_TARGETS = new Set\(\[\.\.\.\]\)" list .* update this check/);
});
