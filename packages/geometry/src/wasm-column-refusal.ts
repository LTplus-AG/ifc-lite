/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A wasm refusal of malformed column arguments (#4614): the text of
 * `ColumnLengthMismatch` in rust/core/src/columnar_index.rs, the class-column
 * check in source_fingerprint_prepass.rs and `check_rgba_columns` in
 * prepass_sharded.rs. Retrying with a materialised copy of the file cannot
 * change that verdict, so the worker's SAB-view fallbacks rethrow it instead.
 */
export function isColumnLengthRefusal(err: unknown): boolean {
  return /columns disagree/.test(err instanceof Error ? err.message : String(err));
}
