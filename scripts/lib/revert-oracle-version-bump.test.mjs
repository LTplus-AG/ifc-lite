/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isVersionOnlyManifestDiff } from './revert-oracle-version-bump.mjs';

function offsetText({ offset = 5, reason = 'Existing reason.', latestBreak = offset > 5 ? 'New break.' : undefined, refs = ['#4685'], extra = {} } = {}) {
  const value = {
    $comment: 'Crate major offset policy.',
    majorOffset: offset,
    reason,
  };
  if (latestBreak !== undefined) value.latestBreak = latestBreak;
  value.refs = refs;
  return JSON.stringify({ ...value, ...extra }, null, 2) + '\n';
}

function offsetDiff() {
  return [
    '--- a/rust-major-offset.json',
    '+++ b/rust-major-offset.json',
    '@@ -3 +3,2 @@',
    '-  "majorOffset": 5,',
    '+  "majorOffset": 6,',
    '+  "latestBreak": "New break.",',
    '@@ -6 +6,2 @@',
    '-    "#4685"',
    '+    "#4685",',
    '+    "#4791"',
  ].join('\n');
}

function classifyOffset(before, after, path = 'rust-major-offset.json', diff = offsetDiff()) {
  return isVersionOnlyManifestDiff(path, diff, { beforeText: before, afterText: after });
}

test('npm: a bare version bump is version-only', () => {
  const diff = [
    '--- a/packages/cli/package.json',
    '+++ b/packages/cli/package.json',
    '@@ -3 +3 @@',
    '-  "version": "0.28.0",',
    '+  "version": "0.28.1",',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('packages/cli/package.json', diff), true);
});

test('npm: a script change alongside the version bump is NOT version-only', () => {
  const diff = [
    '--- a/packages/cli/package.json',
    '+++ b/packages/cli/package.json',
    '@@ -3 +3 @@',
    '-  "version": "0.28.0",',
    '+  "version": "0.28.1",',
    '@@ -20 +20 @@',
    '-    "build": "pnpm exec tsc",',
    '+    "build": "pnpm exec tsc --sourcemap",',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('packages/cli/package.json', diff), false);
});

test('npm: a dependency version literal under a non-"version" key is NOT version-only', () => {
  // Not this repo's convention (internal deps use workspace:^), but any file
  // where a dependency happens to pin a literal version must still count.
  const diff = [
    '--- a/apps/server/package.json',
    '+++ b/apps/server/package.json',
    '@@ -10 +10 @@',
    '-    "left-pad": "1.3.0",',
    '+    "left-pad": "1.3.1",',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('apps/server/package.json', diff), false);
});

test('cargo: the bare [workspace.package] version bump is version-only', () => {
  const diff = [
    '--- a/Cargo.toml',
    '+++ b/Cargo.toml',
    '@@ -7 +7 @@',
    '-version = "9.3.0"',
    '+version = "9.4.0"',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('Cargo.toml', diff), true);
});

test('cargo: an internal path-dependency version bump is version-only', () => {
  const diff = [
    '--- a/Cargo.toml',
    '+++ b/Cargo.toml',
    '@@ -14 +14 @@',
    '-ifc-lite-core = { version = "9.3.0", path = "rust/core" }',
    '+ifc-lite-core = { version = "9.4.0", path = "rust/core" }',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('Cargo.toml', diff), true);
});

test('cargo: an EXTERNAL dependency version bump (same {version=..} shape, no path=) is NOT version-only', () => {
  // The exact false-negative this module is written against: axum has no
  // `path =`, so it must never be swept up with the internal crate bumps.
  const diff = [
    '--- a/apps/server/Cargo.toml',
    '+++ b/apps/server/Cargo.toml',
    '@@ -30 +30 @@',
    '-axum = { version = "0.8", features = ["multipart", "tokio"] }',
    '+axum = { version = "0.9", features = ["multipart", "tokio"] }',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('apps/server/Cargo.toml', diff), false);
});

test('cargo: rust-version (MSRV) is not mistaken for the bare version key', () => {
  const diff = [
    '--- a/Cargo.toml',
    '+++ b/Cargo.toml',
    '@@ -8 +8 @@',
    '-rust-version = "1.75"',
    '+rust-version = "1.80"',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('Cargo.toml', diff), false);
});

test('cargo: a features change hiding behind a version bump on the same line is NOT version-only', () => {
  const diff = [
    '--- a/rust/wasm-bindings/Cargo.toml',
    '+++ b/rust/wasm-bindings/Cargo.toml',
    '@@ -45 +45 @@',
    '-ifc-lite-geometry = { version = "9.3.0", path = "../geometry", default-features = false, features = [] }',
    '+ifc-lite-geometry = { version = "9.4.0", path = "../geometry", default-features = false, features = ["extra"] }',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('rust/wasm-bindings/Cargo.toml', diff), false);
});

test('cargo: a wholly new dependency line (add, no matching removal) is NOT version-only', () => {
  const diff = [
    '--- a/Cargo.toml',
    '+++ b/Cargo.toml',
    '@@ -19 +19,2 @@',
    ' ifc-lite-wasm = { version = "9.3.0", path = "rust/wasm-bindings" }',
    '+ifc-lite-new = { version = "9.3.0", path = "rust/new" }',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('Cargo.toml', diff), false);
});

test('cargo: one line replaced by two (mismatched nonzero remove/add counts) is NOT version-only', () => {
  const diff = [
    '--- a/Cargo.toml',
    '+++ b/Cargo.toml',
    '@@ -14 +14,2 @@',
    '-ifc-lite-core = { version = "9.3.0", path = "rust/core" }',
    '+ifc-lite-core = { version = "9.4.0", path = "rust/core" }',
    '+ifc-lite-new = { version = "9.4.0", path = "rust/new" }',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('Cargo.toml', diff), false);
});

