/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef` shapes. IFC attributes keep their EXPRESS names
 * (`ProjectedCRS.Name`, `MapConversion.Eastings`, …); fields that are derived
 * or describe the read itself (`rotationDegrees`, `storage`, `pending`) are
 * camelCase, which is the repository rule for new surface (AGENTS.md, "IFC
 * schema fidelity"). The frozen camelCase `GeoreferenceInfo` from
 * `@ifc-lite/parser` stays what the viewer reads; this is the SDK's own shape.
 */

/** `IfcProjectedCRS` attributes a caller can write (all but `Name` optional). */
export interface GeorefProjectedCRSAttributes {
  /** Mandatory. An EPSG code is written as `EPSG:<code>`. */
  Name: string;
  Description?: string;
  GeodeticDatum?: string;
  VerticalDatum?: string;
  MapProjection?: string;
  MapZone?: string;
  /** A length unit name: `METRE` (any SI prefix), `FOOT` or `US SURVEY FOOT`. */
  MapUnit?: string;
}

/** `IfcMapConversion` (and IFC4X3 `IfcMapConversionScaled`) attributes. */
export interface GeorefMapConversionAttributes {
  Eastings: number;
  Northings: number;
  OrthogonalHeight: number;
  XAxisAbscissa?: number;
  XAxisOrdinate?: number;
  Scale?: number;
  /** IFC4X3 `IfcMapConversionScaled` only; FactorX/Y/Z go together. */
  FactorX?: number;
  FactorY?: number;
  FactorZ?: number;
}

/** Where the georeferencing of a model lives. */
export type GeorefStorage = 'entities' | 'propertySets';

/** What the reported georeferencing was read from. */
export type GeorefSource =
  | 'IfcMapConversion'
  | 'IfcMapConversionScaled'
  | 'IfcRigidOperation'
  | 'ePSet_MapConversion'
  | 'IfcSite';

export interface GeorefProjectedCRSState extends Partial<GeorefProjectedCRSAttributes> {
  Name: string;
  /** `IfcProjectedCRS`, `IfcGeographicCRS`, or the IFC2X3 `ePSet_ProjectedCRS`. */
  type: 'IfcProjectedCRS' | 'IfcGeographicCRS' | 'ePSet_ProjectedCRS';
  /** Absent for a record this session created and has not exported yet. */
  expressId?: number;
  /** `IfcWellKnownText` attached to this CRS, when there is one. */
  wellKnownText?: string;
  /**
   * Whether `MapUnit` was read from the file. `false` when the CRS names a
   * unit the reader could not resolve and `MapUnit` is the reader's METRE
   * default; such a unit is never carried into a write. Absent with MapUnit.
   */
  mapUnitResolved?: boolean;
}

export interface GeorefMapConversionState extends GeorefMapConversionAttributes {
  type: 'IfcMapConversion' | 'IfcMapConversionScaled' | 'ePSet_MapConversion';
  expressId?: number;
}

/** IFC4X3 `IfcRigidOperation` (a pure translation), as read. */
export interface GeorefRigidOperationState {
  type: 'IfcRigidOperation';
  expressId: number;
  /** FirstCoordinate / SecondCoordinate / Height, as numbers. */
  FirstCoordinate: number;
  SecondCoordinate: number;
  Height: number;
}

/** The IfcSite RefLatitude/RefLongitude fallback, in decimal degrees. */
export interface GeorefSiteLocationState {
  expressId: number;
  latitude: number;
  longitude: number;
  elevation: number;
}

/** `bim.georef.get()`: the model's georeferencing, including this session's unsaved writes. */
export interface GeoreferencingState {
  modelId: string;
  /** The model's schema as loaded (`IFC2X3`, `IFC4`, `IFC4X3`, …). */
  schema: string;
  hasGeoreference: boolean;
  source: GeorefSource | null;
  /** Where `set`/`update` would write: entities (IFC4+), property sets (IFC2X3), or nowhere. */
  storage: GeorefStorage | null;
  ProjectedCRS: GeorefProjectedCRSState | null;
  MapConversion: GeorefMapConversionState | null;
  RigidOperation: GeorefRigidOperationState | null;
  site: GeorefSiteLocationState | null;
  /**
   * Degrees counter-clockwise from the map easting axis to the local x-axis,
   * `atan2(XAxisOrdinate, XAxisAbscissa)`; `null` when no rotation is stored.
   */
  rotationDegrees: number | null;
  /** True when this session holds a georeferencing write not yet exported. */
  pending: boolean;
  /**
   * Present when a generic edit (outside `bim.georef`) changed something these values are read from that
   * `get()` does not interpret: the values may differ from what the export writes, and no write carries them.
   */
  untrusted?: string[];
}

/** `bim.georef.set()`: a complete georeferencing. */
export interface GeoreferencingSetInput {
  ProjectedCRS: GeorefProjectedCRSAttributes;
  MapConversion: GeorefMapConversionAttributes;
  /** Rotation as an angle (degrees, counter-clockwise from map easting). Alternative to XAxisAbscissa/XAxisOrdinate. */
  rotationDegrees?: number;
  /** Required when the model already carries georeferencing: it is removed and replaced. */
  replace?: boolean;
}

/** `bim.georef.update()`: change some fields of the existing georeferencing. */
export interface GeoreferencingUpdateInput {
  ProjectedCRS?: Partial<GeorefProjectedCRSAttributes>;
  MapConversion?: Partial<GeorefMapConversionAttributes>;
  rotationDegrees?: number;
}

export type GeoreferencingWriteRequest =
  | { action: 'set'; input: GeoreferencingSetInput }
  | { action: 'update'; input: GeoreferencingUpdateInput }
  | { action: 'remove' };

/** Where the map unit that was written came from. */
export interface GeorefMapUnitDecision {
  value: string;
  source: 'explicit' | 'existing';
  /** Human-readable origin, e.g. `existing IfcProjectedCRS #12 (Name unchanged)`. */
  detail: string;
}

