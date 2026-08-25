#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared crates.io release plumbing, used by both `release-crates.mjs`
 * (publishes) and `verify-crates-publish.js` (checks after the fact). The
 * crate list and the "is this version live" query used to live only inside
 * `release-crates.mjs`, so the verifier had nothing to import and #3181's
 * fix would otherwise have had to hand-copy the list and drift from it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Dependency order: geometry depends on core; clash is dependency-free;
// processing depends on core+geometry; ffi (cdylib C bindings) depends on
// processing; wasm depends on core+geometry+clash+processing.
export const CRATES = [
  'ifc-lite-core',
  // ifc-lite-clash must precede ifc-lite-geometry. geometry carries a
  // dev-dependency on clash (`ifc-lite-clash.workspace = true`, added with the
  // intersection-solid oracle in #2574) and a workspace dep resolves to
  // `{ version = "x.y.z", path = ... }` — so it carries a VERSION, and
  // `cargo publish` resolves versioned dev-dependencies against crates.io even
  // though they add nothing to a shipping build. Publishing geometry first
  // therefore fails with "failed to select a version for the requirement
  // `ifc-lite-clash = ^x.y.z`" until clash is already up.
  //
  // Contrast rust/core, whose geometry dev-dep is written `{ path = "../geometry" }`
  // with no version: cargo strips that one at publish time, which is why core
  // publishes cleanly despite the same shape of cycle. Either form works; what
  // must not happen is a versioned dev-dep on a crate published later.
  //
  // clash has zero dependencies and zero dev-dependencies, so it is safe at the
  // front.
  'ifc-lite-clash',
  'ifc-lite-geometry',
  'ifc-lite-processing',
  // ifc-lite-export must precede ffi/wasm: wasm-bindings pins it by version
  // (HBJSON/KMZ exporters, #1235) and cargo resolves that against crates.io
  // at publish time. NOTE: the crate's FIRST publish cannot go through
  // trusted publishing (new crates need a personal token) - bootstrap it
  // manually once, then configure its trusted publisher, like every other
  // crate in this list was bootstrapped.
  'ifc-lite-export',
  'ifc-lite-ffi',
  'ifc-lite-wasm',
];

/** Read the workspace version straight out of `Cargo.toml` (the source of
 * truth `sync-versions.js` keeps every crate's `Cargo.toml` aligned with). */
export function readWorkspaceVersion(rootDir) {
  const cargoToml = readFileSync(join(rootDir, 'Cargo.toml'), 'utf8');
  const versionMatch = cargoToml.match(
    /\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/
  );
  if (!versionMatch) {
    throw new Error('Could not read [workspace.package] version from Cargo.toml');
  }
  return versionMatch[1];
}

/**
 * Query crates.io for whether `crate@ver` is published. `fetchImpl` is
 * injectable so tests can stub the registry response without a real network
 * call.
 */
export async function isPublished(crate, ver, fetchImpl = fetch) {
  const res = await fetchImpl(`https://crates.io/api/v1/crates/${crate}/${ver}`, {
    headers: { 'User-Agent': 'ifc-lite-release (github.com/LTplus-AG/ifc-lite)' },
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`crates.io returned ${res.status} for ${crate}@${ver}`);
  }
  const body = await res.json();
  return !body.errors;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll crates.io until `crate@ver` appears in the index or `timeoutMs`
 * elapses, instead of trusting `cargo publish` to have blocked until it was
 * visible (it doesn't — see #3180). `checkFn`/`sleepFn` are injectable so
 * this can be driven by a fake clock in tests without a real 2-minute wait.
 *
 * Returns `{ ok, waitedMs, attempts }`. `ok: false` after the timeout means
 * the caller must fail loudly, not silently move on — a version that never
 * became visible will break the next dependent crate's publish anyway.
 */
export async function waitUntilPublished(
  crate,
  ver,
  { checkFn = isPublished, intervalMs = 5000, timeoutMs = 120000, sleepFn = sleep } = {}
) {
  const start = Date.now();
  let attempts = 0;
  for (;;) {
    attempts++;
    if (await checkFn(crate, ver)) {
      return { ok: true, waitedMs: Date.now() - start, attempts };
    }
    const waited = Date.now() - start;
    if (waited >= timeoutMs) {
      return { ok: false, waitedMs: waited, attempts };
    }
    await sleepFn(intervalMs);
  }
}