test('a non-manifest file is never version-only regardless of content', () => {
  const diff = ['--- a/packages/cli/src/index.ts', '+++ b/packages/cli/src/index.ts', '@@ -1 +1 @@', '-1.0.0', '+1.0.1'].join(
    '\n',
  );
  assert.equal(isVersionOnlyManifestDiff('packages/cli/src/index.ts', diff), false);
});

test('an empty diff (no hunks) is not version-only', () => {
  assert.equal(isVersionOnlyManifestDiff('package.json', ''), false);
});

// Regression coverage for #4790: the release orchestrator's Rust-major offset
// must be recognized without making unrelated production edits revert-exempt.
test('rust offset: the real trailing-comma shape is version-only by decoded structure', () => {
  const before = offsetText();
  const after = offsetText({
    offset: 6,
    latestBreak: 'New measured break.',
    refs: ['#4685', '#4791'],
  });
  assert.equal(classifyOffset(before, after), true);
});

test('rust offset: a subsequent increment replaces latestBreak without rewriting history', () => {
  const before = offsetText({ offset: 6, latestBreak: 'Previous break.', refs: ['#4685', '#4791'] });
  const after = offsetText({ offset: 7, latestBreak: 'Next break.', refs: ['#4685', '#4791', '#4988'] });
  assert.equal(classifyOffset(before, after), true);
});

test('rust offset: complete contents are required even when changed lines look valid', () => {
  assert.equal(isVersionOnlyManifestDiff('rust-major-offset.json', offsetDiff()), false);
});

test('rust offset: malformed or non-canonical JSON is rejected, including duplicate keys', () => {
  const before = offsetText();
  const validAfter = offsetText({ offset: 6, latestBreak: 'New break.', refs: ['#4685', '#4791'] });
  assert.equal(classifyOffset(before, '{'), false);
  assert.equal(classifyOffset(before, validAfter.trim()), false);
  assert.equal(classifyOffset(before, validAfter.replace('  "majorOffset": 6,', '  "majorOffset": 6,\n  "majorOffset": 6,')), false);
});

test('rust offset: only an exact one-step nonnegative safe-integer increment qualifies', () => {
  const before = offsetText();
  for (const offset of [4, 5, 7, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const after = offsetText({ offset, latestBreak: 'New break.', refs: ['#4685', '#4791'] });
    assert.equal(classifyOffset(before, after), false, `offset ${offset}`);
  }
});

test('rust offset: historical reason must remain unchanged', () => {
  const before = offsetText();
  for (const [offset, reason] of [[6, 'Replacement.'], [6, 'Existing'], [6, 'Existing reason. More.'], [5, 'Existing reason.']]) {
    const after = offsetText({ offset, reason, latestBreak: 'New break.', refs: ['#4685', '#4791'] });
    assert.equal(classifyOffset(before, after), false, `${offset}: ${reason}`);
  }
});

test('rust offset: latestBreak is non-empty and changes on subsequent increments', () => {
  const legacyBefore = offsetText();
  for (const latestBreak of ['', '   ']) {
    assert.equal(classifyOffset(legacyBefore, offsetText({ offset: 6, latestBreak, refs: ['#4685', '#4791'] })), false);
  }
  const currentBefore = offsetText({ offset: 6, latestBreak: 'Current break.', refs: ['#4685', '#4791'] });
  assert.equal(classifyOffset(currentBefore, offsetText({ offset: 7, latestBreak: 'Current break.', refs: ['#4685', '#4791', '#4988'] })), false);
});

test('rust offset: existing refs remain an ordered prefix and new refs are issue numbers', () => {
  const before = offsetText({ refs: ['#1', '#2'] });
  for (const refs of [['#1'], ['#2', '#1', '#3'], ['#1', '#9', '#3'], ['#1', '#2'], ['#1', '#2', '4791']]) {
    const after = offsetText({ offset: 6, latestBreak: 'New break.', refs });
    assert.equal(classifyOffset(before, after), false, JSON.stringify(refs));
  }
});

test('rust offset: schema, comment, path, and an empty textual diff fail closed', () => {
  const before = offsetText();
  const fields = { offset: 6, reason: 'Existing reason.', latestBreak: 'New break.', refs: ['#4685', '#4791'] };
  assert.equal(classifyOffset(before, offsetText({ ...fields, extra: { unexpected: true } })), false);
  assert.equal(classifyOffset(before, offsetText(fields).replace('Crate major offset policy.', 'Changed policy.')), false);
  assert.equal(classifyOffset(before, offsetText(fields), 'nested/rust-major-offset.json'), false);
  assert.equal(classifyOffset(before, offsetText(fields), 'rust-major-offset.json', ''), false);
});

test('a non-manifest file whose diff has the bare cargo version-line shape is NOT version-only', () => {
  // Pins the `if (!isNpm && !isCargo) return false;` guard: this line shape
  // (`version = "9.3.0"` -> `version = "9.4.0"`) is exactly what
  // cargoBareVersionOnly() accepts on Cargo.toml, so without the guard a
  // non-manifest file (e.g. a Rust source file that happens to define its
  // own build-time version constant) would fall into the cargo matcher and
  // be wrongly exempted from the revert oracle.
  const diff = [
    '--- a/rust/core/src/build_info.rs',
    '+++ b/rust/core/src/build_info.rs',
    '@@ -12 +12 @@',
    '-version = "9.3.0"',
    '+version = "9.4.0"',
  ].join('\n');
  assert.equal(isVersionOnlyManifestDiff('rust/core/src/build_info.rs', diff), false);
});
