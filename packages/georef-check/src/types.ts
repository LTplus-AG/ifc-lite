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

/** Summary of one family of coordinate tuples. */
export interface PointFamilyStats {
  /** Per-axis median, project units. */
  median: Vec3;
  /** 90th percentile of the horizontal distance from the local origin, project units. */
  p90Horizontal: number;
  /** Tuples the sample read. */
  sampled: number;
}

/**
 * Where the model's coordinates actually are, measured without meshing.
 *
 * - `siteOrigin`: the first IfcSite's ObjectPlacement origin, composed through
 *   its `PlacementRelTo` chain (IfcLocalPlacement / IfcAxis2Placement3D|2D,
 *   at most 32 hops). This is where tools that put the map position into the
 *   placements write it.
 * - `geometry`: one summary per coordinate family, never pooled. IfcCartesianPoint
 *   (excluding the points that are an axis placement's Location, which are
 *   placement offsets, not geometry) and IfcCartesianPointList2D/3D are sampled
 *   separately, because a file can hold thousands of small local points beside
 *   a few large meshes in map coordinates: pooled, the two populations meet in
 *   a meaningless middle. A family is at map magnitude when its own median is.
 *   Coordinates are as written, each in its own placement (not composed).
 *
 * All values are in project length units.
 */
export interface CoordinateMagnitudes {
  siteOrigin?: Vec3;
  /** Express id of the first IfcSite's IfcLocalPlacement. */
  sitePlacementId?: number;
  /**
   * The IfcCartesianPoint that is the site placement's own Location
   * (`IfcLocalPlacement.RelativePlacement` → `IfcAxis2Placement3D.Location`):
   * what a fix that moves the site edits. `sharedBy` counts the axis
   * placements whose Location is this same point.
   */
  siteLocationPoint?: { id: number; coordinates: Vec3; sharedBy: number };
  /** Axes of the site placement's parent frame, when it has a `PlacementRelTo`. */
  siteParentAxes?: { x: Vec3; y: Vec3; z: Vec3 };
  geometry?: { cartesianPoints?: PointFamilyStats; pointLists?: PointFamilyStats };
  /** How many coordinate tuples the sample read over all families. 0 when none. */
  sampledPoints: number;
}

/**
 * A spatial structure element whose IfcLocalPlacement has no `PlacementRelTo`
 * (the placement LoGeoRef 30 is about).
 */
export interface RootSpatialPlacementFact {
  elementId: number;
  /** IfcPascalCase type name. */
  elementType: string;
  /** The placement's Location, project units. */
  location: Vec3;
  /** True when its Axis or RefDirection is not the default. */
  rotated: boolean;
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
  /**
   * Every IfcMapConversion in the file, each with its own TargetCRS, when
   * there is more than one (only the first is applied).
   */
  additionalMapConversions?: GeoreferenceSourceFact[];
  siteLocation?: SiteLocationFact;
  /** True when an IfcSite or IfcBuilding carries a postal address (LoGeoRef 10). */
  hasPostalAddress?: boolean;
  /** The 3D model context's WorldCoordinateSystem origin (project units), when it is not 0,0,0. */
  contextOrigin?: Vec3;
  /** The 3D model context's TrueNorth, as authored; undefined when unset. */
  trueNorth?: Vec2;
  coordinates?: CoordinateMagnitudes;
  /** Spatial structure elements placed with no `PlacementRelTo` (at most 16), for LoGeoRef 30. */
  rootSpatialPlacements?: RootSpatialPlacementFact[];
}

/**
 * Converts projected coordinates to WGS84. The checker calls it synchronously
 * with METRES, easting first, whatever unit and axis order the EPSG
 * definition declares; it returns `[longitude, latitude]` in degrees, the
 * shape of `@ifc-lite/geo`'s `transformer.toWgs84`. Resolve the transformers
 * before diagnosing ({@link crsRequirements} lists the codes) and hand in a
 * lookup over them. Return undefined for a CRS you cannot handle; a throw is
 * caught and the check reported as skipped.
 */
export interface Reprojector {
  toWgs84(epsgCode: number, eastingNorthingMetres: readonly [number, number]): readonly number[] | undefined;
}

