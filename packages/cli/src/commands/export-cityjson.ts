/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite export <file> --format cityjson|cityjsonseq`: the Rust CityJSON
 * 2.0 writer (`rust/export/src/cityjson/`) through the wasm engine.
 *
 * A whole-model format: buildings come from the spatial structure, so the
 * entity filters do not apply. A model without an `IfcBuilding` is refused
 * (`CITYJSON_REFUSED`) rather than written as an empty city model;
 * georeferencing that cannot be resolved is a warning, and the document is
 * then in local coordinates without a reference system.
 */

import { GeometryProcessor, cityJsonRefusalReason } from '@ifc-lite/geometry';
import { getFlag, hasFlag, fatal, writeOutput } from '../output.js';
import type { IfcDataStore } from '@ifc-lite/parser';

export async function exportCityJson(format: 'cityjson' | 'cityjsonseq', args: string[], store: IfcDataStore): Promise<void> {
  const scaleFlag = getFlag(args, '--scale');
  const scale = scaleFlag === undefined ? undefined : Number(scaleFlag);
  if (scale !== undefined && !(Number.isFinite(scale) && scale > 0 && scale <= 1)) {
    fatal(`Invalid --scale "${scaleFlag}": a grid step in output units, greater than 0 and at most 1 (default 0.001).`);
  }
  if (store.source.byteLength === 0) throw new Error('Export: the parsed model kept no source bytes');
  const bytes = store.source.materialize();
  const gp = new GeometryProcessor();
  await gp.init();
  try {
    let result;
    try {
      result = gp.exportCityJson(bytes, {
        scale,
        elementGeometry: !hasFlag(args, '--blocks-only'),
        sequence: format === 'cityjsonseq',
      });
    } catch (err) {
      const reason = cityJsonRefusalReason(err);
      if (reason !== null) fatal(`CityJSON export refused: ${reason}`);
      throw err;
    }
    if (result == null) fatal('CityJSON export failed (geometry pipeline not initialized)');
    for (const warning of result.warnings) process.stderr.write(`Warning: ${warning}\n`);
    await writeOutput(result.text, getFlag(args, '--out'));
    process.stderr.write(
      `CityJSON: ${result.buildings} building(s), ${result.cityObjects} city objects, ${result.vertices} vertices, ` +
        `${result.referenceSystem ?? 'local coordinates (no reference system)'}\n`,
    );
  } finally {
    gp.dispose();
  }
}
