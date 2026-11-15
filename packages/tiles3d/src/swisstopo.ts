/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Preset for swisstopo's hosted swissBUILDINGS3D 3D Tiles
 * (https://docs.geo.admin.ch/visualize-data/3d-tiles.html). Open data: free
 * use with a mandatory source reference; excessive use may be restricted, so
 * keep request budgets small.
 *
 * Heights: measured tiles store Swiss LN02 heights in the slot 3D Tiles
 * reserves for WGS84 ellipsoidal height (see the package README). The reader
 * does not reinterpret them; convert in the caller with a CRS package.
 */

import { readTilesetRegion, type ReadTilesetRegionOptions, type RegionReadResult } from './read.js';
import type { FeatureMesh } from './content/features.js';
import type { TileProvenance } from './traverse.js';

export const SWISSTOPO_BUILDINGS_TILESET_URL = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json';

/** Source reference to display wherever this data is shown. */
export const SWISSTOPO_BUILDINGS_ATTRIBUTION = '© swisstopo (swissBUILDINGS3D)';

/** URL of a dated release (e.g. `20260520`) so a caller can pin the data version. */
export function swisstopoBuildingsTilesetUrl(release?: string): string {
  if (release === undefined) return SWISSTOPO_BUILDINGS_TILESET_URL;
  if (!/^\d{8}$/.test(release)) throw new RangeError('release must be a YYYYMMDD date string');
  return `https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/${release}/tileset.json`;
}

/** Dated release (YYYYMMDD) a tile came from, read from its tileset chain. */
export function swisstopoRelease(tile: TileProvenance): string | undefined {
  for (const url of [tile.url, ...tile.tilesetChain]) {
    const m = /\/v1\/(\d{8})\//.exec(url);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Batch table columns observed in swisstopo building tiles. Every one is
 * optional: presence varies between tiles, so check before use.
 */
export interface SwissBuildingAttributes {
  /** Federal building identifier (GWR), when the building is registered. */
  EGID?: number | string;
  UUID?: string;
  /** Object type, e.g. "Gebaeude Einzelhaus". */
  OBJEKTART?: string;
  /** Terrain height at the building (LN02 metres). */
  GELAENDEPUNKT?: number;
  DACH_MIN?: number;
  DACH_MAX?: number;
  GESAMTHOEHE?: number;
  Height?: number;
  'gml:id'?: string;
  DATUM_ERSTELLUNG?: string;
  [column: string]: unknown;
}

export type SwissBuildingFeature = FeatureMesh & { attributes: SwissBuildingAttributes };

export interface SwisstopoBuildingsResult extends RegionReadResult {
  features: SwissBuildingFeature[];
  attribution: string;
}

/**
 * Margin the preset culls tiles with. Leaf tiles hold every building whose
 * centre falls inside them, and buildings overhang their tile region by up to
 * 84 m in measured tiles (Zurich main station), so a smaller margin can miss a
 * building that reaches into the query region.
 */
export const SWISSTOPO_TILE_CULL_MARGIN_METRES = 100;

/** Read swisstopo buildings in a WGS84 region with conservative default budgets. */
export async function readSwisstopoBuildings(
  options: Omit<ReadTilesetRegionOptions, 'url'> & { release?: string },
): Promise<SwisstopoBuildingsResult> {
  const { release, ...rest } = options;
  const result = await readTilesetRegion({
    maxRequests: 64,
    maxBytes: 32 * 1024 * 1024,
    tileCullMarginMetres: SWISSTOPO_TILE_CULL_MARGIN_METRES,
    ...rest,
    url: swisstopoBuildingsTilesetUrl(release),
  });
  return { ...result, features: result.features as SwissBuildingFeature[], attribution: SWISSTOPO_BUILDINGS_ATTRIBUTION };
}
