/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helpers for the Filter tab's result table: turning rows into the
 * (model, expressId) pairs `handleCreateList` groups by, and further into
 * the deduplicated renderer global IDs `handleIsolateResult` isolates.
 * Both handlers in `SearchModal.filter.tsx` stay thin wrappers around store
 * setters. Kept in `lib/search` — not the component file — because
 * `SearchModalFilter` reads the store directly and cannot be mounted under
 * `tsx --test` the same way a pure unit can (see the wiring test for the
 * ordering contract this feeds into).
 */

import { collectAggregatedDescendants, type AggregationRelationships } from '../../utils/aggregation.js';

export interface FilterResultLike {
  columns: string[];
  rows: unknown[][];
}

/** One filter-result row, resolved to its source model. */
export interface FilterResultRow {
  modelId: string;
  expressId: number;
  /** The row's `type` column, when present (e.g. `IfcWall`). */
  ifcType: string | null;
}

/**
 * Scan a filter result table into deduplicated `(modelId, expressId)` rows,
 * in row order. Rows with a non-positive or non-numeric `express_id` are
 * skipped. Federated results carry a `model_id` column per row; single-model
 * results fall back to `defaultModelId`.
 *
 * Shared scan step for both `handleCreateList`'s per-model grouping and
 * `collectFilterResultGlobalIds`'s id resolution — the express_id guard, the
 * model_id column lookup and the dedup-by-key logic used to live twice
 * (#2532 review).
 */
export function scanFilterResultRows(
  result: FilterResultLike,
  defaultModelId: string,
): FilterResultRow[] {
  const idIdx = result.columns.indexOf('express_id');
  if (idIdx < 0) return [];
  const modelIdx = result.columns.indexOf('model_id'); // only present for multi-model runs
  const typeIdx = result.columns.indexOf('type');

  const out: FilterResultRow[] = [];
  const seen = new Set<string>();
  for (const row of result.rows) {
    const id = Number(row[idIdx]);
    if (!Number.isFinite(id) || id <= 0) continue;
    const modelId = modelIdx >= 0 && typeof row[modelIdx] === 'string'
      ? (row[modelIdx] as string)
      : defaultModelId;
    const key = `${modelId}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ifcType = typeIdx >= 0 && typeof row[typeIdx] === 'string' ? (row[typeIdx] as string) : null;
    out.push({ modelId, expressId: id, ifcType });
  }
  return out;
}

/**
 * Resolve every row of a filter result to a renderer global ID, in row
 * order, de-duplicated. `toGlobalId` may return `null` to skip a row —
 * e.g. a federated row whose source model is no longer loaded, where
 * falling back to the raw expressId would collide with another model's id
 * space (#2532 review) rather than isolating nothing.
 */
/** Per-model accessors `expandFilterRowsThroughAggregation` walks with. */
export interface FilterAggregationAccess {
  /** The model's `IfcRelAggregates` graph, when that model is loaded. */
  relationshipsFor(modelId: string): AggregationRelationships | undefined;
  /** Canonical type name (e.g. `IfcSpace`) of a model-local entity, if known. */
  typeNameFor(modelId: string, expressId: number): string | null;
  /** Model-local express id to renderer global id; `null` skips the id. */
  toGlobalId(modelId: string, expressId: number): number | null;
}

export interface FilterAggregationExpansion {
  /** Global ids of every aggregated descendant of the matched rows,
   *  deduplicated, in row order. */
  partGlobalIds: number[];
  /** Type names seen among those descendants (e.g. `IfcSpace`). */
  partTypes: Set<string>;
}

/**
 * Expand every matched row to its `IfcRelAggregates` descendants, straight
 * from the data store and blind to type visibility.
 *
 * `handleIsolateResult`'s primary expansion is the renderer-backed
 * `resolveHighlightIds`, but that resolver checks bounds against the
 * type-visibility-FILTERED mesh list (`ViewportContainer`'s
 * `filteredGeometry`), so an assembly whose only parts are currently hidden
 * types (IfcSpace, IfcOpeningElement, ...) resolves to nothing even though
 * it renders fine once those toggles flip. This is the fallback for exactly
 * that case: the descendants' global ids join the isolation set and their
 * type names feed the handler's type-visibility gate so the toggles do flip
 * (#2660 review). Descendants are NOT geometry-checked (that would need the
 * renderer this path exists to work without), so geometry-less intermediate
 * nodes ride along; the renderer ignores ids with no mesh, and
 * `frameEntities` guards degenerate bounds.
 */
export function expandFilterRowsThroughAggregation(
  result: FilterResultLike,
  defaultModelId: string,
  access: FilterAggregationAccess,
): FilterAggregationExpansion {
  const partGlobalIds: number[] = [];
  const partTypes = new Set<string>();
  const seen = new Set<number>();
  for (const row of scanFilterResultRows(result, defaultModelId)) {
    const relationships = access.relationshipsFor(row.modelId);
    if (!relationships) continue;
    for (const descendant of collectAggregatedDescendants(relationships, row.expressId)) {
      const globalId = access.toGlobalId(row.modelId, descendant);
      if (globalId === null || seen.has(globalId)) continue;
      seen.add(globalId);
      partGlobalIds.push(globalId);
      const typeName = access.typeNameFor(row.modelId, descendant);
      if (typeName) partTypes.add(typeName);
    }
  }
  return { partGlobalIds, partTypes };
}

export function collectFilterResultGlobalIds(
  result: FilterResultLike,
  defaultModelId: string,
  toGlobalId: (modelId: string, expressId: number) => number | null,
): number[] {
  const globalIds: number[] = [];
  const seen = new Set<number>();
  for (const row of scanFilterResultRows(result, defaultModelId)) {
    const globalId = toGlobalId(row.modelId, row.expressId);
    if (globalId === null) continue;
    if (seen.has(globalId)) continue;
    seen.add(globalId);
    globalIds.push(globalId);
  }
  return globalIds;
}