export interface GeoreferencingWriteResult {
  action: GeoreferencingWriteRequest['action'];
  storage: GeorefStorage;
  /** The georeferencing as it will be exported. */
  state: GeoreferencingState;
  /** Records this write removes (EXPRESS class and id). */
  removed: string[];
  mapUnit: GeorefMapUnitDecision | null;
  /** Things the caller should know that did not stop the write. */
  notes: string[];
}

export type GeoreferencingErrorCode =
  | 'MISSING_INPUT'
  | 'INVALID_INPUT'
  | 'CONTRADICTION'
  | 'NO_ANCHOR'
  | 'ALREADY_GEOREFERENCED'
  | 'NOT_GEOREFERENCED'
  | 'UNSUPPORTED_SCHEMA'
  | 'UNSUPPORTED_RECORD'
  | 'AMBIGUOUS';

/** A refused georeferencing write. `missing` names the inputs that would let it proceed. */
export class GeoreferencingError extends Error {
  readonly code: GeoreferencingErrorCode;
  readonly missing: readonly string[];
  constructor(code: GeoreferencingErrorCode, message: string, missing: readonly string[] = []) {
    super(message);
    this.name = 'GeoreferencingError';
    this.code = code;
    this.missing = missing;
  }
}

/**
 * `bim.georef.setSite()`: IfcSite RefLatitude / RefLongitude in decimal
 * degrees (WGS84; south and west negative), RefElevation in project length
 * units. Written as IfcCompoundPlaneAngleMeasure to the millionth of a second.
 */
export interface GeorefSiteInput {
  /** The IfcSite to write; needed only when the model has more than one. */
  siteId?: number;
  RefLatitude?: number;
  RefLongitude?: number;
  RefElevation?: number;
}

export interface GeorefSiteWriteResult {
  siteId: number;
  /** Decimal degrees (RefElevation: project units); null when unset. */
  before: Record<'RefLatitude' | 'RefLongitude' | 'RefElevation', number | null>;
  after: Record<'RefLatitude' | 'RefLongitude' | 'RefElevation', number | null>;
  /** The values as written: compound angles `[d, m, s, millionths]`, RefElevation as given. */
  written: { RefLatitude?: number[]; RefLongitude?: number[]; RefElevation?: number };
}

/** Optional local-backend support for `bim.georef`. */
export interface GeoreferencingBackendMethods {
  get(modelId?: string): GeoreferencingState;
  write(request: GeoreferencingWriteRequest, modelId?: string): GeoreferencingWriteResult;
  writeSite?(input: GeorefSiteInput, modelId?: string): GeorefSiteWriteResult;
  check?(options: GeorefCheckOptions, modelId?: string): Promise<GeorefCheckReport>;
  fix?(plan: GeorefFixPlan, modelId?: string): GeorefFixResult;
}

export type {
  GeorefCheckOptions, GeorefCheckReport, GeorefCrsResolution, GeorefDatumShift, GeorefFixPlan, GeorefFixPlanOptions, GeorefFixResult,
  GeorefPlannedFix, GeorefPlannedFixStatus, GeorefPlannedWrite, GeorefSiteDerivation,
} from './doctor/types.js';
import type { GeorefCheckOptions, GeorefCheckReport, GeorefFixPlan, GeorefFixResult } from './doctor/types.js';
