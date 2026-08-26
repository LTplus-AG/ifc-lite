#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Syncs the root release version to the highest workspace version found.
 * Run this after `changeset version` so the root package.json, Cargo
 * workspace version, and internal Rust workspace dependency versions track
 * the highest released workspace package.
 *
 * This does not rewrite individual workspace package versions. Changesets
 * owns those versions directly so packages can version independently.
 *
 * TWO VERSIONS, NOT ONE (#3216). The npm side — the root `package.json` and
 * the `v*` release tag — keeps the version changesets chose. The Rust side
 * gets that version with `rust-major-offset.json`'s `majorOffset` added to its
 * major, which is the only way this repo can express a break that is a major
 * in Rust and a minor or a patch in TypeScript. At `majorOffset` 0 the two are
 * the same string and this script writes exactly what it always wrote.
 * `scripts/check-rust-major-offset.mjs` fails CI when the manifests and that
 * file disagree; both read the version through the same library, so the
 * writer and the checker cannot drift.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  computeReleaseVersions,
  rewriteInternalDeps,
  OFFSET_FILE_NAME,
  RUST_MEMBER_DIRS,
  WORKSPACE_VERSION_PATTERN,
} from './lib/rust-major-offset.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// `--root <dir>` retargets every read and write, like the `--root` flag on the
// gate scripts. It exists so `scripts/sync-versions.test.mjs` can run this
// unmodified file over a synthetic tree — the alternative is asserting what
// this script "would" write, which is how a writer and its checker end up
// agreeing on paper and disagreeing in the release.
const rootArgIndex = process.argv.indexOf('--root');
if (rootArgIndex !== -1 && !process.argv[rootArgIndex + 1]) {
  console.error('❌ --root needs a directory');
  process.exit(2);
}
const rootDir = rootArgIndex === -1 ? join(__dirname, '..') : process.argv[rootArgIndex + 1];

/**
 * Rewrite the workspace members' own `version` entries in Cargo.lock.
 *
 * Bumping the manifests without this leaves the lock recording the previous
 * version for every member, and from then on `cargo` refuses any command
 * carrying `--locked` ("cannot update the lock file ... because --locked was
 * passed"), while every local build silently rewrites Cargo.lock and shows it
 * as dirty. Cargo would fix it in one resolve, but this script has to run
 * where a toolchain and the registry index may not be available, so the edit
 * is textual and offline.
 *
 * Only entries with no `source` field are touched: in a lock file that is
 * exactly the set of path/workspace members. Registry crates always carry a
 * `source`, so a third-party crate that happened to share a name cannot be
 * caught by this. A member is skipped unless its manifest actually inherits
 * `version.workspace = true`: one pinning its own version means to hold it.
 */