/** A CRS the diagnosis will reproject from: resolve it before calling {@link diagnoseGeoreference}. */
export interface CrsRequirement {
  /** The EPSG code the checker will pass to {@link Reprojector.toWgs84}. */
  epsg: number;
  /** The CRS Name as authored, for resolvers that key on it. */
  name?: string;
  /** The IfcWellKnownText definition, when the file carries one. */
  wkt?: string;
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
    | 'IfcMapConversionScaled'
    | 'IfcRigidOperation'
    | 'IfcProjectedCRS'
    | 'IfcGeographicCRS'
    | 'IfcSite'
    | 'IfcCartesianPoint'
    | 'ePSet_MapConversion'
    | 'ePSet_ProjectedCRS';
  /** Express id of the instance to change (for an ePSet, the IfcPropertySet); absent when the fix creates it. */
  entityId?: number;
  /** An EXPRESS attribute of `entity` (for an ePSet, the property name). */
  attribute: string;
  /**
   * The value to write; `null` when only the user can supply it (an EPSG code
   * for a model that has none, say). RefLatitude/RefLongitude are decimal
   * degrees; IfcCartesianPoint Coordinates are `[x, y, z]` in project units.
   */
  value: number | string | readonly number[] | null;
}

/** The fields a georeferencing write takes, keyed by EXPRESS attribute name (`bim.georef` input shape). */
export interface GeorefWriteInput {
  ProjectedCRS?: Record<string, string | null>;
  MapConversion?: Record<string, number | null>;
}

/** The fields `bim.georef.setSite` takes: decimal degrees, RefElevation in project length units; `null` where only the user can supply it. */
export interface GeorefSiteWriteInput {
  /** Express id of the IfcSite; absent when the model has one. */
  siteId?: number;
  RefLatitude?: number | null;
  RefLongitude?: number | null;
  RefElevation?: number | null;
}

/**
 * How a fix can be applied.
 * - `georef.update`: one `bim.georef.update(input)` call on the model's
 *   georeferencing (the write API addresses it, not entity ids).
 * - `georef.set`: one grouped `bim.georef.set(input)`, for a model with no
 *   map conversion and no CRS yet.
 * - `georef.site`: one `bim.georef.setSite(input)` call: IfcSite
 *   RefLatitude/RefLongitude (decimal degrees) and RefElevation.
 * - `manual`: the georeferencing write API cannot do it (IfcRigidOperation,
 *   placements, a non-winning record), or it would refuse it; `reason` says which.
 *
 * `userSupplied` lists `ProjectedCRS.Name`-style paths (`IfcSite.RefLatitude`
 * for a site write) whose value is `null` in `input`: only the user can supply
 * them, and the write fails until they do.
 */
export type FixApplication =
  | { via: 'georef.update'; input: GeorefWriteInput; userSupplied: string[] }
  | { via: 'georef.set'; input: GeorefWriteInput; userSupplied: string[] }
  | { via: 'georef.site'; input: GeorefSiteWriteInput; userSupplied: string[] }
  | { via: 'manual'; reason: string };

export interface SuggestedFix {
  /** One sentence: what applying this does. */
  summary: string;
  changes: FieldChange[];
  /** What to check after applying it, when the fix cannot be certain. */
  caveat?: string;
  /** How {@link changes} can be applied. */
  apply: FixApplication;
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

/** Levels of Georeferencing (Clemen & Görne 2019, IFCGeoRefChecker) present in the file. */
export type GeorefLevel = 0 | 10 | 20 | 30 | 40 | 50;

export interface SkippedCheck {
  code: GeorefFindingCode;
  reason: string;
}

/**
 * Stricter or neighbouring notions the published levels do not capture, kept
 * as their own facts so nothing is lost by following the definition.
 */
export interface GeorefIndicators {
  /** The first IfcSite's composed placement origin is at least 100 km from the local origin. */
  placementAtMapMagnitude: boolean;
  /** At least one coordinate family's median is at least 100 km from the local origin. */
  geometryAtMapMagnitude: boolean;
  /** `ePSet_MapConversion` is present (the IFC2X3 convention; not LoGeoRef 50 by definition). */
  ePSetConvention: boolean;
  /** An IfcRigidOperation places the model (IFC4X3; not an IfcMapConversion, so not LoGeoRef 50 by definition). */
  rigidOperation: boolean;
  /** A CRS is declared (IfcProjectedCRS, IfcGeographicCRS or ePSet_ProjectedCRS). */
  crsDeclared: boolean;
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
  indicators: GeorefIndicators;
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
  | 'CRS_WITHOUT_OPERATION'
  | 'MAP_UNIT_MISSING'
  | 'VERTICAL_DATUM_MISSING'
  | 'ROTATION_INVALID'
  | 'ROTATION_NOT_UNIT_LENGTH'
  | 'TRUE_NORTH_CONTRADICTS_ROTATION'
  | 'ORTHOGONAL_HEIGHT_IMPLAUSIBLE'
  | 'SOURCES_DISAGREE'
  | 'IFC2X3_NO_EPSET';
