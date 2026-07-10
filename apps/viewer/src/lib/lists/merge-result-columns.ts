/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Merge the per-column `quantityType`/`dataType` that `executeList` resolves
 * (execution-time only, see `ColumnDefinition` in `@ifc-lite/lists`) across a
 * federation's per-model results (P0 fix, issue #1573 follow-up).
 *
 * `ListPanel` executes a list once per loaded model and flattens the rows,
 * but was passing the *authoring* `definition.columns` - which never carry
 * `quantityType`/`dataType` - to `setListResult`, silently discarding the
 * annotation each `executeList` call had just resolved. That left the list
 * export's unit-conversion filter (`ColumnDefinition.quantityType !==
 * undefined || dataType`) matching nothing, so #1580's conversion never ran
 * in the live app despite passing tests (the tests fed the annotation in by
 * hand instead of going through `executeList`).
 */

import type { ColumnDefinition, ListResult } from '@ifc-lite/lists';

/**
 * For each column index, use the first `parts` entry whose column carries a
 * `quantityType` or `dataType` (first-defined-wins across models — the same
 * measure/quantity column resolves identically regardless of which model
 * happened to populate it first). Falls back to `base` untouched when no
 * part has anything for that column. Never mutates `base` or any part.
 */
export function mergeResultColumns(parts: ListResult[], base: ColumnDefinition[]): ColumnDefinition[] {
  if (parts.length === 0) return base;

  let changed = false;
  const merged = base.map((col, i) => {
    for (const part of parts) {
      const partCol = part.columns[i];
      if (partCol && (partCol.quantityType !== undefined || partCol.dataType !== undefined)) {
        if (partCol.quantityType === col.quantityType && partCol.dataType === col.dataType) return col;
        changed = true;
        return { ...col, quantityType: partCol.quantityType, dataType: partCol.dataType };
      }
    }
    return col;
  });

  return changed ? merged : base;
}