function syncCargoLock(version) {
  const cargoLockPath = join(rootDir, 'Cargo.lock');
  let lock;
  try {
    lock = readFileSync(cargoLockPath, 'utf8');
  } catch {
    console.log('ℹ️  No Cargo.lock to sync');
    return;
  }

  const rootToml = readFileSync(join(rootDir, 'Cargo.toml'), 'utf8');
  const membersMatch = rootToml.match(/^members\s*=\s*\[([^\]]*)\]/m);
  if (!membersMatch) {
    console.log('ℹ️  No [workspace] members found; leaving Cargo.lock alone');
    return;
  }
  const memberDirs = [...membersMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const inheritingCrates = new Set();
  for (const dir of memberDirs) {
    let memberToml;
    try {
      memberToml = readFileSync(join(rootDir, dir, 'Cargo.toml'), 'utf8');
    } catch (error) {
      // Say so rather than skipping quietly: a member we cannot read is a
      // member whose lock entry we then leave on the old version, which is the
      // exact drift this function exists to prevent. CI's `cargo metadata
      // --locked` gate would fail afterwards, but on the lock rather than on
      // the cause, so name the cause here.
      console.warn(`⚠️  Could not read ${dir}/Cargo.toml; its Cargo.lock version is left alone (${error.message})`);
      continue;
    }
    // `version.workspace = true` or `version = { workspace = true }`
    if (!/^\s*version(\.workspace\s*=\s*true|\s*=\s*\{\s*workspace\s*=\s*true\s*\})/m.test(memberToml)) {
      continue;
    }
    const name = memberToml.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (name) inheritingCrates.add(name[1]);
  }

  const updated = [];
  // Split on the block delimiter and rebuild, so a rewrite stays inside the
  // block it belongs to instead of running past it.
  const parts = lock.split('[[package]]');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    if (/^\s*source\s*=/m.test(block)) continue;
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (!name || !inheritingCrates.has(name[1])) continue;
    const rewritten = block.replace(/^(\s*version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
    if (rewritten !== block) {
      parts[i] = rewritten;
      updated.push(name[1]);
    }
  }

  if (updated.length === 0) {
    console.log('✅ Cargo.lock member versions already in sync');
    return;
  }
  writeFileSync(cargoLockPath, parts.join('[[package]]'));
  console.log(`✅ Updated Cargo.lock member versions to ${version} (${updated.join(', ')})`);
}

function syncVersions() {
  // The npm version (highest workspace package, root package.json included)
  // and the crate version it maps to under the declared major offset. This
  // throws — rather than inventing a version — when the package scan comes
  // back below its floor, when the offset file is missing or malformed, or
  // when a version is not a plain `major.minor.patch`. See
  // scripts/lib/rust-major-offset.mjs.
  const { npmVersion, crateVersion, majorOffset, rootPkg: rootPackageJson, rootPkgPath: rootPackageJsonPath } =
    computeReleaseVersions(rootDir);

  console.log(`📦 Syncing root release version to: ${npmVersion}`);
  if (majorOffset > 0) {
    console.log(
      `📦 Rust crates run ${majorOffset} major(s) ahead per ${OFFSET_FILE_NAME}: publishing them at ${crateVersion}`
    );
  }

  // Update workspace Cargo.toml
  const cargoTomlPath = join(rootDir, 'Cargo.toml');
  let cargoToml = readFileSync(cargoTomlPath, 'utf8');

  // `String.prototype.replace` returns the input UNCHANGED when the pattern
  // does not match, so a `[workspace.package]` this pattern cannot reach would
  // be written back byte-identical and still reported as synced below — and
  // the crates would then publish at the stale version. The gate half of this
  // pair already refuses with NO_WORKSPACE_VERSION (see
  // scripts/check-rust-major-offset.mjs); the writer has to refuse on the same
  // condition or the two halves disagree about the same manifest.
  if (!WORKSPACE_VERSION_PATTERN.test(cargoToml)) {
    throw new Error(
      `NO_WORKSPACE_VERSION: ${cargoTomlPath} has no [workspace.package] version literal to rewrite. That literal is what every crate publishes at, so reporting a successful sync here would publish the crates at the stale version.`
    );
  }

  cargoToml = cargoToml.replace(WORKSPACE_VERSION_PATTERN, `$1${crateVersion}$3`);

  cargoToml = rewriteInternalDeps('Cargo.toml', cargoToml, crateVersion);

  writeFileSync(cargoTomlPath, cargoToml);
  console.log(`✅ Updated Cargo.toml workspace version to ${crateVersion}`);

  // Crate manifests carry `version = "…"` on their internal `path`
  // dependencies so they are publishable to crates.io (cargo strips the
  // path and keeps the version requirement on publish). Those literals
  // must track the workspace version or every workspace build breaks with
  // a version/path mismatch after a bump.
  for (const member of RUST_MEMBER_DIRS) {
    const memberTomlPath = join(rootDir, 'rust', member, 'Cargo.toml');
    let memberToml;
    try {
      memberToml = readFileSync(memberTomlPath, 'utf8');
    } catch (error) {
      // Same reasoning as syncCargoLock's member read above: this list of
      // crate directories is hardcoded, so a rename, a move, or an unreadable
      // file makes this loop a silent no-op and leaves the internal
      // `version = "…"` literals on the previous release — the exact
      // version/path mismatch the comment above warns about. Say so.
      console.warn(
        `⚠️  Could not read rust/${member}/Cargo.toml; its internal dep versions are left at the previous release (${error.message})`
      );
      continue;
    }
    const updated = rewriteInternalDeps(`rust/${member}/Cargo.toml`, memberToml, crateVersion);
    if (updated !== memberToml) {
      writeFileSync(memberTomlPath, updated);
      console.log(`✅ Updated rust/${member}/Cargo.toml internal dep versions to ${crateVersion}`);
    }
  }

  // The lock records the MEMBERS' own versions, which are the crate versions —
  // not the npm one.
  syncCargoLock(crateVersion);

  // Update root package.json. This is the npm/tag side, so it takes the npm
  // version: the major offset moves the crates, never the packages.
  if (rootPackageJson.version !== npmVersion) {
    rootPackageJson.version = npmVersion;
    writeFileSync(rootPackageJsonPath, JSON.stringify(rootPackageJson, null, 2) + '\n');
    console.log(`✅ Updated root package.json version to ${npmVersion}`);
  }
}

try {
  syncVersions();
} catch (error) {
  console.error('❌ Error syncing versions:', error.message);
  process.exit(1);
}
