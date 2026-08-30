/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared "which column holds the selection key" resolution for the Filter
 * tab's two independent consumers: `SearchModalFilter` (row click) and
 * `filterResultToSearchResults` (n/N vim-cycle stepping). Both used to
 * declare their own `SELECTION_COLUMNS` and their own resolution loop; one
 * iterated the priority list (first candidate PRESENT, wherever it sits in
 * `columns`), the other iterated `columns` itself (first column POSITION
 * that happens to be a key). With both `entity_id` and `express_id` present
 * as columns and `entity_id` positioned before `express_id`, the two
 * algorithms picked different columns — a row click and n/N-stepping the
 * same row could select two different elements. Exporting one constant and
 * one function makes that divergence structurally impossible instead of
 * merely aligned for now.
 */

/** Columns a filter row's selection key may appear under, in priority
 *  order — `express_id` wins over `entity_id` regardless of which comes
 *  first in a result's `columns` array. */
export const SELECTION_COLUMNS = ['express_id', 'entity_id'] as const;

/**
 * Resolve the selection-key column index from a result's `columns` array,
 * checking `SELECTION_COLUMNS` in priority order and returning the index of
 * the first candidate present — not the first column position that happens
 * to be a key. Returns -1 if none of `SELECTION_COLUMNS` appears.
 */
export function selectionKeyColumnIndex(columns: readonly string[]): number {
  for (const candidate of SELECTION_COLUMNS) {
    const i = columns.indexOf(candidate);
    if (i >= 0) return i;
  }
  return -1;
}
