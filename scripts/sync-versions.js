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
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

/** Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal. */
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function getWorkspacePackages() {
  const packages = [];
  for (const parent of ['packages', 'apps']) {
    const parentDir = join(rootDir, parent);
    try {
      for (const entry of readdirSync(parentDir)) {
        const pkgJsonPath = join(parentDir, entry, 'package.json');
        try {
          statSync(pkgJsonPath);
          packages.push(pkgJsonPath);
        } catch (error) {
          // A directory with no package.json is ordinary. Anything else means
          // a package is missing from the max-version scan below, which would
          // sync the whole release to a version LOWER than what was published.
          if (error.code !== 'ENOENT') {
            console.warn(`⚠️  Could not stat ${pkgJsonPath}, excluding it from the version scan (${error.message})`);
          }
        }
      }
    } catch (error) {
      // Same, one level up: an unreadable `packages/`/`apps/` silently shrinks
      // the scan to nothing and the sync then reports success at the wrong
      // version.
      if (error.code !== 'ENOENT') {
        console.warn(`⚠️  Could not list ${parentDir}, excluding it from the version scan (${error.message})`);
      }
    }
  }
  return packages;
}

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
  const packagePaths = getWorkspacePackages();

  // Find the highest version across all non-private workspace packages.
  let maxVersion = '0.0.0';
  for (const pkgPath of packagePaths) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.private) continue;
    if (pkg.version && compareSemver(pkg.version, maxVersion) > 0) {
      maxVersion = pkg.version;
    }
  }

  // Also consider root package.json
  const rootPackageJsonPath = join(rootDir, 'package.json');
  const rootPackageJson = JSON.parse(readFileSync(rootPackageJsonPath, 'utf8'));
  if (rootPackageJson.version && compareSemver(rootPackageJson.version, maxVersion) > 0) {
    maxVersion = rootPackageJson.version;
  }

  const version = maxVersion;
  console.log(`📦 Syncing root release version to: ${version}`);

  // Update workspace Cargo.toml
  const cargoTomlPath = join(rootDir, 'Cargo.toml');
  let cargoToml = readFileSync(cargoTomlPath, 'utf8');

  cargoToml = cargoToml.replace(
    /(\[workspace\.package\][^\[]*version\s*=\s*")[^"]+(")/,
    `$1${version}$2`
  );

  cargoToml = cargoToml.replace(
    /(ifc-lite-(?:core|geometry|processing|clash|export|wasm)\s*=\s*\{\s*version\s*=\s*")[^"]+(")/g,
    `$1${version}$2`
  );

  writeFileSync(cargoTomlPath, cargoToml);
  console.log(`✅ Updated Cargo.toml workspace version to ${version}`);

  // Crate manifests carry `version = "…"` on their internal `path`
  // dependencies so they are publishable to crates.io (cargo strips the
  // path and keeps the version requirement on publish). Those literals
  // must track the workspace version or every workspace build breaks with
  // a version/path mismatch after a bump.
  for (const member of ['core', 'geometry', 'processing', 'clash', 'export', 'ffi', 'wasm-bindings']) {
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
    const updated = memberToml.replace(
      /(ifc-lite-(?:core|geometry|processing|clash|export|wasm)\s*=\s*\{\s*version\s*=\s*")[^"]+(")/g,
      `$1${version}$2`
    );
    if (updated !== memberToml) {
      writeFileSync(memberTomlPath, updated);
      console.log(`✅ Updated rust/${member}/Cargo.toml internal dep versions to ${version}`);
    }
  }

  syncCargoLock(version);

  // Update root package.json
  if (rootPackageJson.version !== version) {
    rootPackageJson.version = version;
    writeFileSync(rootPackageJsonPath, JSON.stringify(rootPackageJson, null, 2) + '\n');
    console.log(`✅ Updated root package.json version to ${version}`);
  }
}

try {
  syncVersions();
} catch (error) {
  console.error('❌ Error syncing versions:', error.message);
  process.exit(1);
}
