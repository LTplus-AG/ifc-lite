/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The site-context document: what `buildSiteContext` returns, what
 * `encodeSiteContextGlb` writes and `decodeSiteContextGlb` reads back.
 *
 * Frame. Every position is in a local site frame whose origin
 * `[E0, N0, H0]` is stated in EPSG:2056 (LV95) and EPSG:5728 (LN02 heights),
 * with identity axes and scale 1: local x is east, y is north, z is up, in
 * metres. Each feature carries its own f64 origin in the same CRS; its mesh
 * positions are float32 offsets from that origin. A point's EPSG:2056
 * coordinate is `feature.origin + position`, evaluated in f64.
 */

import type { Attribution, SwissGeodata } from '@ifc-lite/geodata-ch';
import type { FetchLike, readSwisstopoBuildings, TilesCache } from '@ifc-lite/tiles3d';

/** The layers a site context can hold. */
export type SiteContextLayerKind = 'terrain' | 'parcel' | 'buildings';

/** A JSON value: what feature attributes and provenance are made of. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** An EPSG:2056 point, easting first. */
export interface MapPoint {
  x: number;
  y: number;
}

/**
 * A triangle mesh in a feature's local frame (x east, y north, z up, metres
 * from the feature origin). `normals` has one unit vector per vertex; `uvs`
 * one pair per vertex when present.
 */
export interface SiteContextMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  indices: Uint32Array;
  /**
   * Named triangle ranges a consumer may style differently, e.g. a
   * neighbouring building's `roof` and `wall`. Ranges are contiguous, in
   * order, and together cover `indices` exactly. Absent: one undivided mesh.
   */
  parts?: SiteContextMeshPart[];
}

/** A contiguous range of a mesh's `indices` (3 per triangle). */
export interface SiteContextMeshPart {
  /** `roof` or `wall` for buildings. */
  name: string;
  firstIndex: number;
  indexCount: number;
}

export interface SiteContextFeature {
  /** Stable within a document, e.g. `terrain:chunk:r0c1`, `parcel:CH1234…`. */
  id: string;
  /** The IFC entity a writer should emit for it (`IfcGeographicElement`, `IfcSite`). */
  ifcType: string;
  name: string;
  /** Feature origin `[E, N, H]` in EPSG:2056 / EPSG:5728, f64. */
  origin: [number, number, number];
  /** `null` when the feature carries data but no geometry could be built honestly (see the layer's issues). */
  mesh: SiteContextMesh | null;
  attributes: { [key: string]: JsonValue };
  provenance: { [key: string]: JsonValue };
  /**
   * `true` on the neighbouring building that is the model's own building
   * (see `BuildSiteContextOptions.subject`). It is kept in the document; a
   * viewer decides whether to hide it. Absent on every other feature.
   */
  subject?: true;
}

export type SiteContextIssueSeverity = 'info' | 'warning' | 'error';

/** Something a consumer must be able to show: missing data, an unverified licence, a failed lookup. */
export interface SiteContextIssue {
  /** Stable machine code, e.g. `terrain-nodata-cells`, `parcel-terms-unverified`. */
  code: string;
  severity: SiteContextIssueSeverity;
  message: string;
  /** A count the message is about (dropped cells, missing tiles), when there is one. */
  count?: number;
}

export interface SiteContextLayer {
  kind: SiteContextLayerKind;
  features: SiteContextFeature[];
  /** What the data owners require to be shown next to this layer, verbatim from `@ifc-lite/geodata-ch`. */
  attribution: Attribution[];
  issues: SiteContextIssue[];
  /** `false` when the layer could not be built in full; `issues` says why. */
  complete: boolean;
  /** How the layer was read (source, release, requests, bytes, caps, subject match), when the layer records it. */
  provenance?: { [key: string]: JsonValue };
}

