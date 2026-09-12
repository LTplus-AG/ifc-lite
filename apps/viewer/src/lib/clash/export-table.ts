/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The current clash run as a CSV table — one row per clash with both
 * elements' GlobalIds, the coordinator's review state and the storey — for
 * Power BI / Excel (#3944).
 *
 * Exports the WHOLE run (after exclusions), not the panel's current view: the
 * review-status and "hide touching" filters are for reading the list in the
 * viewer, while a BI reader filters in their own tool and needs every row —
 * including the resolved ones — to chart a status distribution.
 *
 * The clash result carries a model ID and no storey (`ClashElementRef` drops
 * the storey the adapter saw), so both are resolved here from the loaded
 * federation: `resolveGlobalIdInModel` turns the element's renderer id back
 * into a local express id, and that model's spatial hierarchy names the storey.
 * An element whose model is gone since the run leaves the storey empty.
 */
import { CLASH_TABLE_COLUMNS, clashTableRows, type ClashElementRef, type ClashTableRow } from '@ifc-lite/clash';
import { tableToCsv } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';

export interface ClashTableExportResult {
  rows: number;
  filename: string;
}

/** Build the rows from the store. Exported for the test, which asserts on the
 *  rows rather than on a downloaded blob. */
export function buildClashTable(): ClashTableRow[] | null {
  const state = useViewerStore.getState();
  const result = state.clashResult;
  if (!result) return null;

  const storeyOf = (ref: ClashElementRef): string | undefined => {
    const hit = state.resolveGlobalIdInModel(ref.model, ref.ref);
    if (!hit) return undefined;
    const store = state.models.get(hit.modelId)?.ifcDataStore;
    const storeyId = store?.spatialHierarchy?.elementToStorey.get(hit.expressId);
    if (!storeyId) return undefined;
    return store?.entities.getName(storeyId) || undefined;
  };
  const modelNameOf = (modelId: string): string | undefined => state.models.get(modelId)?.name;

  return clashTableRows(result.clashes, {
    reviews: state.clashReviews,
    storeyOf,
    modelNameOf,
    groups: state.clashGroups ?? undefined,
  });
}

/** Build and download the table as CSV. */
export function exportClashTableCsv(
  emit: (content: string, filename: string, mime: string) => void = downloadFile,
): ClashTableExportResult | null {
  const rows = buildClashTable();
  if (!rows) return null;
  const state = useViewerStore.getState();
  const modelName = state.activeModelId ? state.models.get(state.activeModelId)?.name : undefined;
  const base = modelName ? `${modelName.replace(/\.[^.]+$/, '')}-clashes` : 'clashes';
  const filename = `${sanitizeFilename(base)}.csv`;
  emit(tableToCsv(CLASH_TABLE_COLUMNS, rows), filename, 'text/csv');
  return { rows: rows.length, filename };
}
