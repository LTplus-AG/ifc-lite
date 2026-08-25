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

// crates.io REFUSES requests that carry no User-Agent. Measured 2026-08-25:
//
//   GET /api/v1/crates/ifc-lite-core/6.0.0   without UA -> 403
//                                            with    UA -> 200
//
// with the body "We require that all requests include a User-Agent header".
// Drop this header and the release does not fail with something that reads
// like a missing header: a 403 is not a 404, so `isPublished` throws, the
// publish aborts partway through, and every verify run goes red. Set it on
// EVERY crates.io request — the artifact download below included, where a
// 403 renders identically to a missing artifact. `HEAD` on the download path
// is refused as well; use `GET`.
//
// `scripts/lib/crates-io.test.mjs` asserts the header is present on both
// calls, so deleting it fails the suite rather than the next release.
export const USER_AGENT = 'ifc-lite-release (github.com/LTplus-AG/ifc-lite)';

/**
 * Statuses crates.io recovers from on its own, as opposed to an answer about
 * the crate. Retrying a 429/5xx/timeout is the difference between riding out
 * a blip and aborting a release mid-list; retrying a 404 or a 403 would just
 * burn the budget on a definitive answer.
 */
export function isTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const REQUEST_RETRIES = 3;
const REQUEST_RETRY_DELAY_MS = 2000;

/**
 * One crates.io GET, retried on transient statuses and on transport-level
 * failures (a thrown `fetch` — DNS, reset connection, TLS) with a bounded,
 * linearly-backing-off budget. Anything definitive (2xx, 3xx, 404, 403…) is
 * returned to the caller on the first try.
 *
 * Before this existed a single 503 propagated out of `isPublished` into
 * `waitUntilPublished`, which had no try/catch, and out to `process.exit(1)`
 * — aborting a release with some crates already published, i.e. producing
 * exactly the partial-publish state #3180/#3181 are about.
 */
async function cratesIoGet(
  url,
  { fetchImpl = fetch, retries = REQUEST_RETRIES, retryDelayMs = REQUEST_RETRY_DELAY_MS, sleepFn = sleep } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      lastError = new Error(`crates.io request to ${url} failed: ${err.message}`, { cause: err });
      res = null;
    }
    if (res) {
      if (!isTransientStatus(res.status)) return res;
      lastError = new Error(`crates.io returned ${res.status} for ${url}`);
    }
    if (attempt < retries) await sleepFn(retryDelayMs * attempt);
  }
  throw lastError;
}

/**
 * Fetch the crates.io version RECORD for `crate@ver`, or `null` when the
 * registry says it does not exist. `fetchImpl` is injectable so tests can
 * stub the registry response without a real network call.
 */
export async function fetchVersionRecord(crate, ver, fetchImpl = fetch, opts = {}) {
  const res = await cratesIoGet(`https://crates.io/api/v1/crates/${crate}/${ver}`, { fetchImpl, ...opts });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`crates.io returned ${res.status} for ${crate}@${ver}`);
  }
  const body = await res.json();
  if (body.errors) return null;
  return body.version ?? null;
}

/**
 * Is `crate@ver` published AND still good?
 *
 * The `yanked` clause is load-bearing and is not obvious from the shape of
 * the response: a yanked version keeps its record, so the older
 * `return !body.errors` answered `true` for one. crates.io cannot unpublish,
 * only yank — which makes "yanked" the ONLY way a published crate goes bad,
 * and the one state a record-existence check cannot see. A yank between
 * publish and verify, or a yank of a bad earlier attempt, both read as green
 * without it.
 */
export async function isPublished(crate, ver, fetchImpl = fetch, opts = {}) {
  const version = await fetchVersionRecord(crate, ver, fetchImpl, opts);
  return version?.yanked === false;
}

/**
 * Fetch the `.crate` artifact itself and confirm it has bytes.
 *
 * A version record existing and the tarball being downloadable are different
 * facts, and #3180 was an incident where a claim of success outlived the
 * artifact. `dlPath` comes from the version record (`version.dl_path`) so
 * this follows the registry's own pointer rather than reconstructing a URL.
 */
export async function isArtifactFetchable(crate, ver, { fetchImpl = fetch, dlPath, ...opts } = {}) {
  const path = dlPath || `/api/v1/crates/${crate}/${ver}/download`;
  const url = path.startsWith('http') ? path : `https://crates.io${path}`;
  const res = await cratesIoGet(url, { fetchImpl, ...opts });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`crates.io returned ${res.status} downloading ${crate}@${ver} from ${url}`);
  }
  const bytes = await res.arrayBuffer();
  return bytes.byteLength > 0;
}

/**
 * The full "this release is really out" check: the version record exists, is
 * not yanked, and its artifact downloads with a non-empty body. Used by
 * `verify-crates-publish.js`. The publish-side poll deliberately uses the
 * cheaper `isPublished` — it runs up to ~36 times per crate, and downloading
 * a multi-megabyte tarball on each poll would be the wrong trade there.
 */
export async function isFullyPublished(crate, ver, fetchImpl = fetch, opts = {}) {
  const version = await fetchVersionRecord(crate, ver, fetchImpl, opts);
  if (version?.yanked !== false) return false;
  return isArtifactFetchable(crate, ver, { fetchImpl, dlPath: version.dl_path, ...opts });
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
 * Returns `{ ok, waitedMs, attempts, lastError }`. `ok: false` after the
 * timeout means the caller must fail loudly, not silently move on — a version
 * that never became visible will break the next dependent crate's publish
 * anyway.
 *
 * A THROWING `checkFn` does not end the poll. `cratesIoGet` already retries
 * transient statuses, but an outage outlasting its budget used to propagate
 * straight out of here — mid-publish, with earlier crates already on the
 * registry — and abort the release into the partial state this poll exists
 * to prevent. Here an error is one failed look at the index, not a verdict:
 * keep polling until the timeout, and surface the last error in the failure
 * so the operator sees "registry was erroring", not "crate never appeared".
 */
export async function waitUntilPublished(
  crate,
  ver,
  { checkFn = isPublished, intervalMs = 5000, timeoutMs = 120000, sleepFn = sleep } = {}
) {
  const start = Date.now();
  let attempts = 0;
  let lastError = null;
  for (;;) {
    attempts++;
    try {
      const visible = await checkFn(crate, ver);
      // Cleared BEFORE the return: an error the poll recovered from is not
      // part of a successful result.
      lastError = null;
      if (visible) {
        return { ok: true, waitedMs: Date.now() - start, attempts, lastError: null };
      }
    } catch (err) {
      lastError = err;
    }
    const waited = Date.now() - start;
    if (waited >= timeoutMs) {
      return { ok: false, waitedMs: waited, attempts, lastError };
    }
    await sleepFn(intervalMs);
  }
}
