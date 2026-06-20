/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CSV export helper — produced in Rust (`ifc-lite-export`) from the model's source
 * bytes. Replaces the per-call-site `new CSVExporter(store).export*()` usage.
 */

import { GeometryProcessor } from '@ifc-lite/geometry';

export type CsvMode = 'entities' | 'properties' | 'quantities' | 'spatial';

export interface CsvExportOptions {
  includeProperties?: boolean;
  delimiter?: string;
}

/** Export a CSV view from raw IFC bytes via the Rust pipeline. */
export async function exportCsvFromBytes(
  bytes: Uint8Array,
  mode: CsvMode,
  opts: CsvExportOptions = {},
): Promise<string> {
  const gp = new GeometryProcessor();
  await gp.init();
  try {
    const csv = gp.exportCsv(bytes, mode, opts.delimiter ?? ',', opts.includeProperties ?? false);
    if (csv == null) throw new Error('CSV export returned no data');
    return csv;
  } finally {
    gp.dispose();
  }
}
