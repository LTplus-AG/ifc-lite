// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The column layer shared by both Parquet decoders.
 *
 * Split out of `parquet-tables.ts` when #3215 pushed that file past its
 * module-size budget. The gate's default is shrink or split; a raise is
 * sanctioned but wants a per-file justification in the PR, and none was needed
 * here, because the seam was already there: the two decoders differ in row
 * count and identity column, but resolve the SAME additive trailing block,
 * which the server builds from one `shared_trailing_fields()` in
 * `apps/server/src/services/parquet_schema.rs`.
 */

import type { ArrowTableLike } from './parquet-tables.js';

/**
 * Absent marker for the two source ids; mirrors the constants in
 * `apps/server/src/services/parquet_schema.rs` and
 * `packages/cache/src/sections/geometry.ts`.
 *
 * IT IS A REAL COLLISION, not a theoretical one, and the trade is deliberate.
 * `#4294967295` is a legal STEP instance name: `fast_parse_tests.rs:57` asserts
 * u32::MAX parses as a valid express id, and `step_tests.rs:436` writes one. A
 * mesh whose source item is exactly that id decodes here as ABSENT and loses
 * its drill target.
 *
 * Taken anyway, because the alternative is worse in the direction that matters.
 * The realistic encodings are: `0` (reachable — `IfcMaterialLayer.Material` is
 * OPTIONAL and an air gap arrives as 0, which is why `with_style_metadata`
 * filters it), a nullable column (whose values buffer parquet-wasm 0.7.x fills
 * with the NEIGHBOURING row's id — a wrong drill target, worse than none), or
 * a parallel presence column per id (two more columns on every mesh row to
 * disambiguate one value in 4.29 billion). This loses provenance for one
 * unreachable id; the others corrupt it or cost every row.
 *
 * Note `packages/cache/src/sections/geometry.ts:165` states the stronger claim
 * — "No STEP express id can reach 0xFFFFFFFF" — which is false for the same
 * reason. That is pre-existing and out of scope here, but it is the same
 * assumption and should be corrected there too.
 */
export const ABSENT_SOURCE_ID = 0xffffffff;

/** Read a numeric column, or `undefined` when the table does not carry it. */
export function numericColumn(table: ArrowTableLike, name: string): ArrayLike<number> | undefined {
  return table.getChild(name)?.toArray();
}

/**
 * A column present AND parallel to the rows, else `undefined`. Folding the
 * guard into the lookup is what lets callers take plain optional columns
 * instead of `(column, hasColumn)` pairs. A short column is a truncated
 * payload, and trusting it hands one row's value to another.
 */
export function usableColumn(
  table: ArrowTableLike,
  name: string,
  rowCount: number
): ArrayLike<number> | undefined {
  const c = numericColumn(table, name);
  return c && c.length === rowCount ? c : undefined;
}

/**
 * Every additive per-mesh column, resolved and guarded once. Both transports
 * carry the same trailing block (`shared_trailing_fields` in
 * `apps/server/src/services/parquet_schema.rs`) and differ only in row count,
 * which is why that is a parameter.
 */
export function meshColumns(table: ArrowTableLike, rowCount: number) {
  return {
    originX: usableColumn(table, 'origin_x', rowCount),
    originY: usableColumn(table, 'origin_y', rowCount),
    originZ: usableColumn(table, 'origin_z', rowCount),
    geometryClass: usableColumn(table, 'geometry_class', rowCount),
    geometryItemId: usableColumn(table, 'geometry_item_id', rowCount),
    materialId: usableColumn(table, 'material_id', rowCount),
  };
}

/** One source-id column at one row, or `undefined` when absent. */
export function readSourceId(column: ArrayLike<number> | undefined, index: number): number | undefined {
  const v = column?.[index];
  return v && v !== ABSENT_SOURCE_ID ? v : undefined;
}