export interface SiteContextDocument {
  crs: 'EPSG:2056';
  verticalCrs: 'EPSG:5728';
  /**
   * Origin of the local site frame `[E0, N0, H0]`; whole metres. H0 is the terrain height at
   * the centre only when `originHeight.terrainHeight` says so; without terrain it is 0, a pure
   * frame offset and not a height.
   */
  origin: [number, number, number];
  /**
   * What H0 is. `terrainHeight`: the swissALTI3D height at the centre (nearest node, else the
   * grid mean), or `null` when none was read (buildings only, or the grid failed), with `reason`.
   * Absent in files written before it existed.
   */
  originHeight?: SiteContextOriginHeight;
  layers: SiteContextLayer[];
}

export interface SiteContextOriginHeight {
  terrainHeight: number | null;
  /** Why there is no terrain height; set exactly when `terrainHeight` is `null`. */
  reason?: string;
}

/** The part of the `SwissGeodata` client the build uses. A `SwissGeodata` satisfies it. */
export type SiteContextGeodata = Pick<SwissGeodata, 'elevationGrid' | 'parcelById' | 'parcelsAtPoint' | 'oerebExtract'> & {
  readonly requestCount?: number;
};

export interface SiteContextProgress {
  stage: 'terrain-grid' | 'terrain-mesh' | 'parcel' | 'oereb' | 'buildings' | 'done';
  message: string;
}

export interface BuildSiteContextOptions {
  /** Centre of the site in EPSG:2056. */
  centre: MapPoint;
  /** Half the side of the square site, in metres. */
  radius: number;
  layers: SiteContextLayerKind[];
  /** Terrain node spacing in metres, or `'auto'` (the default; see `autoResolution`). */
  resolution?: number | 'auto';
  /**
   * The building the context is for. `footprint` (EPSG:2056 rings) moves the
   * parcel lookup to its centroid; `egrid` takes the parcel by its EGRID
   * instead of by point. In the buildings layer, the neighbour whose `EGID`
   * equals `egid` is marked `subject: true`; without an EGID match, the one
   * whose footprint overlaps `footprint` most (at least
   * `SUBJECT_MIN_OVERLAP` of the smaller of the two areas).
   */
  subject?: { footprint?: MapPoint[][]; egid?: string; egrid?: string };
  geodata: SiteContextGeodata;
  /** The buildings layer's reader, network and caps (see `BuildingsOptions`). */
  buildings?: BuildingsOptions;
  signal?: AbortSignal;
  onProgress?: (progress: SiteContextProgress) => void;
  /** Called once per finished layer, in document order. */
  onLayer?: (layer: SiteContextLayer) => void;
}

/** Reads neighbouring buildings for a WGS84 region: `readSwisstopoBuildings` of `@ifc-lite/tiles3d`, or a stand-in with its signature. */
export type BuildingsReader = typeof readSwisstopoBuildings;

export interface BuildingsOptions {
  /** Default: the swisstopo swissBUILDINGS3D preset of `@ifc-lite/tiles3d`. */
  reader?: BuildingsReader;
  /** Passed to the reader: the CLI injects its fetch and on-disk cache, the viewer its own. */
  fetch?: FetchLike;
  cache?: TilesCache;
  /** Pin a dated swisstopo release (YYYYMMDD); default: the current one. */
  release?: string;
  /** Request and byte budgets of the read; default: the preset's (64 requests, 32 MiB). */
  maxRequests?: number;
  maxBytes?: number;
  /** Tile-cull margin in metres; default: the preset's measured 100 m. */
  tileCullMarginMetres?: number;
  /** Emscripten options for the Draco decoder, e.g. `{ locateFile: () => wasmUrl }` in a browser. */
  dracoModuleOptions?: Record<string, unknown>;
  /** At most this many buildings are kept, nearest the centre first (default 5000). */
  maxFeatures?: number;
  /** At most this many triangles in all, nearest the centre first (default 2 000 000). */
  maxTriangles?: number;
}
