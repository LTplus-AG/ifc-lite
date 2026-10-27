/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computeTransformMatrix } from './georef-transform.js';
// The transform side lives in ./georef-transform.ts; re-exported here so
// every existing `from './georef-extractor.js'` import keeps resolving.
export {
  computeTransformMatrix,
  transformToWorld,
  transformToLocal,
  getCoordinateSystemDescription,
} from './georef-transform.js';

/**
 * Georeferencing Extractor
 *
 * Extracts IFC georeferencing information for coordinate system transformations.
 *
 * IFC georeferencing concepts:
 * - IfcMapConversion: Transformation from local engineering CRS to map CRS
 * - IfcProjectedCRS: Target coordinate reference system (e.g., UTM, State Plane)
 * - IfcGeometricRepresentationContext: Context with coordinate system info
 *
 * This enables:
 * - Converting IFC coordinates to real-world coordinates (lat/lon or projected)
 * - Integration with GIS systems
 * - Multi-model coordination (ensuring models align in real-world space)
 */

import type { IfcEntity } from './entity-extractor.js';
import {
  getNumber,
  getReference,
  isUnrepresentableNumericValue,
} from './attribute-helpers.js';
import { extractMapConversion } from './georef-map-conversion.js';
import { extractEPSetMapConversion } from './georef-epset.js';
import {
  extractGeographicCRS,
  extractRigidOperation,
  planeAngleUnitToDegrees,
  projectPlaneAngleUnitToDegrees,
  wellKnownTextFor,
} from './georef-coordinate-operation.js';
import { extractProjectedCRS } from './georef-projected-crs.js';
import { getAttributeNames } from './ifc-schema.js';

export interface MapConversion {
  id: number;
  /**
   * Set when read from an `IfcRigidOperation` (a pure translation: the source
   * coordinates already are target-CRS coordinates, offset). Absent for
   * `IfcMapConversion` and its subtypes.
   */
  operation?: 'rigidOperation';
  sourceCRS: number;  // GeometricRepresentationContext ID
  targetCRS: number;  // ProjectedCRS ID
  eastings: number;   // False easting (X offset)
  northings: number;  // False northing (Y offset)
  orthogonalHeight: number;  // Z offset
  xAxisAbscissa?: number;    // X-axis direction (rotation)
  xAxisOrdinate?: number;    // X-axis direction (rotation)
  scale?: number;            // Scale factor
  factorX?: number;          // IfcMapConversionScaled X factor
  factorY?: number;          // IfcMapConversionScaled Y factor
  factorZ?: number;          // IfcMapConversionScaled Z factor
}

/**
 * Compute angle to grid north from XAxisAbscissa and XAxisOrdinate (in degrees).
 * Returns the counterclockwise angle from map X to the IFC local X-axis.
 * With IfcMapConversion this is represented as cos/sin, so:
 * - XAxisAbscissa = cos(angle)
 * - XAxisOrdinate = sin(angle)
 */
export function computeAngleToGridNorth(
  xAxisAbscissa?: number,
  xAxisOrdinate?: number
): number | null {
  if (xAxisAbscissa === undefined || xAxisOrdinate === undefined) return null;
  const radians = Math.atan2(xAxisOrdinate, xAxisAbscissa);
  return radians * (180 / Math.PI);
}

export interface ProjectedCRS {
  id: number;
  /** `'geographic'` when read from an `IfcGeographicCRS` (lon/lat degrees). */
  kind?: 'geographic';
  /** Name is mandatory for `IfcProjectedCRS` but may be blank when `wellKnownText` defines the CRS. */
  name: string;
  description?: string;
  geodeticDatum?: string;     // e.g., "WGS84", "NAD83"
  verticalDatum?: string;     // e.g., "NAVD88", "MSL"
  mapProjection?: string;     // e.g., "UTM Zone 10N"
  mapZone?: string;           // e.g., "10N"
  mapUnit?: string;           // e.g., "METRE"
  /**
   * Scale factor to convert MapConversion values to metres.
   * Derived from IfcProjectedCRS.MapUnit (e.g. 0.001 for mm, 1 for m).
   * If undefined, the project's length unit applies (IFC spec default).
   */
  mapUnitScale?: number;
  /**
   * `IfcWellKnownText.WellKnownText` attached to this CRS (WKT1 or WKT2,
   * ISO 19125-1 / ISO 19162). When present it is the authoritative definition;
   * `name` may then be a placeholder (WHERE NameOrWKT).
   */
  wellKnownText?: string;
}

export interface GeoreferenceInfo {
  hasGeoreference: boolean;
  mapConversion?: MapConversion;
  projectedCRS?: ProjectedCRS;
  source?: 'mapConversion' | 'rigidOperation' | 'ePSetMapConversion' | 'siteLocation';
  // Computed transformation matrix (4x4) from local to world coordinates
  transformMatrix?: number[];
}

