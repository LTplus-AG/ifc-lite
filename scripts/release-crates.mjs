#!/usr/bin/env node

/**
 * Publishes the publishable Rust crates to crates.io.
 *
 * Replaces the old `cargo publish … || true` chain, which silently swallowed
 * EVERY failure: duplicate-version no-ops (expected when the workspace
 * version didn't advance) looked identical to real breakage, so
 * `ifc-lite-wasm` sat broken at 2.3.0 for months and the raw-bytes core API
 * almost shipped to npm without ever reaching crates.io.
 *
 * Behaviour per crate:
 *   - version already on crates.io  → skip (expected, logged)
 *   - version missing               → `cargo publish`; any failure FAILS the release
 *
 * Only `ifc-lite-core` and `ifc-lite-geometry` are published.
 * `ifc-lite-processing` and `ifc-lite-clash` have never been on crates.io and
 * carry version-less `path` dependencies, which makes them — and
 * `ifc-lite-wasm`, which depends on both — unpublishable as-is. Publishing
 * them is a deliberate public-surface decision, not a release-script default;
 * if that decision is made, add versions to their path deps and append them
 * (and `ifc-lite-wasm`) here in dependency order.
 *
 * `cargo publish` (≥1.66) blocks until the new version is visible in the
 * index, so no sleep is needed between dependent publishes.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// Dependency order: geometry depends on core.
const CRATES = ['ifc-lite-core', 'ifc-lite-geometry'];

const cargoToml = readFileSync(join(rootDir, 'Cargo.toml'), 'utf8');
const versionMatch = cargoToml.match(
  /\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/
);
if (!versionMatch) {
  console.error('❌ Could not read [workspace.package] version from Cargo.toml');
  process.exit(1);
}
const version = versionMatch[1];

async function isPublished(crate, ver) {
  const res = await fetch(`https://crates.io/api/v1/crates/${crate}/${ver}`, {
    headers: { 'User-Agent': 'ifc-lite-release (github.com/LTplus-AG/ifc-lite)' },
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`crates.io returned ${res.status} for ${crate}@${ver}`);
  }
  const body = await res.json();
  return !body.errors;
}

for (const crate of CRATES) {
  if (await isPublished(crate, version)) {
    console.log(`⏭️  ${crate}@${version} already on crates.io — skipping`);
    continue;
  }
  console.log(`📦 Publishing ${crate}@${version} …`);
  execSync(`cargo publish -p ${crate} --allow-dirty`, {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log(`✅ Published ${crate}@${version}`);
}
