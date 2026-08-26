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
 * `waitUntilInIndex`, which had no try/catch, and out to `process.exit(1)`
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
 *
 * TRADE, on the PUBLISH side: `release-crates.mjs` uses this as its
 * "already published, skip it" pre-check, and a YANKED version reads as not
 * published here — so a re-run after someone yanks a bad attempt tries to
 * publish that version again. crates.io does not free a version number on a
 * yank (a yank marks the version unusable for new resolution; it does not
 * unpublish it), so that attempt is expected to be refused as a duplicate and
 * the re-run cannot recover. This is reasoned from documented crates.io
 * behaviour, NOT measured here — no test publishes to a real registry. The
 * recovery path after a bad crate publish is therefore a NEW version, not a
 * yank-and-re-run. It is left as one function rather than split into a
 * separate `versionExists()` for the pre-check because the safe direction is
 * the current one: a `versionExists()` pre-check would silently SKIP a yanked
 * crate and let the release finish "green" with a version downstream crates
 * cannot resolve.
 */
export async function isPublished(crate, ver, fetchImpl = fetch, opts = {}) {
  const version = await fetchVersionRecord(crate, ver, fetchImpl, opts);
  return version?.yanked === false;
}

/**
 * The sparse-index path for a crate name, per the registry index layout
 * (https://doc.rust-lang.org/cargo/reference/registry-index.html): 1-char
 * names under `1/`, 2-char under `2/`, 3-char under `3/<first letter>/`,
 * everything else under `<chars 1-2>/<chars 3-4>/`. Index paths are
 * lowercase; crate names are case-insensitive on crates.io.
 */
export function sparseIndexPath(crate) {
  const name = crate.toLowerCase();
  if (name.length === 1) return `1/${name}`;
  if (name.length === 2) return `2/${name}`;
  if (name.length === 3) return `3/${name[0]}/${name}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

/**
 * Is `crate@ver` visible in the SPARSE INDEX — the thing `cargo` actually
 * resolves dependencies against?
 *
 * crates.io is two systems, and the difference is the v6.0.1 incident (run
 * 32867366010). The publish request writes the version to the registry
 * DATABASE before returning success, and `/api/v1/crates/...` — what
 * `isPublished` reads — answers from that database. The index at
 * index.crates.io is what `cargo publish` consults when resolving the next
 * crate's requirements.
 *
 * The lag is NOT index regeneration. That takes seconds: in the same job,
 * `ifc-lite-clash` was confirmed in the index 1.3s after upload, and all five
 * crates of the recovery run in 1.3-1.5s. The index object for
 * `ifc-lite-core` carries `last-modified: 15:46:38`, i.e. the ORIGIN held
 * 6.0.1 sixty-three seconds before `ifc-lite-geometry` failed to resolve
 * `ifc-lite-core = ^6.0.1` at 15:47:41.
 *
 * The lag was the CDN edge. The object is served `cache-control:
 * public,max-age=600` via Varnish, and `ifc-lite-core` is the one crate whose
 * index file the runner had already fetched — everything depends on it, so
 * cargo pulled it for resolution BEFORE the publish and the edge cached the
 * pre-publish copy for up to ten minutes. `clash`, with no dependents fetched
 * ahead of it, propagated in 1.3s.
 *
 * This function issues a plain unconditioned GET on that same URL ON PURPOSE.
 * Fastly ignores a request `Cache-Control: no-cache` here (measured: `x-cache:
 * HIT` either way, `MISS` only with a cache-busting query), so busting the
 * cache would make this gate read the ORIGIN while cargo still reads the
 * stale edge — it would pass and then cargo would fail. Reading the same
 * cached view cargo reads is what makes it predictive. A publish-side poll
 * against the API passes during exactly that
 * window; only a poll against this URL — the same URL cargo reads — observes
 * the fact the next publish depends on.
 *
 * 404 means the index FILE does not exist, which is the normal state before
 * a crate's first-ever publish: "not visible yet", not an error. A yanked
 * entry reads as not visible — cargo will not resolve a yanked version. An
 * unparseable index line THROWS rather than being skipped: the file is
 * machine-generated, a corrupt one means cargo is about to choke on it too,
 * and the polls in this module treat a throw as one failed look and fail
 * closed naming the error, never as "not published".
 */
export async function isInSparseIndex(crate, ver, fetchImpl = fetch, opts = {}) {
  const url = `https://index.crates.io/${sparseIndexPath(crate)}`;
  const res = await cratesIoGet(url, { fetchImpl, ...opts });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`crates.io index returned ${res.status} for ${crate}`);
  }
  const text = await res.text();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (err) {
      throw new Error(`unparseable index line for ${crate}: ${err.message}`);
    }
    if (entry.vers === ver) return entry.yanked !== true;
  }
  return false;
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
 * not yanked, is visible in the sparse index, and its artifact downloads
 * with a non-empty body. Used by `verify-crates-publish.js`. The index
 * clause is not redundant with the record: a version that is API-visible but
 * index-absent (the v6.0.1 window — see `isInSparseIndex`) is unreachable by
 * every consumer running `cargo add`/`cargo update`, so a verifier without
 * it goes green on exactly the state that broke the release. The
 * publish-side poll deliberately uses only the cheaper `isInSparseIndex` —
 * it runs many times per crate, and re-downloading the `.crate` on each poll
 * would be the wrong trade. Measured at 6.0.1 against the index entries
 * (113-142KB): core 217KB is 1.9x, wasm 179KB is 1.3x, and geometry 1.35MB is
 * 10x. The small crates are close; geometry is the one that decides it. At
 * this bound the poll can run ~132 times per crate, so adding the artifact
 * fetch would pull roughly 178MB for geometry alone.
 */
export async function isFullyPublished(crate, ver, fetchImpl = fetch, opts = {}) {
  const version = await fetchVersionRecord(crate, ver, fetchImpl, opts);
  if (version?.yanked !== false) return false;
  if (!(await isInSparseIndex(crate, ver, fetchImpl, opts))) return false;
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
 * The default `checkFn` is `isInSparseIndex`, NOT `isPublished`: the poll
 * exists so the NEXT dependent `cargo publish` can resolve this version, and
 * cargo resolves from the index, which lags the API (see `isInSparseIndex`).
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
export async function waitUntilInIndex(
  crate,
  ver,
  { checkFn = isInSparseIndex, intervalMs = 5000, timeoutMs = 120000, sleepFn = sleep } = {}
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
