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
  /** On a result: when the reference response of its rendering check was fetched, when one was made. */
  renderingCheckedAt?: string;
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
  /**
   * Where the map has data: a sample outside it (or too near its perimeter)
   * reads `outside-coverage`, never "no runoff". Required, so a raster cannot
   * reach the check without it: providers attach their perimeter test, and a
   * raster known to lie wholly within the mapped area states `'everywhere'`.
   */
  covers: CoverageTest | 'everywhere';
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

/**
 * Whether a point lies inside the area a provider's map covers: `true` inside,
 * `false` outside, `null` within the stated tolerance of the perimeter (too
 * close to tell). Outside the perimeter a transparent pixel means "no data",
 * not "no runoff".
 */
export type CoverageTest = (point: MapPoint) => boolean | null;

/** The answer of a provider's rendering check (see {@link HazardProvider.confirmRendering}). */
export interface RenderingConfirmation {
  /** True when the reference request decoded to mapped classes as expected. */
  confirmed: boolean;
  /** The reference request. */
  requestUrl: string;
  /** What was found, in words. */
  detail: string;
  /**
   * ISO 8601 time the reference response was fetched from the service (the
   * attempt time when it failed). It vouches only for rasters fetched within
   * 5 minutes of it (`CONFIRMATION_MAX_AGE_MS`).
   */
  retrievedAt: string;
}

/** A source of classified hazard rasters in one projected CRS. */
export interface HazardProvider {
  readonly id: string;
  readonly crs: string;
  readonly classes: readonly HazardClassDefinition[];
  /** Box around the dataset, in its CRS; requests outside it are refused. */
  readonly extent: MapBBox;
  /** Resolution of the underlying model raster, metres. */
  readonly modelCellSize: number;
  /** The coverage perimeter, for information; the check reads the one each raster carries (`ClassifiedHazardRaster.covers`). */
  readonly covers?: CoverageTest;
  fetchRaster(request: HazardRasterRequest): Promise<ClassifiedHazardRaster>;
  /**
   * Request a small reference area where the map is known to show runoff and
   * say whether it does. Used when a whole raster comes back transparent, so a
   * layer outage or reprocessing is not read as "no runoff mapped".
   */
  confirmRendering?(signal?: AbortSignal): Promise<RenderingConfirmation>;
}

/**
 * A north-up height grid, field-compatible with `ElevationGrid` of
 * `@ifc-lite/geodata-ch` plus the required `sampling` convention:
 *
 * - `'node'`: `values[row * width + col]` is the height AT
 *   `(origin.x + col * resolution, origin.y - row * resolution)`; `origin` is
 *   the north-west node (the geodata-ch convention).
 * - `'cell-centre'`: it is the height at the CENTRE of the cell whose
 *   north-west corner is `(origin.x + col * resolution, origin.y - row * resolution)`;
 *   `origin` is the north-west corner of the grid (the GeoTIFF pixel-is-area convention).
 *
 * NaN is no data; `hasData: false` means the grid carries no heights at all.
 */
export interface TerrainGrid {
  crs: string;
  /** Vertical CRS of the heights as an EPSG identifier, for example `EPSG:5728` (LN02). Compared by code. */
  verticalCrs: string;
  /** Human-readable vertical reference, for display only; never compared. */
  verticalReference?: string;
  sampling: 'node' | 'cell-centre';
  width: number;
  height: number;
  resolution: number;
  origin: MapPoint;
  values: ArrayLike<number>;
  /** `false` when the grid carries no heights (for example a box outside coverage). Treated as all NaN. */
  hasData?: boolean;
}

/**
 * Other buildings' footprints around the checked one. The hazard model raised
 * EVERY building, so a transparent pixel inside another building (an
 * attached garage, a neighbour not in the model) means "not modelled", not
 * "no runoff". A transparent sample is open ground with no runoff mapped only
 * when such footprints are supplied, `complete` for the area, and the sample
 * lies outside every one of them.
 */
export interface OtherBuildingFootprints {
  /** Must equal the hazard map's CRS. */
  crs: string;
  /** Footprint rings in `crs`; a point inside any ring is inside another building. */
  rings: MapPoint[][];
  /**
   * The source lists every building in `extent`. Without that, transparency
   * outside its rings proves nothing; an invalid ring (fewer than 3 finite
   * points, no area, a repeated vertex, wholly outside `extent`) also voids it.
   */
  complete: boolean;
  /** The area the source covers, in `crs`: `complete` holds only inside it (an empty `rings` with an extent is open country). */
  extent: MapBBox;
  provenance: { source: string; date?: string; detail?: string };
}

/**
 * A source of {@link OtherBuildingFootprints} for an area, in the style of
 * {@link TerrainSource}. The answer covers the box asked for unless it states
 * its own `extent`.
 */
export interface BuildingFootprintSource {
  readonly crs: string;
  footprints(
    bbox: MapBBox,
    signal?: AbortSignal,
  ): Omit<OtherBuildingFootprints, 'extent'> & { extent?: MapBBox } | Promise<Omit<OtherBuildingFootprints, 'extent'> & { extent?: MapBBox }>;
}

/**
 * Terrain heights, injected by the caller (for example a swissALTI3D client).
 * Provide at least one of `heightAt` and `grid`.
 */
export interface TerrainSource {
  readonly crs: string;
  /** Vertical CRS of every height as an EPSG identifier, for example `EPSG:5728` (LN02). Compared by code. */
  readonly verticalCrs: string;
  /** Human-readable vertical reference, for display only. */
  readonly verticalReference?: string;
  /**
   * 1-sigma vertical accuracy in metres as the source states it. Without it
   * the check cannot size its clearance margin and never reports
   * `above-mapped-class-range`.
   */
  readonly verticalAccuracy?: number;
  heightAt?(point: MapPoint, signal?: AbortSignal): number | null | Promise<number | null>;
  grid?(bbox: MapBBox, options: { resolution: number; signal?: AbortSignal }): Promise<TerrainGrid>;
}

/** The synchronous terrain view the pure check reads. */
export interface TerrainSampler {
  readonly crs: string;
  /** EPSG identifier of the vertical CRS, for example `EPSG:5728`. */
  readonly verticalCrs: string;
  readonly verticalReference?: string;
  /** 1-sigma vertical accuracy in metres, when the source states one. */
  readonly verticalAccuracy?: number;
  heightAt(point: MapPoint): number | null;
}
