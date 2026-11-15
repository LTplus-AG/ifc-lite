/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC → CityJSON 2.0 / CityJSONSeq (`IfcAPI.exportCityJson`), split out like
 * `landxml-terrain-export.ts` so `IfcLiteBridge` only forwards through its
 * `runExport` error wrapper. The producer, its mapping and its LoD claims live
 * in Rust (`rust/export/src/cityjson/`).
 */

import type { IfcAPI } from '@ifc-lite/wasm';

/** How the document is written; every field is optional. */
export interface CityJsonExportOptions {
  /** `transform.scale` in output units (metres for a metric CRS or local output). Default `0.001` (millimetres). */
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

export function callExportCityJson(api: IfcAPI, content: Uint8Array, options: CityJsonExportOptions): CityJsonExport {
  return api.exportCityJson(content, {
    scale: options.scale,
    elementGeometry: options.elementGeometry,
    sequence: options.sequence,
  });
}
