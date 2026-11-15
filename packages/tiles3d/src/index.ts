/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/tiles3d: headless OGC 3D Tiles reader. Query a tileset for a WGS84
 * region and get per-feature meshes (float64, tileset root frame / ECEF) with
 * their batch table attributes and tile provenance. Node and browser.
 */

export {
  readTilesetRegion,
  type ReadTilesetRegionOptions,
  type RegionReadResult,
  type TileContentInfo,
} from './read.js';
export type { FeatureMesh, PrimitiveGroup } from './content/features.js';
export type { ContentKind } from './content/decode.js';
export { resetDracoDecoder, type DracoLoader, type DracoDecoderModule } from './content/draco.js';
export { DEFAULT_DECODE_LIMITS, type DecodeLimits, type ReaderIssueCode } from './limits.js';
export type { UrlPolicyOptions } from './url-policy.js';
export type { FetchLike, FetchResponseLike, TilesCache, FetchStats } from './fetcher.js';
export type { GeoRegion } from './volume.js';
export type { ReaderIssue, TileProvenance, Truncation, TraversalOptions } from './traverse.js';
export { ecefToGeodetic, geodeticToEcef, type Geodetic } from './geodesy.js';
export {
  readSwisstopoBuildings,
  swisstopoBuildingsTilesetUrl,
  swisstopoRelease,
  SWISSTOPO_BUILDINGS_TILESET_URL,
  SWISSTOPO_BUILDINGS_ATTRIBUTION,
  SWISSTOPO_TILE_CULL_MARGIN_METRES,
  SWISSTOPO_EXPECTED_COLUMNS,
  type SwissBuildingAttributes,
  type SwissBuildingFeature,
  type SwisstopoBuildingsResult,
} from './swisstopo.js';
