/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type {
  Attribution,
  BBox,
  BuildingAsset,
  BuildingTileProvider,
  BuildingTileResult,
  ElevationGrid,
  Feature,
  FeatureQueryResult,
  GeocodeCandidate,
  GeocodeResult,
  Geocoder,
  Geometry,
  MapLayerDescriptor,
  MapServiceDescriptor,
  MultiPolygonGeometry,
  Parcel,
  ParcelProvider,
  PolygonGeometry,
  Position,
  Sourced,
  TerrainProvider,
  VectorFeatureProvider,
} from './contracts.js';

export { createSwissGeodata, type SwissGeodata, type SwissGeodataOptions } from './provider.js';
export { HttpError, type CachedResponse, type FetchLike, type ResponseCache } from './http.js';
export type { GeocodeOptions, SearchOrigin } from './geocode.js';
export type { SwissParcel } from './parcel.js';
export { SWISSALTI3D_VERTICAL_REFERENCE, type TerrainOptions } from './terrain.js';
export type { BuildingTileOptions } from './buildings.js';
export { VECTOR_LAYERS, type FeatureQueryOptions } from './vector.js';
export type { OerebExtractRef, OerebFormat } from './oereb.js';
export { CANTON_OEREB_SERVICES, type CantonOerebService } from './oereb-cantons.js';
export { DATASETS, attributionFor, type DatasetId } from './attribution.js';
export { lv95ToWgs84Approx, wgs84ToLv95Approx, paddedWgs84BBox } from './lv95.js';
