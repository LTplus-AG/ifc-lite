/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Download the per-element x per-zone table as CSV or Parquet (#2508 item 3).
 *
 * The gathering half of `lib/zones/table.ts`: which element, in which model,
 * under which name. The numbers come from `gatherZoneFacts`, which is the same
 * call `applyZoneWriteBack` makes, so the spreadsheet and the property sets can
 * disagree only if the user exported them at different times - never because
 * two code paths computed a volume differently.
 *
 * Parquet goes through `@ifc-lite/export`'s `columnsToParquet`, the same
 * Arrow-to-Parquet conversion `ParquetExporter` uses, rather than a second one
 * with its own type inference.
 */

import { useCallback } from 'react';
import { columnsToParquet, isParquet } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { resolveEntityRef, resolveGlobalId } from '@/store/resolveEntityRef';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import {
  toCsv,
  toColumns,
  zoneTableRows,
  ZONE_TABLE_FLOAT_COLUMNS,
  type ZoneTableRow,
  type ZoneTableElement,
  type VolumeBasis,
  type ZoneSet,
} from '@/lib/zones';
import { gatherZoneFacts } from './zoneFacts.js';

export type ZoneTableFormat = 'csv' | 'parquet';

export interface ZoneTableExportResult {
  rows: number;
  elements: number;
  /** Rows with no volume, each carrying its stated reason. Reported so a user
   *  is told the table is partial rather than discovering it by summing. */
  unmeasured: number;
  bytes: number;
  filename: string;
  blocked: 'no-members' | null;
}

/**
 * The element's own identity, through the columnar accessors the Lists engine
 * uses (`getName` / `getTypeName`), which are O(1) table reads rather than an
 * entity extraction per row.
 *
 * Missing pieces are left EMPTY rather than guessed: a wrong IfcType in a
 * column people filter on is worse than a blank one.
 */
function describeElement(globalId: number, modelNames: Map<string, string>): ZoneTableElement {
  const state = useViewerStore.getState();
  const ref = resolveEntityRef(globalId);
  const store = (ref.modelId === 'legacy'
    ? state.ifcDataStore
    : state.models.get(ref.modelId)?.ifcDataStore ?? null) as IfcDataStore | null;
  const entities = store?.entities;
  return {
    // The federated GlobalId resolver, so a re-imported table joins back to the
    // model on the one id that survives an export.
    globalId: resolveGlobalId(globalId) ?? entities?.getGlobalId?.(ref.expressId) ?? '',
    expressId: ref.expressId,
    modelName: modelNames.get(ref.modelId) ?? '',
    ifcType: entities?.getTypeName?.(ref.expressId) ?? '',
    name: entities?.getName?.(ref.expressId) ?? '',
  };
}

/** Build the table for one zone set. Exported for the test, which asserts on
 *  the rows rather than on a downloaded blob. */
export function buildZoneTable(zoneSet: ZoneSet, basis: VolumeBasis): ZoneTableRow[] {
  const state = useViewerStore.getState();
  const modelNames = new Map([...state.models].map(([id, model]) => [id, model.name ?? id]));
  const rows: ZoneTableRow[] = [];
  for (const row of gatherZoneFacts(zoneSet, basis)) {
    rows.push(...zoneTableRows(describeElement(row.globalId, modelNames), row.facts, zoneSet.name, basis));
  }
  return rows;
}

/** Build and download the table. */
export async function exportZoneTable(
  zoneSet: ZoneSet,
  basis: VolumeBasis,
  format: ZoneTableFormat,
  emit: (bytes: Uint8Array, filename: string, mime: string) => void = downloadFile,
): Promise<ZoneTableExportResult> {
  const rows = buildZoneTable(zoneSet, basis);
  const empty = { rows: 0, elements: 0, unmeasured: 0, bytes: 0, filename: '' };
  if (rows.length === 0) return { ...empty, blocked: 'no-members' };

  const bytes = format === 'csv'
    ? new TextEncoder().encode(toCsv(rows))
    : await columnsToParquet(toColumns(rows), new Set(ZONE_TABLE_FLOAT_COLUMNS));
  // `columnsToParquet` degrades to Arrow IPC when its wasm writer cannot load.
  // Those bytes are still useful, but a `.parquet` file that is not Parquet
  // opens in nothing, and the reader is told it is corrupt rather than that it
  // is a different format. So the EXTENSION follows the bytes.
  const extension = format === 'csv' ? 'csv' : (isParquet(bytes) ? 'parquet' : 'arrow');
  const filename = `${sanitizeFilename(`${zoneSet.name}-zone-quantities`)}.${extension}`;
  const mime = extension === 'csv'
    ? 'text/csv'
    : extension === 'parquet' ? 'application/vnd.apache.parquet' : 'application/vnd.apache.arrow.stream';
  emit(bytes, filename, mime);

  return {
    rows: rows.length,
    // By resolved identity rather than by GlobalId: `describeElement` leaves
    // the id EMPTY when neither resolver answers, and every such element would
    // otherwise share one bucket and be reported as one.
    elements: new Set(rows.map((row) => `${row.Model}#${row.ExpressId}`)).size,
    unmeasured: rows.filter((row) => row.VolumeM3 === null).length,
    bytes: bytes.byteLength,
    filename,
    blocked: null,
  };
}

export function useZoneTableExport() {
  const exportTable = useCallback(
    (zoneSet: ZoneSet, basis: VolumeBasis, format: ZoneTableFormat) =>
      exportZoneTable(zoneSet, basis, format),
    [],
  );
  return { exportTable };
}
