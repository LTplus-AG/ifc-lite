/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isVersionOnlyManifestDiff } from './revert-oracle-version-bump.mjs';

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
