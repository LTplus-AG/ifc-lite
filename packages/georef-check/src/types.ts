/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The input contract (model facts and injected capabilities) and the output
 * contract (level and findings) of {@link diagnoseGeoreference}.
 *
 * The facts are plain data so that any reader can produce them: the bundled
 * {@link collectGeorefFacts} reads an `IfcDataStore`; a caller holding an
 * edited georeference (the write API) patches the facts and diagnoses again.
 */

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

/** A coordinate reference system as the file declares it. */
export interface CrsFact {
  /** Where it was read: the IFC4 entity, or the IFC2x3 property-set convention. */
  source: 'IfcProjectedCRS' | 'IfcGeographicCRS' | 'ePSet_ProjectedCRS';
  /** Express id of the entity (or property set) it was read from. */
  entityId: number;
  /** `Name`, verbatim (may be blank when `wellKnownText` defines the CRS). */
  name: string;
  description?: string;
  geodeticDatum?: string;
  verticalDatum?: string;
  mapProjection?: string;
  mapZone?: string;
  /** `MapUnit` name, or undefined when the file leaves MapUnit unset. */
  mapUnit?: string;
  /** `MapUnit` in metres per unit, undefined when MapUnit is unset or unreadable. */
  mapUnitScale?: number;
  /** IfcWellKnownText attached to the CRS, when any. */
  wellKnownText?: string;
}

/** An operation that places the local engineering CRS on the map. */
export interface OperationFact {
  source: 'IfcMapConversion' | 'IfcRigidOperation' | 'ePSet_MapConversion';
  entityId: number;
  /** As authored, in map units (`MapUnit`, else the project length unit). */
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  /** As authored; undefined when the file leaves it unset. */
  xAxisAbscissa?: number;
  xAxisOrdinate?: number;
  /** As authored; undefined when unset (IFC: unset means 1). */
  scale?: number;
  /** IfcMapConversionScaled factors, as authored. */
  factorX?: number;
  factorY?: number;
  factorZ?: number;
}

/** One georeferencing source: an operation and/or a CRS from the same convention. */
export interface GeoreferenceSourceFact {
  operation?: OperationFact;
  crs?: CrsFact;
}

/** IfcSite RefLatitude / RefLongitude, in decimal degrees (WGS84 by definition). */
export interface SiteLocationFact {
  siteId: number;
  latitude: number;
  longitude: number;
  /** RefElevation in project length units, as authored. */
  elevation?: number;
}

/**
 * Where the model's coordinates actually are, measured without meshing.
 *
 * - `siteOrigin`: the first IfcSite's ObjectPlacement origin, composed through
 *   its `PlacementRelTo` chain (IfcLocalPlacement / IfcAxis2Placement3D|2D,
 *   at most 32 hops). This is where tools that put the map position into the
 *   placements write it.
 * - `pointMedian` / `pointP90Horizontal`: the per-axis median and the 90th
 *   percentile of the horizontal distance from the local origin over an evenly
 *   strided sample of IfcCartesianPoint and IfcCartesianPointList2D/3D
 *   coordinates, as written (each in its own placement, not composed). This
 *   catches geometry authored directly in map coordinates while the site sits
 *   at 0,0. A median is used so a few stray far points cannot move it.
 *
 * All values are in project length units.
 */
export interface CoordinateMagnitudes {
  siteOrigin?: Vec3;
  /** Express id of the first IfcSite's IfcLocalPlacement. */
  sitePlacementId?: number;
  pointMedian?: Vec3;
  pointP90Horizontal?: number;
  /** How many coordinate tuples the sample read. 0 when none. */
  sampledPoints: number;
}

/** Everything {@link diagnoseGeoreference} reads about a model. */
export interface GeorefFacts {
  /** `IFC2X3`, `IFC4`, `IFC4X3` (and `_ADDn` spellings), `IFC5`. */
  schemaVersion: string;
  /** Project length unit in metres per unit. */
  lengthUnitScale: number;
  /** False when the file declares no length unit and metre is assumed. */
  lengthUnitDeclared: boolean;
  /** IfcMapConversion(Scaled) / IfcRigidOperation and its target CRS. */
  entities?: GeoreferenceSourceFact;
  /** `ePSet_MapConversion` / `ePSet_ProjectedCRS`. */
  ePSet?: GeoreferenceSourceFact;
  /** Every IfcMapConversion in the file when there is more than one (only the first is applied). */
  additionalMapConversions?: OperationFact[];
  siteLocation?: SiteLocationFact;
  /** True when an IfcSite or IfcBuilding carries a postal address (LoGeoRef 10). */
  hasPostalAddress?: boolean;
  /** The 3D model context's WorldCoordinateSystem origin (project units), when it is not 0,0,0. */
  contextOrigin?: Vec3;
  /** The 3D model context's TrueNorth, as authored; undefined when unset. */
  trueNorth?: Vec2;
  coordinates?: CoordinateMagnitudes;
}

