/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Result rows, grouping, and discovery shapes for Lists. */
import type { ColumnDefinition } from './types.js';

export interface ListResult {
  columns: ColumnDefinition[];
  rows: ListRow[];
  /** Total matched entities before pagination */
  totalCount: number;
  /** Execution time in ms */
  executionTime: number;
  /** Per-group breakdown — present only when `grouping` is configured. */
  groups?: ListGroup[];
  /** Whole-result aggregates (count + per-column sums). Present when
   *  `grouping` is configured. */
  summary?: ListSummary;
}

/** One group in a grouped list result. With multi-criteria grouping (issue
 *  #1790) groups are emitted as a FLAT pre-order list: each parent group is
 *  immediately followed by its subgroups (`level` gives the nesting depth). */
export interface ListGroup {
  /** Opaque unique group key - the JSON encoding of `path` (see
   *  `groupPathKey`), collision-free even when a model-derived label contains
   *  separator-like characters. */
  key: string;
  /** Display label for the group header (this level's value only). */
  label: string;
  /** Number of rows in the group (the Count aggregate, issue #1790). */
  count: number;
  /** columnId → summed numeric value, for the configured sum columns. */
  sums: Record<string, number>;
  /** 0-based nesting depth (0 = outermost grouping column). Always emitted by
   *  `summariseListRows`; optional for backward type compatibility. */
  level?: number;
  /** Group-by labels from the outermost level down to this group. */
  path?: string[];
}

/** Whole-result aggregates. */
export interface ListSummary {
  count: number;
  sums: Record<string, number>;
}

/**
 * One row of the `schedule` presentation (issue #1790 round 2) — a single
 * group-value tuple (a leaf group combination) carrying its Count and sums,
 * projected from the LEAF entries of `ListGroup[]` (see `toScheduleRows`).
 * Unlike `ListGroup`, a schedule row is never a parent: there is exactly one
 * row per distinct combination of group-by values, matching Bonsai's
 * "Building | Storey | Type | Count" schedule format.
 */
export interface ListScheduleRow {
  /** Collision-free key — `groupPathKey(path)`, matching the source `ListGroup.key`. */
  key: string;
  /** Group-by values, outermost first — one per active grouping level. */
  path: string[];
  /** Count aggregate: number of matched elements in this group combination. */
  count: number;
  /** columnId -> summed numeric value, for the configured sum columns. */
  sums: Record<string, number>;
}

export interface ListRow {
  /** Entity reference for 3D selection */
  entityId: number;
  modelId: string;
  /** Column values in same order as ListResult.columns */
  values: CellValue[];
}

export type CellValue = string | number | boolean | null;

// ============================================================================
// Column Discovery
// ============================================================================

/** Available columns discovered from the model */
export interface DiscoveredColumns {
  attributes: string[];
  properties: Map<string, string[]>; // psetName -> propNames[]
  quantities: Map<string, string[]>; // qsetName -> quantNames[]
}
