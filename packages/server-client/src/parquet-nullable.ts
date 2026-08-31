// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Null-safe bulk extraction for a nullable numeric Arrow column.
 *
 * `Vector.toArray()` returns the column's raw values buffer directly (its
 * fast path for a primitive type), and that buffer carries whatever bits sit
 * at a NULL row's slot — 0 in practice for a Float64/Int column written by
 * every writer this project has observed (DuckDB, parquet-wasm), not a
 * detectable sentinel. `data-model-decoder.ts`'s own module doc cites
 * `toArray()` as "10-20x faster" than per-row `.get(i)` for BULK STRING
 * extraction; that justification does not carry over to a NULLABLE numeric
 * column, where `.get(i)` is the only call that reports a null row as `null`
 * instead of a real-looking `0`.
 *
 * Two server-emitted columns are nullable `Float64` today: spatial-node
 * `elevation` (a storey whose elevation cannot be resolved, see
 * `apps/server/src/services/data_model/spatial.rs`) and material
 * `thickness` (every non-layer material association — single material,
 * material list, material constituent — always has `thickness: None`, see
 * `apps/server/src/services/data_model/materials.rs`). Both used to decode
 * here as `0` instead of `undefined` — a legitimate "no elevation" storey or
 * "not a layer" material silently reading as a real, wrong measurement.
 */
export function nullableFloat64Column(
  table: { getChild(name: string): unknown },
  name: string
): (number | null)[] | undefined {
  const col = table.getChild(name) as
    | { toArray(): ArrayLike<number>; nullCount: number; get(index: number): number | null }
    | null
    | undefined;
  if (!col) return undefined;
  const raw = col.toArray();
  // The common case (no nulls in this column/payload) keeps the fast bulk path.
  if (col.nullCount === 0) return Array.from(raw);
  return Array.from(raw, (value, i) => (col.get(i) === null ? null : value));
}
