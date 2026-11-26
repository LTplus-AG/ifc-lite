/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { GeometryProcessor } from '@ifc-lite/geometry';

/** Export a complete STEP model as a Ladybug Tools document. */
export async function exportEnergyArtifact(
  format: 'HBJSON' | 'DFJSON',
  bytes: Uint8Array,
  name: string,
): Promise<{ text: string; warnings: string[] }> {
  if (bytes.length === 0) {
    throw new Error(`${format} export needs the source IFC bytes, which this store did not retain.`);
  }
  const processor = new GeometryProcessor();
  try {
    await processor.init();
    if (format === 'DFJSON') {
      const text = processor.exportDfjson(bytes, name);
      if (text === null) throw new Error('Geometry engine unavailable for DFJSON export.');
      return { text, warnings: [] };
    }
    const result = processor.exportHbjsonWithStats(bytes, name);
    if (result === null) throw new Error('Geometry engine unavailable for HBJSON export.');
    const { content, stats } = result;
    const warnings = stats.skipped > 0
      ? [`HBJSON export: ${stats.skipped} of ${stats.spaces} IfcSpace skipped as degenerate ` +
          `(malformed footprint / holes / non-extrusion); ${stats.rooms} rooms written.`]
      : [];
    return { text: new TextDecoder().decode(content), warnings };
  } finally {
    processor.dispose();
  }
}
