/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC terrain → LandXML 1.2 (`IfcAPI.exportLandXmlTerrain`, #7600), split out
 * like `energy-export-bridge.ts` so `IfcLiteBridge` only forwards through its
 * `runExport` error wrapper. The producer, its contract and its refusals live
 * in Rust (`rust/export/src/landxml_terrain.rs`).
 */

import type { IfcAPI } from '@ifc-lite/wasm';

/** One `<Surface>` written to the document. */
export interface LandXmlTerrainSurface {
  /** Express id of the exported product. */
  productId: number;
  globalId: string | null;
  /** `Surface@name`, made unique within the document. */
  name: string;
  points: number;
  faces: number;
}

/** A LandXML 1.2 document and what it contains. */
export interface LandXmlTerrainExport {
  xml: string;
  /** `IfcProjectedCRS.Name` the coordinates are written in. */
  crsName: string;
  surfaces: LandXmlTerrainSurface[];
}

export function callExportLandXmlTerrain(
  api: IfcAPI,
  content: Uint8Array,
  productIds: Uint32Array,
  now: Date,
): LandXmlTerrainExport {
  // LandXML@date / @time are xs:date / xs:time; written in UTC.
  const stamp = now.toISOString();
  return JSON.parse(
    api.exportLandXmlTerrain(content, productIds, stamp.slice(0, 10), stamp.slice(11, 19)),
  ) as LandXmlTerrainExport;
}
