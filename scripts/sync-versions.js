#!/usr/bin/env node

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
        } catch {
          // no package.json in this directory, skip
        }
      }
    } catch {
      // parent directory doesn't exist, skip
    }
  }
  return packages;
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
    /(ifc-lite-(?:core|geometry|processing|clash|wasm)\s*=\s*\{\s*version\s*=\s*")[^"]+(")/g,
    `$1${version}$2`
  );

  writeFileSync(cargoTomlPath, cargoToml);
  console.log(`✅ Updated Cargo.toml workspace version to ${version}`);

  // Crate manifests carry `version = "…"` on their internal `path`
  // dependencies so they are publishable to crates.io (cargo strips the
  // path and keeps the version requirement on publish). Those literals
  // must track the workspace version or every workspace build breaks with
  // a version/path mismatch after a bump.
  for (const member of ['core', 'geometry', 'processing', 'clash', 'ffi', 'wasm-bindings']) {
    const memberTomlPath = join(rootDir, 'rust', member, 'Cargo.toml');
    let memberToml;
    try {
      memberToml = readFileSync(memberTomlPath, 'utf8');
    } catch {
      continue;
    }
    const updated = memberToml.replace(
      /(ifc-lite-(?:core|geometry|processing|clash|wasm)\s*=\s*\{\s*version\s*=\s*")[^"]+(")/g,
      `$1${version}$2`
    );
    if (updated !== memberToml) {
      writeFileSync(memberTomlPath, updated);
      console.log(`✅ Updated rust/${member}/Cargo.toml internal dep versions to ${version}`);
    }
  }

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
