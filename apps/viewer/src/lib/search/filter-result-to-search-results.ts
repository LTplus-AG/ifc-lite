/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridges the advanced Filter tab's tabular result (`unknown[][]` rows +
 * `columns: string[]`, see `SearchFilterResult` in `store/slices/searchSlice.ts`)
 * into the `SearchResult[]` shape the vim-cycle machinery expects
 * (`enterVimCycle`, `stepVimCycle`, and the `n`/`N` stepping consumer in
 * `SearchInline.tsx`'s `applySelection`).
 *
 * Deliberately the SMALL bridge: convert at commit time rather than
 * generalising `SearchVimCycleState` to a `{modelId, expressId}` shape.
 * `applySelection` (the only place that reads cycle results while
 * stepping) touches nothing but `modelId` / `expressId`; the hint badge
 * (`VimCycleHint`) shows only `query` / `index` / `total`. So the extra
 * `SearchResult` fields are populated from the filter's own `name` /
 * `type` / `global_id` columns when present (all three are always emitted
 * by `SearchModalFilter`'s `runFilter`), never fabricated, and never
 * consumed by the cycle-stepping path itself. This keeps the Search tab's
 * cycle — which still stores real scored results — untouched.
 */

import type { SearchResult, MatchField } from './tier0-scan.js';

/** Columns a filter row's selection key may appear under (kept in sync
 *  with `SearchModalFilter`'s own `SELECTION_COLUMNS`). */
const SELECTION_COLUMNS: readonly string[] = ['express_id', 'entity_id'];

/** Placeholder — the cycle-stepping path never reads `matchField` /
 *  `score`; only `modelId` / `expressId` drive selection + framing. */
const PLACEHOLDER_MATCH_FIELD: MatchField = 'name';

/**
 * Convert a Filter-tab result table into `SearchResult[]` for
 * `enterVimCycle`. Rows whose selection-key cell isn't a positive integer
 * are skipped (nothing to select). In a federated (multi-model) result the
 * `model_id` column resolves each row's model; in a single-model result
 * (no `model_id` column) every row falls back to `fallbackModelId` — pass
 * `null` there and rows are skipped when it's absent, rather than guessed.
 *
 * Returns `[]` (never throws) if the result has no recognised selection-key
 * column — mirrors `SearchModalFilter`'s own `selectionKeyIndex < 0` guard.
 */
export function filterResultToSearchResults(
  result: { columns: string[]; rows: unknown[][] },
  fallbackModelId: string | null,
): SearchResult[] {
  const { columns, rows } = result;
  const keyIdx = columns.findIndex((c) => SELECTION_COLUMNS.includes(c));
  if (keyIdx < 0) return [];

  const modelIdx = columns.indexOf('model_id');
  const globalIdIdx = columns.indexOf('global_id');
  const nameIdx = columns.indexOf('name');
  const typeIdx = columns.indexOf('type');

  const out: SearchResult[] = [];
  for (const row of rows) {
    const raw = row[keyIdx];
    const expressId = typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw)
        : null;
    // Express ids are Uint32Array-backed (`compact-entity-index.ts`), so
    // they are always positive integers. `Number.isInteger` rejects NaN,
    // +/-Infinity, and fractions in one guard (Infinity, unlike NaN,
    // satisfies `> 0` so a NaN-only check would let it through).
    if (expressId === null || !Number.isInteger(expressId) || expressId <= 0) continue;

    const modelId = modelIdx >= 0 && typeof row[modelIdx] === 'string'
      ? (row[modelIdx] as string)
      : fallbackModelId;
    if (!modelId) continue;

    out.push({
      modelId,
      expressId,
      typeName: typeIdx >= 0 ? String(row[typeIdx] ?? '') : '',
      name: nameIdx >= 0 ? String(row[nameIdx] ?? '') : '',
      globalId: globalIdIdx >= 0 ? String(row[globalIdIdx] ?? '') : '',
      description: '',
      objectType: '',
      matchField: PLACEHOLDER_MATCH_FIELD,
      score: 0,
    });
  }
  return out;
}