/**
 * Every concrete class that carries an IfcMapConversion's attributes, in the
 * mixed-case spelling `entitiesByType` is keyed by. `IfcMapConversionScaled`
 * is IFC4X3's scaled variant and the only subtype in any bundled schema; it is
 * listed here rather than folded into the caller so that every consumer of the
 * exported `extractGeoreferencing` widens identically.
 */
export const MAP_CONVERSION_TYPE_NAMES: readonly string[] = [
  'IfcMapConversion',
  'IfcMapConversionScaled',
];

/** IFC4 entities, else the ePSet_MapConversion then IfcSite fallbacks (Rust's precedence). */
export function extractGeoreferencing(entities: Map<number, IfcEntity>, entitiesByType: Map<string, number[]>): GeoreferenceInfo {
  return withGeoreferenceFallbacks(extractIfc4Georeferencing(entities, entitiesByType), entities, entitiesByType);
}

/** Completes an {@link extractIfc4Georeferencing} result that claims nothing with the fallbacks. */
export function withGeoreferenceFallbacks(
  info: GeoreferenceInfo,
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>
): GeoreferenceInfo {
  if (info.hasGeoreference) return info;
  return extractEPSetMapConversion(entities, entitiesByType)
    ?? extractLegacySiteGeoreference(entities, entitiesByType)
    ?? info;
}

/**
 * IFC4+ entities only: IfcMapConversion (else IFC4X3 IfcRigidOperation), its
 * TargetCRS (IfcProjectedCRS or IfcGeographicCRS, with any IfcWellKnownText
 * definition). `hasGeoreference: false` is the one
 * rule for "the fallbacks run": a loader supplying fallback entities asks this (#4695).
 */
export function extractIfc4Georeferencing(entities: Map<number, IfcEntity>, entitiesByType: Map<string, number[]>): GeoreferenceInfo {
  const info: GeoreferenceInfo = { hasGeoreference: false };

  // Extract IfcMapConversion — including IFC4X3's concrete subtype
  // IfcMapConversionScaled, which a type-keyed lookup for the supertype alone
  // never sees. Its first eight attributes ARE IfcMapConversion's (SourceCRS,
  // TargetCRS, Eastings, Northings, OrthogonalHeight, XAxisAbscissa,
  // XAxisOrdinate, Scale); the three it adds (FactorX/Y/Z) sit after them, so
  // reading it as its supertype is well-defined. Missing it did not merely
  // omit a field: with no mapConversion there is no `transformMatrix`, so a
  // file georeferenced this way was placed at its local origin instead of its
  // map position.
  const mapConversionIds = MAP_CONVERSION_TYPE_NAMES.flatMap(
    (typeName) => entitiesByType.get(typeName) ?? [],
  );
  if (mapConversionIds.length > 0) {
    const entity = entities.get(mapConversionIds[0]);
    if (entity) {
      // A refused conversion leaves the field absent and does not claim
      // `hasGeoreference`. A named IfcProjectedCRS further down may still claim it —
      // correct: the file does declare a CRS, it just carries no usable
      // placement.
      const mapConversion = extractMapConversion(entity);
      if (mapConversion) {
        info.mapConversion = mapConversion;
        info.hasGeoreference = true;
      }
    }
  }

  // IFC4X3 IfcRigidOperation, when no map conversion was read. Its plane-angle
  // form needs the geographic target's angle unit before it can be read, so
  // the target CRS is resolved first.
  const resolve = (id: number) => entities.get(id);
  let rigidOperationId: number | undefined;
  if (!info.mapConversion) {
    rigidOperationId = (entitiesByType.get('IfcRigidOperation') ?? [])[0];
  }
  const operationEntity = info.mapConversion
    ? entities.get(info.mapConversion.id)
    : rigidOperationId === undefined ? undefined : entities.get(rigidOperationId);

  // The operation's own TargetCRS, else the file's first IfcProjectedCRS, else
  // its first IfcGeographicCRS.
  const targetId = getReference(operationEntity?.attributes?.[1]);
  const target = targetId === undefined ? undefined : entities.get(targetId);
  const crsEntity = isCrsEntity(target, 'IfcProjectedCRS') || isCrsEntity(target, 'IfcGeographicCRS')
    ? target
    : entities.get((entitiesByType.get('IfcProjectedCRS') ?? [])[0] as number)
      ?? entities.get((entitiesByType.get('IfcGeographicCRS') ?? [])[0] as number);
  if (crsEntity) {
    const crs = isCrsEntity(crsEntity, 'IfcGeographicCRS')
      ? extractGeographicCRS(crsEntity)
      : extractProjectedCRS(crsEntity, resolve);
    const wellKnownText = wellKnownTextFor(crsEntity.expressId, entitiesByType.get('IfcWellKnownText') ?? [], resolve);
    if (wellKnownText) crs.wellKnownText = wellKnownText;
    info.projectedCRS = crs;
    // A CRS without a non-blank Name declares none on its own: it still scales
    // a parsed operation, but neither claims presence nor holds back the
    // fallbacks (#4695). A WKT-only CRS is claimed by its parsed operation.
    if (crs.name.trim() !== '') info.hasGeoreference = true;
  }

  if (rigidOperationId !== undefined && operationEntity) {
    const geographic = info.projectedCRS?.kind === 'geographic';
    const rigid = extractRigidOperation(operationEntity, {
      geographic,
      angleUnitToDegrees: geographic && crsEntity
        ? planeAngleUnitToDegrees(crsEntity.attributes?.[4], resolve)
          ?? (getReference(crsEntity.attributes?.[4]) === undefined
            ? projectPlaneAngleUnitToDegrees(entitiesByType.get('IfcProject') ?? [], resolve)
            : undefined)
        : undefined,
    });
    if (rigid) {
      info.mapConversion = rigid;
      info.hasGeoreference = true;
    }
  }

  // Compute transformation matrix if we have map conversion
  if (info.mapConversion) {
    info.source = info.mapConversion.operation ?? 'mapConversion';
    info.transformMatrix = computeTransformMatrix(info.mapConversion);
  }
  return info;
}

