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

/** The slice of `GeometryProcessor` this helper drives — a test seam (see csv.test.ts). */
export type CsvProcessor = Pick<GeometryProcessor, 'init' | 'exportCsv' | 'dispose'>;

/**
 * Export a CSV view from raw IFC bytes via the Rust pipeline.
 *
 * `createProcessor` defaults to the real wasm processor; tests inject a stub.
 */
export async function exportCsvFromBytes(
  bytes: Uint8Array,
  mode: CsvMode,
  opts: CsvExportOptions = {},
  createProcessor: () => CsvProcessor = () => new GeometryProcessor(),
): Promise<string> {
  const gp = createProcessor();
  await gp.init();
  try {
    const csv = gp.exportCsv(bytes, mode, opts.delimiter ?? ',', opts.includeProperties ?? false);
    if (csv == null) throw new Error('CSV export returned no data');
    return csv;
  } finally {
    gp.dispose();
  }
}
