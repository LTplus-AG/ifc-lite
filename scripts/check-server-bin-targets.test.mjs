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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
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
// eslint-disable-next-line no-template-curly-in-string
const BRACED_SIDECAR_ARG = '"${sidecar}"';
const ASSIGN_LINE = `          asset="${ASSET_EXPR}"`;
const SIDECAR_ASSIGN_LINE = '          sidecar="$asset.sha256"';
const WIN32_ENTRY =
  '          - target: win32-x64\n' +
  '            os: windows-latest\n' +
  '            rust-target: x86_64-pc-windows-msvc\n' +
  '            archive: zip\n';
// The two archive-carrying invocations are the same command at different
// nesting depths; the indentation is what disambiguates them as anchors.
const RELEASE_UPLOAD = '            gh release upload "$RELEASE_TAG" "$sidecar" "$asset" --clobber';
const BACKFILL_UPLOAD = '              gh release upload "$RELEASE_TAG" "$sidecar" "$asset" --clobber';
const SIDECAR_ONLY_UPLOAD = '                gh release upload "$RELEASE_TAG" "$sidecar"';

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
  assertRed(result, /passes "renamed-\$asset" as an asset argument/);
});

// Same weakness class, backfill path: both invocations are bound, not just one.
test('backfill-path upload drifting from the $asset binding is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, BACKFILL_UPLOAD, BACKFILL_UPLOAD.replace('"$asset"', '"$asset.bak"')),
  });
  assertRed(result, /passes "\$asset\.bak" as an asset argument/);
});

// Same class: shell single quotes never expand, so '$asset' would upload a
// file literally named $asset - unquoting must not bless it.
test('single-quoted upload argument is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, RELEASE_UPLOAD, RELEASE_UPLOAD.replace('"$asset"', "'$asset'")),
  });
  assertRed(result, /passes '\$asset' as an asset argument/);
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

// ---- Checksum sidecars (issue: the fail-open branch in
// packages/server-bin/src/checksum.ts was the ONLY branch that ever ran,
// because no workflow published a sidecar). The gate now pins the sidecar
// binding and refuses any upload that ships an archive without one.

test('removing the sidecar= binding is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, `${SIDECAR_ASSIGN_LINE}\n`, ''),
  });
  assertRed(result, /no longer assigns sidecar=/);
});

test('a sidecar binding naming anything but $asset.sha256 is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, SIDECAR_ASSIGN_LINE, SIDECAR_ASSIGN_LINE.replace('.sha256', '.sha512')),
  });
  assertRed(result, /assigns sidecar="\$asset\.sha512" but the install-time verification .* fetches exactly "\$asset\.sha256"/);
});

test('a commented-out sidecar= binding is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, SIDECAR_ASSIGN_LINE, SIDECAR_ASSIGN_LINE.replace('          sidecar=', '          # sidecar=')),
  });
  assertRed(result, /no longer assigns sidecar=/);
});

test('rebinding sidecar after the pinned assignment is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, SIDECAR_ASSIGN_LINE, `${SIDECAR_ASSIGN_LINE}\n          sidecar="$asset.txt"`),
  });
  assertRed(result, /writes the sidecar variable 2 times/);
});

test('release-path upload shipping the archive without its sidecar is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, RELEASE_UPLOAD, RELEASE_UPLOAD.replace(' "$sidecar"', '')),
  });
  assertRed(result, /uploads the archive without its checksum sidecar/);
});

test('backfill-path upload shipping the archive without its sidecar is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, BACKFILL_UPLOAD, BACKFILL_UPLOAD.replace(' "$sidecar"', '')),
  });
  assertRed(result, /uploads the archive without its checksum sidecar/);
});

test('an upload argument that is neither $asset nor $sidecar is red', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, SIDECAR_ONLY_UPLOAD, `${SIDECAR_ONLY_UPLOAD} "extra-file.txt"`),
  });
  assertRed(result, /passes "extra-file\.txt" as an asset argument/);
});