function isCrsEntity(entity: IfcEntity | undefined, typeName: string): entity is IfcEntity {
  return (entity?.type ?? '').toUpperCase() === typeName.toUpperCase();
}

function getAttributeValueByName(entity: IfcEntity, attributeName: string): unknown {
  const attributeNames = getAttributeNames(entity.type);
  const index = attributeNames.indexOf(attributeName);
  if (index < 0) return undefined;
  return entity.attributes[index];
}

// Canonical sign lives on the first non-zero component (`minutesRaw < 0`
// below already handles it); this also defensively honours `-0` on a
// zero-magnitude degree token, which `x < 0` alone misses (IEEE-754 -0).
function isNegativeComponent(n: number): boolean {
  return n < 0 || Object.is(n, -0);
}

function compoundPlaneAngleToDecimalDegrees(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  // Read BY POSITION and refuse the whole angle on a non-numeric component, as
  // the Rust twin does: dropping non-numbers first read ($,51,30,0) as 51°30'.
  const parts = [...value.slice(0, 3), value.length > 3 ? value[3] : 0].map((entry) => getNumber(entry));
  if (!parts.every((part): part is number => part !== undefined)) return undefined;
  const [degreesRaw, minutesRaw, secondsRaw, millionthsRaw] = parts;
  const sign =
    isNegativeComponent(degreesRaw) ||
    isNegativeComponent(minutesRaw) ||
    isNegativeComponent(secondsRaw) ||
    isNegativeComponent(millionthsRaw)
      ? -1
      : 1;
  const degrees = Math.abs(degreesRaw);
  const minutes = Math.abs(minutesRaw);
  const seconds = Math.abs(secondsRaw);
  const millionths = Math.abs(millionthsRaw);

  return sign * (degrees + (minutes / 60) + ((seconds + (millionths / 1_000_000)) / 3600));
}

function extractLegacySiteGeoreference(
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>,
): GeoreferenceInfo | null {
  const siteIds = entitiesByType.get('IfcSite') || [];
  for (const siteId of siteIds) {
    const site = entities.get(siteId);
    if (!site) continue;

    const latitude = compoundPlaneAngleToDecimalDegrees(
      getAttributeValueByName(site, 'RefLatitude'),
    );
    const longitude = compoundPlaneAngleToDecimalDegrees(
      getAttributeValueByName(site, 'RefLongitude'),
    );
    // The same rule again, on the legacy site path. An absent `RefElevation`
    // legitimately means "at the datum" and keeps its `0`; an elevation the
    // double range cannot hold does not, and this site is skipped so a later
    // one — or no georeference at all — is reported instead of a model pinned
    // to the datum. `?? 0` alone stopped being safe when `getNumber` began
    // answering `undefined` for such a literal.
    const rawElevation = getAttributeValueByName(site, 'RefElevation');
    if (isUnrepresentableNumericValue(rawElevation)) {
      console.warn(
        `[georef-extractor] IfcSite #${site.expressId} RefElevation is outside the ` +
        `IEEE-754 double range (${String(rawElevation)}); skipping this site rather than ` +
        `reporting it at a substituted elevation.`,
      );
      continue;
    }
    const elevation = getNumber(rawElevation) ?? 0;

    if (latitude === undefined || longitude === undefined) continue;

    return {
      hasGeoreference: true,
      source: 'siteLocation',
      projectedCRS: {
        id: site.expressId,
        name: 'EPSG:4326',
        description: 'Legacy IfcSite geolocation',
        geodeticDatum: 'WGS84',
        mapProjection: 'Geographic',
        mapUnit: 'DEGREE',
      },
      mapConversion: {
        id: site.expressId,
        sourceCRS: 0,
        targetCRS: site.expressId,
        eastings: longitude,
        northings: latitude,
        orthogonalHeight: elevation,
        scale: 1,
      },
    };
  }

  return null;
}
