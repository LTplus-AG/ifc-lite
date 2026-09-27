/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a LandXML terrain model records about the imagery draped on it
 * (#5942). Viewer state, and provenance for the export — never a claim that
 * the LandXML contained it (mapping spec §15).
 */

import type { DrapeProjection } from './drape-projection.js';
import type { RasterPlacementKind } from './georaster.js';
import type { GeoRasterMime } from './read-raster.js';

export interface TerrainImageryDrape {
  /** The image file's name, or the tile source's label. */
  sourceName: string;
  /** `tiles` drapes are viewer-only and never exported (§15.2 item 7). */
  source: 'file' | 'tiles';
  placement: RasterPlacementKind;
  /** The image's declared CRS. */
  imageCrs: string;
  /** Where its CRS came from (GeoKeys, a `.prj`, the tile scheme). */
  imageCrsSource: string;
  /** The planar projection, expressed in the terrain's CRS (§15.3). */
  projection: DrapeProjection;
  /** True when the image was carried from another CRS into the terrain's. */
  reprojected: boolean;
  /** Distinct TIN vertices drawn, and how many the image covers. */
  totalVertices: number;
  coveredVertices: number;
  /** Ground sample distance as displayed (after any downsampling), terrain plan units. */
  displayedGsd: number;
  /** The terrain's undraped colour, drawn where the image does not reach (§15.4). */
  flatColour: [number, number, number];
  /** The renderer texture identity shared by every draped mesh of this model. */
  textureId: number;
  /** The image as supplied, for the export (§15.5). Absent for tiles. */
  image?: { bytes: Uint8Array; mime: GeoRasterMime; sha256: string };
}

/** The covered fraction the card and the export report (§15.3). */
export function coveredFraction(drape: Pick<TerrainImageryDrape, 'coveredVertices' | 'totalVertices'>): number {
  return drape.totalVertices > 0 ? drape.coveredVertices / drape.totalVertices : 0;
}
