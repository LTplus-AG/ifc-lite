/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Swiss provider: every capability behind one HTTP client (one rate limit, one cache). */

import { buildingTiles, type BuildingTileOptions } from './buildings.js';
import type {
  BBox,
  BuildingTileProvider,
  BuildingTileResult,
  ElevationGrid,
  FeatureQueryResult,
  GeocodeResult,
  Geocoder,
  MapLayerDescriptor,
  MultiPolygonGeometry,
  ParcelProvider,
  PolygonGeometry,
  TerrainProvider,
  VectorFeatureProvider,
} from './contracts.js';
import { geocode, type GeocodeOptions } from './geocode.js';
import { HttpClient, type HttpOptions } from './http.js';
import { MAP_LAYERS } from './layers.js';
import { oerebExtractForEgrid, oerebExtractsAtPoint, type OerebExtractRef, type OerebExtractsAtPoint } from './oereb.js';
import { parcelByEgrid, parcelsAtPoint, type SwissParcel } from './parcel.js';
import { elevationGrid, type TerrainOptions } from './terrain.js';
import { featuresInArea, type FeatureQueryOptions } from './vector.js';

export interface SwissGeodata
  extends Geocoder,
    ParcelProvider,
    TerrainProvider,
    BuildingTileProvider,
    VectorFeatureProvider {
  readonly crs: 'EPSG:2056';
  geocode(query: string, options?: GeocodeOptions): Promise<GeocodeResult>;
  parcelById(egrid: string, options?: { signal?: AbortSignal }): Promise<SwissParcel | null>;
  parcelsAtPoint(x: number, y: number, options?: { signal?: AbortSignal }): Promise<SwissParcel[]>;
  elevationGrid(bbox: BBox, options: TerrainOptions): Promise<ElevationGrid>;
  buildingTiles(bbox: BBox, options?: BuildingTileOptions): Promise<BuildingTileResult>;
  features(layer: string, area: BBox | PolygonGeometry | MultiPolygonGeometry, options?: FeatureQueryOptions): Promise<FeatureQueryResult>;
  /** Where the parcel's ÖREB extract lives (register first, canton table as fallback). */
  oerebExtract(egrid: string, options?: { signal?: AbortSignal }): Promise<OerebExtractRef | null>;
  oerebExtractsAtPoint(x: number, y: number, options?: { signal?: AbortSignal }): Promise<OerebExtractsAtPoint>;
  /** Imagery, basemap and hazard layer descriptors. No network. */
  mapLayers(): readonly MapLayerDescriptor[];
  /** Network requests sent so far (cache hits excluded). */
  readonly requestCount: number;
}

export type SwissGeodataOptions = HttpOptions;

export function createSwissGeodata(options: SwissGeodataOptions = {}): SwissGeodata {
  const http = new HttpClient(options);
  return {
    crs: 'EPSG:2056',
    geocode: (q, o) => geocode(http, q, o),
    parcelById: (egrid, o) => parcelByEgrid(http, egrid, o),
    parcelsAtPoint: (x, y, o) => parcelsAtPoint(http, x, y, o),
    elevationGrid: (bbox, o) => elevationGrid(http, bbox, o),
    buildingTiles: (bbox, o) => buildingTiles(http, bbox, o),
    features: (layer, area, o) => featuresInArea(http, layer, area, o),
    oerebExtract: (egrid, o) => oerebExtractForEgrid(http, egrid, o),
    oerebExtractsAtPoint: (x, y, o) => oerebExtractsAtPoint(http, x, y, o),
    mapLayers: () => MAP_LAYERS,
    get requestCount() {
      return http.requestCount;
    },
  };
}
