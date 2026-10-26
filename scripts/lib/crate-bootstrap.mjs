/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Crates in `CRATES` (./crates-io.mjs) that have never been published. A new
 * crate's first upload cannot go through trusted publishing (it needs a
 * personal token), so it is bootstrapped by hand once and its Trusted
 * Publisher configured after.
 *
 * Until then `check-rust-semver.mjs` reports such a crate as "bootstrap
 * pending" on pull requests instead of failing every PR with NO_BASELINE.
 * At release time (`--release`, passed by `release-all.mjs`) the list is
 * ignored, so the release still refuses before it publishes any crate rather
 * than half-publishing up to the one trusted publishing cannot create.
 * Remove an entry in the same change that records its bootstrap publish.
 */
export const BOOTSTRAP_PENDING = ['ifc-lite-geometry-runtime'];

/** The PR-time notice for a crate awaiting bootstrap, or null when the crate
 * is not pending or crates.io already has a release of it. */
export function bootstrapPendingNotice(crate, baseline, pending = BOOTSTRAP_PENDING) {
  if (baseline || !pending.includes(crate)) return null;
  return (
    `${crate} — BOOTSTRAP_PENDING: no crates.io release yet, so no API was compared. ` +
    'Publish it once by hand and configure its Trusted Publisher before the next release; ' +
    'the release-time run of this gate refuses it with NO_BASELINE until then.'
  );
}
