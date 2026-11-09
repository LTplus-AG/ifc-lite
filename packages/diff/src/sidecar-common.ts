/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Public declarations; the implementation lives in Rust (#8042).
/**
 * Which model a set of claims was derived from.
 *
 * {@link hash} is the load-bearing field: an opaque `<algorithm>:<hex>` content
 * digest of the model bytes (the CLI writes `sha256:…`). {@link path} is a
 * convenience for humans reading the file and is never compared — paths move,
 * and a comparison on one would reject a valid map for the wrong reason while
 * accepting an edited file at the same path.
 */
export interface ModelIdentity {
  /** Content digest of the model bytes, `<algorithm>:<hex>`. */
  hash: string;
  /** Path or file name the digest was taken from. Informational only. */
  path?: string;
}