test('an upload argument that braces the sidecar variable is green', () => {
  const result = runChecker({
    workflow: (s) => mutate(s, RELEASE_UPLOAD, RELEASE_UPLOAD.replace('"$sidecar"', BRACED_SIDECAR_ARG)),
  });
  assertGreen(result);
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

// Same class one level down: the comment stripper itself. A lone apostrophe
// in unquoted shell text once opened a quote state that never closed, hiding
// every later `#` on the line - here the hidden comment carries a hostile
// upload invocation, so a stripper regression turns this green case red.
test('an apostrophe in unquoted shell text does not blind the comment stripper', () => {
  const result = runChecker({
    workflow: (s) => mutate(
      s,
      ASSIGN_LINE,
      `${ASSIGN_LINE}\n          echo the tag can't clobber healthy assets # gh release upload "$RELEASE_TAG" "stale-$asset"`,
    ),
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

// ---- --release mode: the expected asset set must include the .sha256
// sidecars exactly when the TAG'S OWN workflow publishes them, so a release
// missing a sidecar fails while historical pre-sidecar releases stay
// verifiable without demanding assets they never claimed to ship. Exercised
// black-box like everything above: a temp git repo carries the tag's inputs,
// the working tree carries the workflow-ref inputs, and a fake `gh` on PATH
// serves a canned asset list - no network, no real release. The shim is a
// POSIX script, so these cases skip on Windows (CI runs them on ubuntu).

const releaseTest = process.platform === 'win32' ? test.skip : test;

const ARCHIVES = [
  'ifc-lite-server-linux-x64.tar.gz',
  'ifc-lite-server-linux-arm64.tar.gz',
  'ifc-lite-server-linux-x64-musl.tar.gz',
  'ifc-lite-server-darwin-x64.tar.gz',
  'ifc-lite-server-darwin-arm64.tar.gz',
  'ifc-lite-server-win32-x64.zip',
];
const SIDECARS = ARCHIVES.map((a) => `${a}.sha256`);

// A tag whose workflow predates sidecar publishing: the real workflow with
// the sidecar binding removed. mutate() asserts the anchor, so if the real
// binding line drifts this simulation fails loudly instead of testing nothing.
const preSidecarWorkflow = (s) => mutate(s, `${SIDECAR_ASSIGN_LINE}\n`, '');

/**
 * Commit (optionally mutated) inputs as tag v9.9.9 in a temp repo, restore
 * the working tree to the real inputs (the workflow ref, exactly as on a
 * real run), and run the checker in --release mode against a fake gh that
 * reports `assets` as the release's asset names.
 */
function runReleaseChecker({ tagMutations = {}, assets }) {
  const dir = mkdtempSync(join(tmpdir(), 'server-bin-gate-rel-'));
  try {
    for (const [key, rel] of Object.entries(INPUTS)) {
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, tagMutations[key] ? tagMutations[key](real[key]) : real[key]);
    }
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
    };
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=gate@test.invalid', '-c', 'user.name=gate', 'commit', '-qm', 'tag inputs');
    git('tag', 'v9.9.9');
    for (const [key, rel] of Object.entries(INPUTS)) {
      writeFileSync(join(dir, rel), real[key]);
    }
    const bin = join(dir, 'fake-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'assets.json'), JSON.stringify({ assets: assets.map((name) => ({ name })) }));
    const shim = join(bin, 'gh');
    writeFileSync(shim, '#!/bin/sh\ncat "$(dirname "$0")/assets.json"\n');
    chmodSync(shim, 0o755);
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir, '--release', 'v9.9.9'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { code: r.status, output: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

releaseTest('release: a sidecar-publishing tag with archives plus sidecars is green', () => {
  const result = runReleaseChecker({ assets: [...ARCHIVES, ...SIDECARS] });
  assertGreen(result);
  assert.match(result.output, /carries all 6 archives and 6 checksum sidecars/);
});

releaseTest('release: a sidecar-publishing tag missing every sidecar is red and names one', () => {
  const result = runReleaseChecker({ assets: ARCHIVES });
  assertRed(result, /missing 6 of 12[\s\S]*ifc-lite-server-win32-x64\.zip\.sha256/);
});

releaseTest('release: a sidecar-publishing tag missing a single sidecar is red and names exactly it', () => {
  const result = runReleaseChecker({
    assets: [...ARCHIVES, ...SIDECARS.filter((s) => !s.startsWith('ifc-lite-server-darwin-arm64'))],
  });
  assertRed(result, /missing 1 of 12[\s\S]*ifc-lite-server-darwin-arm64\.tar\.gz\.sha256/);
  assert.ok(!result.output.includes('ifc-lite-server-linux-x64.tar.gz.sha256'), 'must not name sidecars that exist');
});

releaseTest('release: a pre-sidecar tag with archives only is green, sidecars not demanded', () => {
  const result = runReleaseChecker({ tagMutations: { workflow: preSidecarWorkflow }, assets: ARCHIVES });
  assertGreen(result);
  assert.match(result.output, /tag predates checksum sidecars/);
});

releaseTest('release: a pre-sidecar tag missing an archive is still red', () => {
  const result = runReleaseChecker({
    tagMutations: { workflow: preSidecarWorkflow },
    assets: ARCHIVES.filter((a) => a !== 'ifc-lite-server-win32-x64.zip'),
  });
  assertRed(result, /missing 1 of 6[\s\S]*ifc-lite-server-win32-x64\.zip/);
});
