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

/** How the document is written (#7618); every field is optional. */
export interface LandXmlTerrainExportOptions {
  /**
   * Default `'metre'`. `'usSurveyFoot'` writes elevations in international
   * feet: LandXML 1.2 has no US-survey-foot elevation unit, and both units are
   * declared in `<Units>`.
   */
  linearUnit?: 'metre' | 'internationalFoot' | 'usSurveyFoot';
  /** Decimal places in the written unit, 0 to 9. Default 6. */
  decimals?: number;
  /** `Surface@name` per product express id; a blank name keeps the IFC name. */
  surfaceNames?: Readonly<Record<number, string>>;
  /** Header stamp (`LandXML@date` / `@time`, written in UTC). Default now. */
  now?: Date;
}

export function callExportLandXmlTerrain(
  api: IfcAPI,
  content: Uint8Array,
  productIds: Uint32Array,
  options: LandXmlTerrainExportOptions,
): LandXmlTerrainExport {
  const stamp = (options.now ?? new Date()).toISOString();
  return JSON.parse(api.exportLandXmlTerrain(content, productIds, {
    date: stamp.slice(0, 10),
    time: stamp.slice(11, 19),
    linearUnit: options.linearUnit,
    decimals: options.decimals,
    surfaceNames: Object.entries(options.surfaceNames ?? {}).map(([productId, name]) => ({ productId: Number(productId), name })),
  })) as LandXmlTerrainExport;
}
