/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC → CityJSON 2.0 / CityJSONSeq. The writer, its mapping and its LoD
 * claims live in Rust (`rust/export/src/cityjson/`); it ships in the separate
 * export payload (`@ifc-lite/wasm/rhino`, loaded on first use like the .3dm
 * scene builder), never in the default geometry engine every viewer load
 * downloads.
 */

import { loadExportPayload } from './export-payload.js';
import { CITYJSON_REFUSED } from './export-errors.js';

export { CITYJSON_REFUSED, cityJsonRefusalReason } from './export-errors.js';

/** How the document is written; every field is optional. */
export interface CityJsonExportOptions {
  /** `transform.scale` in output units (the output CRS's unit; metres for a metric CRS or local output). Default `0.001`. */
  scale?: number;
  /** Write rooms and elements with their LoD3 IFC geometry. Default `true`; `false` keeps them as attribute-only objects. */
  elementGeometry?: boolean;
  /** Write CityJSONSeq (`.city.jsonl`): a `CityJSON` header line, then one `CityJSONFeature` per building. Default `false`. */
  sequence?: boolean;
}

/** A finished CityJSON export. */
export interface CityJsonExport {
  /** The CityJSON document, or the CityJSONSeq lines. */
  text: string;
  /** `metadata.referenceSystem` (an OGC EPSG URL), or `null` when the model is written in local coordinates. */
  referenceSystem: string | null;
  /** What the export assumed or could not do (e.g. why it is not georeferenced). */
  warnings: string[];
  buildings: number;
  cityObjects: number;
  vertices: number;
}

/**
 * Export `content` (raw IFC bytes) as CityJSON 2.0, or CityJSONSeq with
 * `sequence`. A model with no `IfcBuilding` rejects with `CITYJSON_REFUSED:`
 * (see `cityJsonRefusalReason`). Unresolvable georeferencing is not an error:
 * the result is in local coordinates and `warnings` says why. The whole
 * document is built in memory.
 */
export async function exportCityJson(content: Uint8Array, options: CityJsonExportOptions = {}): Promise<CityJsonExport> {
  // JSON has no NaN or Infinity: they would cross as `null`, which the
  // writer reads as "use the default", so refuse them here like Rust
  // refuses any other scale outside (0, 1].
  if (options.scale !== undefined && !Number.isFinite(options.scale)) {
    throw new Error(`${CITYJSON_REFUSED}: scale ${options.scale} is not in (0, 1]`);
  }
  const engine = await loadExportPayload();
  return engine.exportCityJson(content, JSON.stringify({
    scale: options.scale,
    elementGeometry: options.elementGeometry,
    sequence: options.sequence,
  }));
}
