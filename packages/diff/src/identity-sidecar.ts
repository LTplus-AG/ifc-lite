/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public declarations; the implementation lives in Rust (#8042).
import type { IdentityMapEntry } from './identity-map.js';
import type { ModelIdentity } from './sidecar-common.js';
export type { ModelIdentity } from './sidecar-common.js';
import type { IDENTITY_MAP_SIDECAR_FORMAT, IDENTITY_MAP_SIDECAR_VERSION, IDENTITY_MAP_SIDECAR_KEYED_VERSION } from './wasm-identity-sidecar.js';
/**
 * A reviewed set of identity claims, scoped to the exact pair of revisions it
 * was verified against.
 */
export interface IdentityMapSidecar {
  format: typeof IDENTITY_MAP_SIDECAR_FORMAT;
  /** `1`, or `2` when {@link keyProperty} is present. */
  version: typeof IDENTITY_MAP_SIDECAR_VERSION | typeof IDENTITY_MAP_SIDECAR_KEYED_VERSION;
  /** The base ("old") revision the claims resolve `entries[].base` against. */
  base: ModelIdentity;
  /** The head ("new") revision the claims resolve `entries[].here` against. */
  head: ModelIdentity;
  /** ISO 8601 creation timestamp, when the producer supplied one. */
  created?: string;
  /**
   * The key scheme the entries' `base`/`here` keys were taken under (issue
   * #4955): an authored property such as `Pset_Asset.AssetId`, or `Tag`.
   * Absent means GlobalId, so a version-1 file written before the field
   * existed is still valid. {@link identityMapSidecarMismatches} reports a
   * scheme mismatch like a digest mismatch, because a GlobalId-keyed map
   * replayed under an authored key would otherwise apply nothing, silently.
   */
  keyProperty?: string;
  /** The claims, sorted by (`base`, `here`) for a reviewable, stable file. */
  entries: IdentityMapEntry[];
}

export interface IdentityMapSidecarInit {
  base: ModelIdentity;
  head: ModelIdentity;
  entries: readonly IdentityMapEntry[];
  /** ISO 8601 timestamp. Omitted entirely when not supplied — the sidecar is
   *  content-addressed by the two model digests, not by when it was written,
   *  and stamping `Date.now()` by default would make two runs over the same
   *  pair produce different bytes for no reason. */
  created?: string;
  /** See {@link IdentityMapSidecar.keyProperty}. */
  keyProperty?: string;
}
