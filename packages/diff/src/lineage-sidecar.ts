/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public declarations; the implementation lives in Rust (#8042).
import type { LineageEntry } from './lineage.js';
import type { ModelIdentity } from './sidecar-common.js';
import type { LINEAGE_SIDECAR_FORMAT, LINEAGE_SIDECAR_VERSION, LINEAGE_SIDECAR_KEYED_VERSION } from './wasm-lineage-sidecar.js';
export interface LineageSidecar {
  format: typeof LINEAGE_SIDECAR_FORMAT;
  version: typeof LINEAGE_SIDECAR_VERSION | typeof LINEAGE_SIDECAR_KEYED_VERSION;
  base: ModelIdentity;
  head: ModelIdentity;
  created?: string;
  /** See `IdentityMapSidecar.keyProperty`; absent means GlobalId. */
  keyProperty?: string;
  /** Sorted by (first base key, first head key); every key in at most one entry per side. */
  entries: LineageEntry[];
  /**
   * Base keys the comparison left deleted with no lineage — sorted. A key in
   * neither this list nor any entry was matched by key and keeps its key on
   * rekey. See `Lineage` in `lineage.ts`.
   */
  deleted: string[];
}

export interface LineageSidecarInit {
  base: ModelIdentity;
  head: ModelIdentity;
  entries: readonly LineageEntry[];
  deleted?: readonly string[];
  created?: string;
  keyProperty?: string;
}
