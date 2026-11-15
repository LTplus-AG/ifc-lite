/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Provider-neutral contracts for site-context geodata.
 *
 * Nothing in this file is Swiss. A second provider (3DBAG for the
 * Netherlands, Overture buildings, Mapterhorn terrain, ...) implements the
 * same interfaces with its own CRS string. Every coordinate carries the CRS
 * it is expressed in; nothing here reprojects.
 */

/** An axis-aligned box in a projected CRS, in that CRS's units (metres). */
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A GeoJSON position: `[x, y]` or `[x, y, z]`. */
export type Position = number[];

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: Position[][];
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}

/** GeoJSON geometry, as returned by the services (coordinates in `crs`). */
export type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | PolygonGeometry
  | MultiPolygonGeometry;

/**
 * The attribution a UI must show next to data from a dataset, plus the terms
 * it was read from. `restrictions` lists anything the terms forbid or require
 * beyond naming the source.
 */
export interface Attribution {
  /** Stable dataset key, e.g. `swissalti3d`. */
  datasetId: string;
  /** The text to display, e.g. `© swisstopo`. */
  text: string;
  /** Short licence label as the data owner states it. */
  licence: string;
  /** Where the terms were read. */
  termsUrl: string;
  /** Use restrictions or obligations beyond attribution; empty when none were found. */
  restrictions: string[];
  /** ISO date the terms were last read, or `null` when they could not be read. */
  termsVerifiedOn: string | null;
}

/** Anything fetched carries the CRS of its coordinates and its attribution. */
export interface Sourced {
  crs: string;
  attribution: Attribution[];
}

export interface GeocodeCandidate {
  label: string;
  x: number;
  y: number;
  crs: string;
  /** Provider-specific origin, e.g. `address`, `parcel`, `gg25`. */
  origin: string;
  /** Provider ranking weight; higher is better. Only comparable within one response. */
  weight: number;
  featureId: string | null;
}

export interface GeocodeResult extends Sourced {
  candidates: GeocodeCandidate[];
}

export interface Geocoder {
  geocode(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<GeocodeResult>;
}

export interface Parcel extends Sourced {
  /** National parcel identifier (EGRID in Switzerland). */
  id: string;
  /** Parcel number within its municipality / cadastral district. */
  number: string | null;
  /** First-level administrative unit (canton code in Switzerland). */
  region: string | null;
  geometry: PolygonGeometry | MultiPolygonGeometry;
  /**
   * Planar area of `geometry` in square CRS units, holes subtracted. This is
   * computed here; it is not the legal registered area.
   */
  computedArea: number;
  /** Service layer the geometry came from. */
  sourceLayer: string;
  /** Provider-specific attributes, verbatim. */
  properties: Record<string, unknown>;
}

export interface ParcelProvider {
  parcelById(id: string, options?: { signal?: AbortSignal }): Promise<Parcel | null>;
  /** Every parcel whose geometry contains the point (overlapping rights can yield several). */
  parcelsAtPoint(x: number, y: number, options?: { signal?: AbortSignal }): Promise<Parcel[]>;
}

/**
 * A regular elevation grid. Values are sampled at grid NODES:
 * `x = origin.x + col * resolution`, `y = origin.y - row * resolution`,
 * row-major from north to south. Missing data is `NaN`, never a substitute.
 */
export interface ElevationGrid extends Sourced {
  /** The CRS of the heights, e.g. `EPSG:5728` (LN02). */
  verticalCrs: string;
  /** Human-readable vertical reference, quoted from the product documentation. */
  verticalReference: string;
  origin: { x: number; y: number };
  resolution: number;
  width: number;
  height: number;
  values: Float32Array;
  /** Number of `NaN` cells. Non-zero means part of the box has no data. */
  noDataCount: number;
  /** Source rasters used, for provenance. */
  sources: Array<{ id: string; url: string; acquired: string | null; gsd: number }>;
  /** Tiles the box needs that the provider does not have. */
  missingTiles: string[];
}

export interface TerrainProvider {
  elevationGrid(
    bbox: BBox,
    options: { resolution: number; signal?: AbortSignal },
  ): Promise<ElevationGrid>;
}

/** A downloadable building-model asset. Parsing it is the caller's job. */
export interface BuildingAsset {
  tileId: string;
  url: string;
  /** File format, e.g. `citygml`, `dwg`, `gdb`. */
  format: string;
  mediaType: string;
  /** Bytes, when the provider states it; `null` otherwise. */
  size: number | null;
  /** Extent in the provider's projected CRS. Approximate when `extentApproximate`. */
  extent: BBox;
  extentApproximate: boolean;
  acquired: string | null;
  crs: string;
  verticalCrs: string | null;
}

export interface BuildingTileResult extends Sourced {
  assets: BuildingAsset[];
}

export interface BuildingTileProvider {
  buildingTiles(
    bbox: BBox,
    options?: { formats?: string[]; signal?: AbortSignal },
  ): Promise<BuildingTileResult>;
}

export interface Feature {
  id: string;
  layer: string;
  geometry: Geometry | null;
  properties: Record<string, unknown>;
}

export interface FeatureQueryResult extends Sourced {
  features: Feature[];
  /** Number of HTTP requests the query took. */
  requests: number;
  /**
   * Cells that still hit the service cap at the deepest split. Non-empty
   * means the result may be incomplete in those cells.
   */
  truncatedCells: BBox[];
}

export interface VectorFeatureProvider {
  features(
    layer: string,
    area: BBox | PolygonGeometry,
    options?: { signal?: AbortSignal },
  ): Promise<FeatureQueryResult>;
}

export type MapServiceDescriptor =
  | {
      type: 'WMTS';
      /** Template with `{TileMatrix}`, `{TileCol}`, `{TileRow}` placeholders. */
      urlTemplate: string;
      tileMatrixSet: string;
      crs: string;
      format: string;
      capabilitiesUrl: string;
    }
  | {
      type: 'WMS';
      url: string;
      version: string;
      layers: string;
      crs: string[];
      format: string;
      capabilitiesUrl: string;
    };

export interface MapLayerDescriptor {
  id: string;
  title: string;
  kind: 'imagery' | 'basemap' | 'hazard';
  services: MapServiceDescriptor[];
  attribution: Attribution;
}