/**
 * Converts projected coordinates to WGS84 latitude/longitude. Lane A's
 * `@ifc-lite/geo` provides the real one; tests use a stub.
 *
 * `easting`/`northing` are in the CRS's own linear unit, easting first
 * whatever axis order the EPSG definition declares. Return undefined for a
 * CRS you cannot handle; never throw for one.
 */
export interface Reprojector {
  toGeographic(epsgCode: number, easting: number, northing: number): { latitude: number; longitude: number } | undefined;
}

/** What a CRS catalogue knows about one EPSG code. */
export interface CrsCatalogEntry {
  code: number;
  kind?: 'projected' | 'geographic' | 'compound' | 'vertical' | 'other';
  name?: string;
  /** EPSG area of use, decimal degrees. */
  areaOfUse?: { west: number; south: number; east: number; north: number };
  /** Metres per unit of the CRS's horizontal axes. */
  unitScale?: number;
}

/** A CRS lookup, for example over `@ifc-lite/data`'s EPSG index plus area-of-use bounds. */
export interface CrsCatalog {
  lookup(code: number): CrsCatalogEntry | undefined;
  /** Resolve a CRS written by name only ("CH1903+ / LV95") to its EPSG code. */
  resolveName?(name: string): number | undefined;
}

export interface DiagnoseOptions {
  reprojector?: Reprojector;
  crsCatalog?: CrsCatalog;
}

export type Severity = 'error' | 'warning' | 'info';

/** One field a fix sets. Attribute names are the IFC EXPRESS (or ePSet property) names. */
export interface FieldChange {
  entity:
    | 'IfcMapConversion'
    | 'IfcRigidOperation'
    | 'IfcProjectedCRS'
    | 'IfcGeographicCRS'
    | 'IfcSite'
    | 'IfcLocalPlacement'
    | 'ePSet_MapConversion'
    | 'ePSet_ProjectedCRS';
  /** Express id of the entity to change, when it exists. */
  entityId?: number;
  attribute: string;
  /**
   * The value to write; `null` when only the user can supply it (an EPSG code
   * for a model that has none, say). RefLatitude/RefLongitude are decimal
   * degrees; Location is `[x, y, z]` in project units.
   */
  value: number | string | readonly number[] | null;
}

export interface SuggestedFix {
  /** One sentence: what applying this does. */
  summary: string;
  changes: FieldChange[];
  /** What to check after applying it, when the fix cannot be certain. */
  caveat?: string;
}

export interface GeorefFinding {
  code: GeorefFindingCode;
  severity: Severity;
  /** One plain-language sentence a student can act on. */
  message: string;
  /** The numbers the finding is based on. */
  evidence: Record<string, number | string | boolean | null>;
  /** Suggested fixes, most preferred first; empty when only the user can say what is right. */
  fixes: SuggestedFix[];
}

/** buildingSMART Levels of Georeferencing present in the file. */
export type GeorefLevel = 0 | 10 | 20 | 30 | 40 | 50;

export interface SkippedCheck {
  code: GeorefFindingCode;
  reason: string;
}

export interface GeorefReport {
  /** The highest LoGeoRef present, 0 when none. */
  level: GeorefLevel;
  /** Every LoGeoRef present, ascending. Several may coexist (and contradict). */
  levels: GeorefLevel[];
  /** Which source places the model (the parser's winner rule). */
  effectiveSource?: OperationFact['source'] | 'IfcSite';
  findings: GeorefFinding[];
  /** Checks that could not run, and why (a capability was not injected, say). */
  skipped: SkippedCheck[];
}

export type GeorefFindingCode =
  | 'NO_GEOREFERENCE'
  | 'SITE_LOCATION_ONLY'
  | 'SITE_LOCATION_DEFAULT'
  | 'SITE_LOCATION_CONTRADICTS_OPERATION'
  | 'MAP_POSITION_APPLIED_TWICE'
  | 'MAP_COORDINATES_IN_PLACEMENTS'
  | 'SCALE_UNIT_MISMATCH'
  | 'SCALE_DOES_NOT_BRIDGE_UNITS'
  | 'SCALE_INVALID'
  | 'EASTING_ZONE_PREFIX'
  | 'EASTING_ZONE_PREFIX_MISSING'
  | 'LV03_LV95_MIX'
  | 'OUTSIDE_CRS_AREA'
  | 'CRS_NOT_RESOLVABLE'
  | 'OPERATION_WITHOUT_CRS'
  | 'MAP_UNIT_MISSING'
  | 'VERTICAL_DATUM_MISSING'
  | 'ROTATION_INVALID'
  | 'ROTATION_NOT_UNIT_LENGTH'
  | 'TRUE_NORTH_CONTRADICTS_ROTATION'
  | 'ORTHOGONAL_HEIGHT_IMPLAUSIBLE'
  | 'SOURCES_DISAGREE'
  | 'IFC2X3_NO_EPSET';
