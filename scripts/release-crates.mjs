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
 *   - version already uploaded (API record exists, not yanked) → skip the
 *     `cargo publish`
 *   - otherwise → `cargo publish`; any failure FAILS the release
 *   - EITHER WAY, poll the sparse index until the version is visible there
 *     before moving to the next crate; a poll timeout FAILS the release.
 *
 * Crates are listed in dependency order (see `scripts/lib/crates-io.mjs`).
 * `cargo publish` does NOT block until the new version is visible in the
 * index — it waits up to its own internal timeout (~60s) and then prints a
 * `warning: timed out waiting for … to be available` and carries on with
 * EXIT CODE 0. Both halves of that sentence have now caused an incident:
 * v6.0.0 (#3180) timed out on `ifc-lite-geometry` and
 * `ifc-lite-processing` could not resolve it; v6.0.1 (run 32867366010)
 * timed out on `ifc-lite-core` and `ifc-lite-geometry` could not resolve
 * `ifc-lite-core = ^6.0.1` — 5 of 7 crates left unpublished. So this script
 * polls explicitly, with a timeout that FAILS the release rather than
 * warning and continuing.
 *
 * The poll reads the SPARSE INDEX (`isInSparseIndex`), not the API record
 * that the skip pre-check reads. They diverge: the API answers from the
 * registry database, which has the version the moment the upload returns,
 * while cargo resolves the next crate against the index. On v6.0.1 the view
 * cargo got lagged by over a minute — not because regeneration is slow (it
 * took seconds; see `isInSparseIndex` for the measurements) but because the
 * CDN edge was still serving the pre-publish copy of the one index file the
 * runner had already fetched. Polling the API here would go green inside
 * exactly that window and change nothing. The poll runs on the SKIP path too: a re-run minutes
 * after a failure sees the stuck crate "already published" via the API, and
 * must still wait for its index entry before publishing the dependent that
 * failed last time.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CRATES, readWorkspaceVersion, isPublished, isInSparseIndex, waitUntilInIndex } from './lib/crates-io.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// How long to wait for a just-published crate to appear in the crates.io
// index before failing the release outright.
//
// Sized against the CDN TTL, not against propagation. Index regeneration is
// seconds (measured 1.3-1.5s across six publishes), but the index object is
// served `cache-control: public,max-age=600`, and the crate everything
// depends on is precisely the one whose pre-publish copy the runner already
// pulled for resolution. So the worst realistic wait is that TTL, not a slow
// regeneration, and a 180s bound could not outrun it: it would fail a release
// that is fully live at origin and an immediate re-run would fail the same
// way for the remainder of the ten minutes.
//
// This is PER CRATE, but the worst case does not multiply by the seven of
// them. The TTL clocks run concurrently: waiting out one crate's stale edge
// also ages every other crate's, and only a crate whose index file the runner
// already fetched can be stale at all. So the realistic ceiling is about one
// TTL for the whole run, not seven. The `release` job sets no
// `timeout-minutes`, so it has GitHub's 360-minute default, and even the naive
// 7 x 11 = 77 minutes would not be killed mid-poll. That matters because a
// killed job reports nothing, while this failure path reports why.
const PUBLISH_POLL_INTERVAL_MS = 5000;
const PUBLISH_POLL_TIMEOUT_MS = 660_000;

export async function publishAllCrates({
  crates = CRATES,
  version,
  cwd = rootDir,
  publishFn = (crate) =>
    execSync(`cargo publish -p ${crate} --allow-dirty`, { cwd, stdio: 'inherit' }),
  // "Has this version already been UPLOADED?" — the API record, which the
  // publish request itself writes. Decides only whether to run `cargo
  // publish` again.
  preCheckFn = isPublished,
  // "Can the next `cargo publish` RESOLVE this version?" — the sparse index,
  // the only thing cargo consults. Decides whether to move down the list.
  // These are different facts with different propagation; conflating them is
  // the v6.0.1 incident (see the header).
  indexCheckFn = isInSparseIndex,
  intervalMs = PUBLISH_POLL_INTERVAL_MS,
  timeoutMs = PUBLISH_POLL_TIMEOUT_MS,
  sleepFn,
} = {}) {
  for (const crate of crates) {
    // The already-published pre-check is an OPTIMISATION, not a gate: a
    // registry error here (one that outlasted `cratesIoGet`'s retry budget)
    // must not abort a release part-way down this list. Fall through to the
    // publish attempt instead — `cargo publish` refuses a duplicate version
    // loudly and by name, which is a far better failure than exiting with
    // some crates up and some not.
    //
    // A YANKED version reads as NOT published (see `isPublished`), so this
    // re-attempts the publish rather than skipping it — and crates.io does not
    // free a version number on a yank, so that attempt is expected to be
    // refused as a duplicate. Recovering from a bad crate publish means a new
    // version, not a yank-and-re-run.
    let alreadyPublished = false;
    try {
      alreadyPublished = await preCheckFn(crate, version);
    } catch (err) {
      console.warn(
        `⚠️  Could not ask crates.io whether ${crate}@${version} is already published ` +
          `(${err.message}) — attempting the publish anyway.`
      );
    }
    if (alreadyPublished) {
      console.log(`⏭️  ${crate}@${version} already on crates.io — not publishing it again`);
    } else {
      console.log(`📦 Publishing ${crate}@${version} …`);
      publishFn(crate);
    }

    // Poll the index on BOTH paths, the skip path included. On a re-run
    // shortly after a failure, the stuck crate is "already published" by the
    // API record — skipping straight past it would re-create the original
    // failure at its first dependent if the index still has not caught up.
    console.log(`⏳ Waiting for ${crate}@${version} to appear in the crates.io index …`);
    const { ok, waitedMs, attempts, lastError } = await waitUntilInIndex(crate, version, {
      checkFn: indexCheckFn,
      intervalMs,
      timeoutMs,
      ...(sleepFn ? { sleepFn } : {}),
    });
    if (!ok) {
      throw new Error(
        `${crate}@${version} did not appear in the crates.io index within ` +
          `${Math.round(timeoutMs / 1000)}s (${attempts} checks). ` +
          `The upload succeeded (or the version was already uploaded), but the index ` +
          `cargo resolves against has not caught up — publishing the next crate now ` +
          `would fail to resolve this one. Failing the release rather than racing it. ` +
          `Re-running is safe (already-published crates are not re-published), but if ` +
          `the cause is a stale CDN edge rather than the origin, an immediate re-run ` +
          `hits the same cached copy: check ` +
          `\`curl -sI https://index.crates.io/<path>\` for last-modified and age, and ` +
          `if the origin already has the version, wait out the remaining max-age.` +
          // Distinguishes "the index never caught up" from "crates.io was
          // erroring the whole time" — the same message for both would send
          // the operator hunting a propagation problem during an outage.
          (lastError ? ` Last error from crates.io: ${lastError.message}` : '')
      );
    }
    console.log(`✅ ${crate}@${version} visible in the index (${Math.round(waitedMs / 1000)}s, ${attempts} check(s))`);
  }
}

async function main() {
  const version = readWorkspaceVersion(rootDir);
  await publishAllCrates({ version, cwd: rootDir });
}

// Only run when invoked directly (`node scripts/release-crates.mjs`), not
// when imported by a test.
if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
