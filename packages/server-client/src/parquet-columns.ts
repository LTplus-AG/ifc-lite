// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The column layer shared by both Parquet decoders.
 *
 * Split out of `parquet-tables.ts` when #3215 pushed that file past its
 * module-size budget. The gate's rule is shrink or split, not raise, and this
 * is the seam that was already there: the two decoders differ in row count and
 * identity column, but resolve the SAME additive trailing block, which the
 * server builds from one `shared_trailing_fields()` in
 * `apps/server/src/services/parquet_schema.rs`.
 */

import type { ArrowTableLike } from './parquet-tables.js';

/**
 * Absent marker for the two source ids; mirrors the constants in
 * `apps/server/src/services/parquet_schema.rs` and
 * `packages/cache/src/sections/geometry.ts`. `#4294967295` is a legal STEP
 * instance name, so this collision is practically unreachable rather than
 * impossible — chosen over `0`, which IS reachable.
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

