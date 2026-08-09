/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helper for the Filter tab's "Isolate in 3D" action.
 *
 * Turns a filter result table into the deduplicated list of renderer
 * global IDs to isolate, so the React handler in `SearchModal.filter.tsx`
 * stays a thin wrapper around store setters (matching `handleCreateList`'s
 * row-scanning shape, but resolving each row through `toGlobalId` instead
 * of grouping by model). Kept in `lib/search` — not the component file —
 * because `SearchModalFilter` reads the store directly and cannot be
 * mounted under `tsx --test` (see the wiring test for the ordering
 * contract this feeds into).
 */

export interface FilterResultLike {
  columns: string[];
  rows: unknown[][];
}

/**
 * Resolve every row of a filter result to a renderer global ID, in row
 * order, de-duplicated. Rows with a non-positive or non-numeric
 * `express_id` are skipped (mirrors `handleCreateList`'s guard). Federated
 * results carry a `model_id` column per row; single-model results fall
 * back to `defaultModelId`.
 */
export function collectFilterResultGlobalIds(
  result: FilterResultLike,
  defaultModelId: string,
  toGlobalId: (modelId: string, expressId: number) => number,
): number[] {
  const idIdx = result.columns.indexOf('express_id');
  if (idIdx < 0) return [];
  const modelIdx = result.columns.indexOf('model_id'); // only present for multi-model runs

  const globalIds: number[] = [];
  const seen = new Set<number>();
  for (const row of result.rows) {
    const id = Number(row[idIdx]);
    if (!Number.isFinite(id) || id <= 0) continue;
    const modelId = modelIdx >= 0 && typeof row[modelIdx] === 'string'
      ? (row[modelIdx] as string)
      : defaultModelId;
    const globalId = toGlobalId(modelId, id);
    if (seen.has(globalId)) continue;
    seen.add(globalId);
    globalIds.push(globalId);
  }
  return globalIds;
}
