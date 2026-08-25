#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
 *   - version missing               → `cargo publish`, then POLL crates.io
 *                                      until the version is visible in the
 *                                      index before moving to the next crate;
 *                                      any publish failure OR a poll timeout
 *                                      FAILS the release.
 *
 * Crates are listed in dependency order (see `scripts/lib/crates-io.mjs`).
 * `cargo publish` does NOT block until the new version is visible in the
 * index — it waits up to its own internal timeout (~60s) and then prints a
 * `warning: timed out waiting for … to be available` and carries on
 * regardless. #3180 is exactly that: `ifc-lite-geometry` published fine,
 * cargo's wait timed out before the index caught up, and the next crate
 * (`ifc-lite-processing`, which depends on it) failed to resolve it — 4 of 7
 * crates were left unpublished on a release that otherwise looked clean up
 * to that point. So this script does its own polling explicitly, with a
 * timeout that FAILS the release rather than warning and continuing.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CRATES, readWorkspaceVersion, isPublished, waitUntilPublished } from './lib/crates-io.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// How long to wait for a just-published crate to appear in the crates.io
// index before failing the release outright. crates.io propagation is
// normally seconds; cargo's own (silently-abandoned) wait is ~60s, so 3
// minutes gives real headroom over an ordinary slow moment without letting a
// stuck release hang indefinitely.
const PUBLISH_POLL_INTERVAL_MS = 5000;
const PUBLISH_POLL_TIMEOUT_MS = 180_000;

export async function publishAllCrates({
  crates = CRATES,
  version,
  cwd = rootDir,
  publishFn = (crate) =>
    execSync(`cargo publish -p ${crate} --allow-dirty`, { cwd, stdio: 'inherit' }),
  checkFn = isPublished,
  intervalMs = PUBLISH_POLL_INTERVAL_MS,
  timeoutMs = PUBLISH_POLL_TIMEOUT_MS,
  sleepFn,
} = {}) {
  for (const crate of crates) {
    if (await checkFn(crate, version)) {
      console.log(`⏭️  ${crate}@${version} already on crates.io — skipping`);
      continue;
    }
    console.log(`📦 Publishing ${crate}@${version} …`);
    publishFn(crate);

    console.log(`⏳ Waiting for ${crate}@${version} to appear in the crates.io index …`);
    const { ok, waitedMs, attempts } = await waitUntilPublished(crate, version, {
      checkFn,
      intervalMs,
      timeoutMs,
      ...(sleepFn ? { sleepFn } : {}),
    });
    if (!ok) {
      throw new Error(
        `${crate}@${version} did not appear in the crates.io index within ` +
          `${Math.round(timeoutMs / 1000)}s of publishing (${attempts} checks). ` +
          `\`cargo publish\` reported success locally, but the index has not caught ` +
          `up — publishing the next crate now would fail to resolve this one. Failing ` +
          `the release rather than racing it; re-running is safe once the index catches up ` +
          `(already-published crates are skipped).`
      );
    }
    console.log(`✅ Published and verified ${crate}@${version} in the index (${Math.round(waitedMs / 1000)}s, ${attempts} check(s))`);
  }
}

async function main() {
  const version = readWorkspaceVersion(rootDir);
  await publishAllCrates({ version, cwd: rootDir });
}

// Only run when invoked directly (`node scripts/release-crates.mjs`), not
// when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
