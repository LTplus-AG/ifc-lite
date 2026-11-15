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
  /** Easting in `crs` (LV95: ~2.4e6-2.9e6). Always the first coordinate, whatever order the service used. */
  x: number;
  /** Northing in `crs` (LV95: ~1.03e6-1.35e6). */
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

/**
 * Address and place search. Candidates carry `x` = easting and `y` =
 * northing in their `crs`, the same order every other method of this package
 * takes coordinates in (`parcelsAtPoint(x, y)`, bounding boxes).
 */
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
  /**
   * Every parcel whose geometry contains the point (overlapping rights can
   * yield several). `x` is the easting, `y` the northing; implementations
   * throw on arguments that are out of range or look swapped, rather than
   * answering with an empty list.
   */
  parcelsAtPoint(x: number, y: number, options?: { signal?: AbortSignal }): Promise<Parcel[]>;
}

/**
 * A regular elevation grid. Values are sampled at grid NODES:
 * `x = origin.x + col * resolution`, `y = origin.y - row * resolution`,
 * row-major from north to south. Missing data is `NaN`, never a substitute.
 *
 * A node that sits exactly on a corner of the source raster's pixels (pixel
 * centres lie half a pixel inside) is the bilinear mean of the four
 * surrounding pixels at the source resolution, equally weighted; a node on a
 * pixel centre reads that pixel. Spacing finer than the source is therefore
 * interpolation, not new information.
 *
 * A box wholly outside the provider's coverage is not an error: the grid has
 * the requested shape, every value is `NaN`, `hasData` is `false` and
 * `missingTiles` lists what was absent. Check `hasData` before using it.
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
  /** `false` when every value is `NaN` (`noDataCount === width * height`), e.g. a box outside coverage. */
  hasData: boolean;
  /**
   * Source rasters used, for provenance. `gsd` is the real resolution of the
   * raster level that was read, in metres: it can be coarser than `resolution`
   * (a 4 m overview for a 10 m request) and is never finer than the product
   * offers, so it states how much detail the values carry.
   */
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
  /**
   * Extent in the provider's projected CRS. When `extentApproximate` (always,
   * for swisstopo), it is derived from the item's WGS84 bbox through
   * swisstopo's approximate formulas, so it can be off by up to about 3 m.
   * Use it to pick tiles, not to measure.
   */
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
  /**
   * Number of `identify` queries issued, one per cell: the unit `maxRequests`
   * budgets. A query answered from the response cache counts here, and one
   * the client retried counts once; see `networkRequests` for what was sent.
   */
  requests: number;
  /** HTTP requests actually sent for this query: cache hits excluded, every retry included. */
  networkRequests: number;
  /**
   * Cells that still hit the service cap at the deepest split. Non-empty
   * means the result may be incomplete in those cells.
   */
  truncatedCells: BBox[];
  /**
   * The request budget (`maxRequests`) ran out before every cell was
   * queried. `features` holds what was collected, which is NOT complete;
   * `unqueriedCells` says where to look.
   */
  requestLimitReached: boolean;
  /** Cells never queried because the request budget ran out. */
  unqueriedCells: BBox[];
  /**
   * `true` when the result may be incomplete for any reason: a cell still
   * capped at the deepest split, or the request budget reached. Check this
   * before treating `features` as every feature in the area.
   */
  truncated: boolean;
  /**
   * Cells whose polygon was too long to send in a GET URL and were queried by
   * their bounding box instead, with `features` clipped to the polygon
   * afterwards. Empty when every cell was queried with the exact polygon.
   */
  bboxFallbackCells: BBox[];
  /**
   * Ids of features in `features` that could NOT be tested against the
   * polygon because the service returned no geometry for them, in a query
   * that used the bounding-box fallback. They are kept, not dropped, but may
   * lie outside the polygon. Empty when nothing was left unchecked.
   */
  unverifiedFeatureIds: string[];
}

export interface VectorFeatureProvider {
  features(
    layer: string,
    area: BBox | PolygonGeometry | MultiPolygonGeometry,
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
