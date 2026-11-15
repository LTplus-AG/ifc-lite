/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Country-neutral interfaces: a hazard provider returns a classified raster,
 * a terrain source returns heights, and both name their coordinate reference.
 * Nothing here knows about Switzerland; `bafu/` is one implementation.
 */

/** A text in the languages a disclaimer has to be shown in. */
export interface LocalizedText {
  de: string;
  en: string;
}

/** A point in a projected map CRS: easting `x`, northing `y`, in metres. */
export interface MapPoint {
  x: number;
  y: number;
}

/** An axis-aligned box in a projected map CRS, in metres. */
export interface MapBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * One class of a hazard map. Depth classes are half-open intervals
 * `(lowerBound, upperBound]` of water depth above terrain, in metres; an
 * open-ended class has `upperBound: null`.
 */
export interface HazardClassDefinition {
  /** Stable identifier, used in results and property sets. */
  id: string;
  /**
   * `depth`: a water-depth interval. `watercourse`: water is present but no
   * depth is mapped (treated as open-ended from zero). `excluded`: the area
   * was not modelled (for example glaciers), so nothing can be said there.
   */
  kind: 'depth' | 'watercourse' | 'excluded';
  /** Exclusive lower bound of the depth, metres. */
  lowerBound: number;
  /** Inclusive upper bound of the depth, metres; `null` when open-ended. */
  upperBound: number | null;
  label: LocalizedText;
}

/** Where a classified raster came from, and what must be shown with any result derived from it. */
export interface HazardProvenance {
  providerId: string;
  /** Machine name of the dataset, for example a WMS layer name. */
  datasetId: string;
  datasetTitle: LocalizedText;
  /** Reference date of the dataset itself (not of its metadata), ISO 8601. */
  datasetDate: string;
  /** When the dataset's published metadata was last updated, ISO 8601, when known. */
  metadataUpdated?: string;
  /** When this raster was retrieved (or first retrieved, when served from a cache), ISO 8601. */
  retrievedAt: string;
  /** The exact request the raster was decoded from. */
  requestUrl: string;
  /** The mandatory source reference: author, title, link. */
  attribution: string;
  licence: string;
  /** The return-period wording of the publisher, verbatim. */
  returnPeriod: LocalizedText;
  /** Stated limits a user must see with any result. */
  limits: readonly LocalizedText[];
  /** The publisher's own description of the dataset, verbatim. */
  disclaimer: LocalizedText;
}

/** Cell code for "no runoff mapped": the map is transparent there. */
export const CELL_NO_RUNOFF = 0;
/** Cell code for "cannot be read": an antialiased edge, translucent pixel, or outside the response. */
export const CELL_UNCLASSIFIED = 255;

/** How the cells of one raster decoded. */
export interface HazardCellCounts {
  total: number;
  /** Cells that carry one of the provider's classes. */
  classified: number;
  /** Fully transparent cells: no runoff mapped. */
  noRunoff: number;
  /** Opaque cells whose colour is no legend entry (antialiased blends between classes). */
  unclassifiedOpaque: number;
  /** Partly transparent cells (antialiased edges against "no runoff"). */
  unclassifiedTranslucent: number;
  /** Per class id. */
  byClass: Record<string, number>;
}

/**
 * A north-up classified raster. Cell `(col, row)` covers
 * `[origin.x + col*cellSize, origin.x + (col+1)*cellSize)` in x and
 * `(origin.y - (row+1)*cellSize, origin.y - row*cellSize]` in y: `origin` is
 * the top-left (north-west) corner.
 */
export interface ClassifiedHazardRaster {
  crs: string;
  width: number;
  height: number;
  cellSize: number;
  origin: MapPoint;
  /**
   * Row-major from the north row. {@link CELL_NO_RUNOFF}, {@link CELL_UNCLASSIFIED},
   * or `k` (1-based) for `classes[k - 1]`.
   */
  cells: Uint8Array;
  classes: readonly HazardClassDefinition[];
  counts: HazardCellCounts;
  provenance: HazardProvenance;
}

export interface HazardRasterRequest {
  /** The area to cover; providers may snap it outward to their cell grid. */
  bbox: MapBBox;
  /** Must equal the provider's CRS. */
  crs: string;
  /** Requested cell size in metres; the provider's default when omitted. */
  cellSize?: number;
  signal?: AbortSignal;
}

/** A source of classified hazard rasters in one projected CRS. */
export interface HazardProvider {
  readonly id: string;
  readonly crs: string;
  readonly classes: readonly HazardClassDefinition[];
  /** Area the dataset covers, in its CRS; requests outside it are refused. */
  readonly extent: MapBBox;
  /** Resolution of the underlying model raster, metres. */
  readonly modelCellSize: number;
  fetchRaster(request: HazardRasterRequest): Promise<ClassifiedHazardRaster>;
}

/** A north-up height grid. `heights[row * width + col]` is the height at the CENTRE of that cell; NaN is no data. */
export interface TerrainGrid {
  crs: string;
  verticalReference: string;
  width: number;
  height: number;
  cellSize: number;
  /** Top-left (north-west) corner of the grid. */
  origin: MapPoint;
  heights: Float32Array | Float64Array;
}

/**
 * Terrain heights, injected by the caller (for example a swissALTI3D client).
 * Provide at least one of `heightAt` and `grid`.
 */
export interface TerrainSource {
  readonly crs: string;
  /** The vertical reference frame of every height, for example `LN02`. */
  readonly verticalReference: string;
  /** 1-sigma vertical accuracy in metres, when the source states one. */
  readonly verticalAccuracy?: number;
  heightAt?(point: MapPoint, signal?: AbortSignal): number | null | Promise<number | null>;
  grid?(bbox: MapBBox, options: { resolution: number; signal?: AbortSignal }): Promise<TerrainGrid>;
}

/** The synchronous terrain view the pure check reads. */
export interface TerrainSampler {
  readonly crs: string;
  readonly verticalReference: string;
  heightAt(point: MapPoint): number | null;
}
