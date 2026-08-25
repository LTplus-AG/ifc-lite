/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { computeTransformMatrix } from './georef-transform.js';
// The transform side lives in ./georef-transform.ts; re-exported here so
// every existing `from './georef-extractor.js'` import keeps resolving.
export {
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
import { getString, getNumber, getReference } from './attribute-helpers.js';
import { CONVERSION_BASED_UNIT_FACTORS } from './unit-extractor.js';
import { getAttributeNames } from './ifc-schema.js';

export interface MapConversion {
  id: number;
  sourceCRS: number;  // GeometricRepresentationContext ID
  targetCRS: number;  // ProjectedCRS ID
  eastings: number;   // False easting (X offset)
  northings: number;  // False northing (Y offset)
  orthogonalHeight: number;  // Z offset
  xAxisAbscissa?: number;    // X-axis direction (rotation)
  xAxisOrdinate?: number;    // X-axis direction (rotation)
  scale?: number;            // Scale factor
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
}

export interface GeoreferenceInfo {
  hasGeoreference: boolean;
  mapConversion?: MapConversion;
  projectedCRS?: ProjectedCRS;
  source?: 'mapConversion' | 'ePSetMapConversion' | 'siteLocation';
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

/**
 * Extract georeferencing information from IFC entities
 */
export function extractGeoreferencing(
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>
): GeoreferenceInfo {
  const info: GeoreferenceInfo = {
    hasGeoreference: false,
  };

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
      info.mapConversion = extractMapConversion(entity);
      info.hasGeoreference = true;
    }
  }

  // Extract IfcProjectedCRS
  const projectedCRSIds = entitiesByType.get('IfcProjectedCRS') || [];
  if (projectedCRSIds.length > 0) {
    const entity = entities.get(projectedCRSIds[0]);
    if (entity) {
      info.projectedCRS = extractProjectedCRS(entity, (id) => entities.get(id));
      info.hasGeoreference = true;
    }
  }

  // Compute transformation matrix if we have map conversion
  if (info.mapConversion) {
    info.source = 'mapConversion';
    info.transformMatrix = computeTransformMatrix(info.mapConversion);
  }

  if (!info.hasGeoreference) {
    // IFC2x3 ePSet_MapConversion fallback BEFORE the legacy site fallback —
    // same precedence as the Rust extractor (ifc_lite_core::GeoRefExtractor),
    // which previously found these models georeferenced while the browser
    // reported none (alignment audit).
    const epset = extractEPSetMapConversion(entities, entitiesByType);
    if (epset) {
      return epset;
    }
    const legacySite = extractLegacySiteGeoreference(entities, entitiesByType);
    if (legacySite) {
      return legacySite;
    }
  }

  return info;
}

/**
 * Unwrap an IfcValue `NominalValue`. The columnar/on-demand extractor delivers
 * typed values as a `[TYPENAME, value]` tuple (e.g.
 * `["IFCLENGTHMEASURE", 160073528]`, `["IFCLABEL", "EPSG:7415"]`), which
 * `getNumber`/`getString` don't see through; raw scalars (used by the
 * entity-map callers) pass through untouched.
 */
function unwrapNominalValue(value: unknown): unknown {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === 'string') {
    return value[1];
  }
  return value;
}

/**
 * Read an `IfcPropertySet`'s `IfcPropertySingleValue` children into a
 * name → raw-value map, keeping the value as-is (string or number) so both
 * numeric (Eastings) and string (TargetCRS, EPSG Name) properties survive.
 */
function readPsetSingleValues(
  entities: Map<number, IfcEntity>,
  pset: IfcEntity,
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  // IfcPropertySet: GlobalId (0), OwnerHistory (1), Name (2), Description (3), HasProperties (4)
  const props = pset.attributes[4];
  if (Array.isArray(props)) {
    for (const propRef of props) {
      const propId = getReference(propRef);
      if (!propId) continue;
      const prop = entities.get(propId);
      if (!prop) continue;
      // IfcPropertySingleValue: Name (0), Description (1), NominalValue (2)
      const propName = getString(prop.attributes[0]);
      if (!propName) continue;
      const raw = unwrapNominalValue(prop.attributes[2]);
      if (typeof raw === 'number') {
        values[propName] = raw;
      } else if (typeof raw === 'string') {
        // Keep the raw string verbatim. Coordinate fields are coerced on read
        // via `asNumber` (some writers store Eastings/Scale as strings), while
        // CRS metadata that merely looks numeric — `Name: "7415"`, `MapZone:
        // "31N"` — must stay a string so `asString` doesn't discard it.
        values[propName] = raw;
      }
    }
  }
  return values;
}

/**
 * Find the first `IfcPropertySet` whose Name matches `targetName`
 * case-insensitively. buildingSMART's geo-referencing guide spells the
 * IFC2x3 property sets `ePSet_…` (capital S), but real authoring tools (e.g.
 * the `ifc-georeferencer` post-processor) write `ePset_…` (lowercase) — an
 * exact match silently dropped those models to the legacy IfcSite/EPSG:4326
 * fallback, so they displayed the wrong CRS.
 */
function findPsetByName(
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>,
  targetName: string,
): IfcEntity | null {
  const target = targetName.toLowerCase();
  const psetIds = entitiesByType.get('IfcPropertySet') || [];
  for (const psetId of psetIds) {
    const pset = entities.get(psetId);
    if (!pset) continue;
    const name = getString(pset.attributes[2]);
    if (name && name.toLowerCase() === target) return pset;
  }
  return null;
}

function asString(value: string | number | undefined): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function asNumber(value: string | number | undefined): number | undefined {
  return typeof value === 'number' ? value : getNumber(value);
}

/**
 * Map an IFC unit label (e.g. "MILLIMETRE", "FOOT") to its metre scale.
 * Mirrors the viewer's `inferMapUnitScale` and the native `IfcProjectedCRS`
 * path so direct parser/MCP consumers of `ProjectedCRS.mapUnitScale` see the
 * same scale regardless of whether the CRS came from a native entity or an
 * ePSet. Returns `undefined` for an absent/unknown unit (the ePSet convention
 * then defers to the project length unit downstream).
 */
function inferMapUnitScaleFromLabel(mapUnit: string | undefined): number | undefined {
  if (!mapUnit) return undefined;
  const n = mapUnit.toUpperCase();
  if (n.includes('US') && (n.includes('SURVEY') || n.includes('FTUS'))) return 0.3048006096;
  if (n.includes('FOOT') || n.includes('FEET')) return 0.3048;
  if (n.includes('MILLI')) return 0.001;
  if (n.includes('CENTI')) return 0.01;
  if (n.includes('DECI')) return 0.1;
  if (n.includes('KILO')) return 1000;
  if (n.includes('METRE') || n.includes('METER')) return 1;
  return undefined;
}

/**
 * IFC2x3 fallback: a property set named `ePSet_MapConversion` (any casing)
 * carrying Eastings/Northings/OrthogonalHeight (+ optional
 * XAxisAbscissa/XAxisOrdinate/Scale/TargetCRS), optionally paired with an
 * `ePSet_ProjectedCRS` set carrying the EPSG `Name`. Mirrors
 * `GeoRefExtractor::extract_from_pset` in rust/core/src/georef.rs.
 */
function extractEPSetMapConversion(
  entities: Map<number, IfcEntity>,
  entitiesByType: Map<string, number[]>,
): GeoreferenceInfo | null {
  const pset = findPsetByName(entities, entitiesByType, 'ePSet_MapConversion');
  if (!pset) return null;

  const values = readPsetSingleValues(entities, pset);

  // Some writers store the offsets as strings, so coerce on read.
  const eastings = asNumber(values['Eastings']) ?? 0;
  const northings = asNumber(values['Northings']) ?? 0;
  const orthogonalHeight = asNumber(values['OrthogonalHeight']) ?? 0;

  const mapConversion: MapConversion = {
    id: pset.expressId,
    sourceCRS: 0,
    targetCRS: 0,
    eastings,
    northings,
    orthogonalHeight,
    xAxisAbscissa: asNumber(values['XAxisAbscissa']),
    xAxisOrdinate: asNumber(values['XAxisOrdinate']),
    scale: asNumber(values['Scale']),
  };

  // Resolve the CRS name from ePSet_ProjectedCRS.Name, falling back to the
  // MapConversion's TargetCRS (the ifc-georeferencer tool writes both as the
  // same EPSG label). Without this the EPSG code in the file was never
  // surfaced on the IFC2x3 path.
  const crsPset = findPsetByName(entities, entitiesByType, 'ePSet_ProjectedCRS');
  const crsValues = crsPset ? readPsetSingleValues(entities, crsPset) : {};
  const crsName = asString(crsValues['Name']) ?? asString(values['TargetCRS']);

  // Reject only when there is nothing to georeference by: no CRS name AND the
  // placement sits at the local origin. Mirrors `has_georef()` in rust/core
  // (a CRS name OR any non-zero offset is sufficient) so a valid zero-origin
  // placement at a real projected CRS is kept rather than dropping to the
  // legacy IfcSite/EPSG:4326 fallback.
  if (!crsName && eastings === 0 && northings === 0 && orthogonalHeight === 0) return null;

  let projectedCRS: ProjectedCRS | undefined;
  if (crsName || crsPset) {
    const mapUnit = asString(crsValues['MapUnit']);
    projectedCRS = {
      id: crsPset?.expressId ?? pset.expressId,
      name: crsName ?? '',
      description: asString(crsValues['Description']),
      geodeticDatum: asString(crsValues['GeodeticDatum']),
      verticalDatum: asString(crsValues['VerticalDatum']),
      mapProjection: asString(crsValues['MapProjection']),
      mapZone: asString(crsValues['MapZone']),
      mapUnit,
      // An explicit ePSet MapUnit carries its own scale (parity with the native
      // IfcProjectedCRS path). When absent, leave it undefined so consumers fall
      // back to the project length unit per the buildingSMART convention.
      mapUnitScale: inferMapUnitScaleFromLabel(mapUnit),
    };
  }

  return {
    hasGeoreference: true,
    source: 'ePSetMapConversion',
    mapConversion,
    projectedCRS,
    transformMatrix: computeTransformMatrix(mapConversion),
  };
}

function getAttributeValueByName(entity: IfcEntity, attributeName: string): unknown {
  const attributeNames = getAttributeNames(entity.type);
  const index = attributeNames.indexOf(attributeName);
  if (index < 0) return undefined;
  return entity.attributes[index];
}

function compoundPlaneAngleToDecimalDegrees(value: unknown): number | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const numbers = value
    .map((entry) => getNumber(entry))
    .filter((entry): entry is number => entry !== undefined);
  if (numbers.length < 3) return undefined;

  const [degreesRaw, minutesRaw, secondsRaw, millionthsRaw = 0] = numbers;
  const sign = degreesRaw < 0 || minutesRaw < 0 || secondsRaw < 0 || millionthsRaw < 0 ? -1 : 1;
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
    const elevation = getNumber(getAttributeValueByName(site, 'RefElevation')) ?? 0;

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

function extractMapConversion(entity: IfcEntity): MapConversion {
  // IfcMapConversion attributes (IFC4):
  // [0] SourceCRS (IfcCoordinateReferenceSystem)
  // [1] TargetCRS (IfcCoordinateReferenceSystem)
  // [2] Eastings (IfcLengthMeasure)
  // [3] Northings (IfcLengthMeasure)
  // [4] OrthogonalHeight (IfcLengthMeasure)
  // [5] XAxisAbscissa (OPTIONAL IfcReal)
  // [6] XAxisOrdinate (OPTIONAL IfcReal)
  // [7] Scale (OPTIONAL IfcReal)

  return {
    id: entity.expressId,
    sourceCRS: getReference(entity.attributes[0]) || 0,
    targetCRS: getReference(entity.attributes[1]) || 0,
    eastings: getNumber(entity.attributes[2]) || 0,
    northings: getNumber(entity.attributes[3]) || 0,
    orthogonalHeight: getNumber(entity.attributes[4]) || 0,
    xAxisAbscissa: getNumber(entity.attributes[5]),
    xAxisOrdinate: getNumber(entity.attributes[6]),
    scale: getNumber(entity.attributes[7]),
  };
}

/** SI prefix → scale factor */
const SI_PREFIX_SCALE: Record<string, number> = {
  'MILLI': 0.001, 'CENTI': 0.01, 'DECI': 0.1, 'KILO': 1000,
};

/**
 * Resolve an `IfcMeasureWithUnit` reference to metres.
 *
 * `IFCMEASUREWITHUNIT: [0] ValueComponent, [1] UnitComponent` — the value is
 * expressed IN the unit component, so a prefixed SI component multiplies it
 * (0.3048 expressed in millimetres is not 0.3048 metres).
 */
function resolveMeasureWithUnit(
  ref: unknown,
  resolveEntity: (id: number) => IfcEntity | undefined,
): number | undefined {
  const measureRef = getReference(ref);
  if (measureRef === undefined) return undefined;
  const measure = resolveEntity(measureRef);
  if (!measure) return undefined;

  const valueAttr = measure.attributes?.[0];
  let value: number | undefined;
  if (typeof valueAttr === 'number') {
    value = valueAttr;
  } else if (Array.isArray(valueAttr) && valueAttr.length === 2 && typeof valueAttr[1] === 'number') {
    // Typed value, e.g. ['IFCLENGTHMEASURE', 0.3048]
    value = valueAttr[1];
  }
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;

  let componentScale = 1;
  const componentRef = getReference(measure.attributes?.[1]);
  if (componentRef !== undefined) {
    const component = resolveEntity(componentRef);
    if (component && (component.type ?? '').toUpperCase() === 'IFCSIUNIT') {
      const prefix = component.attributes?.[2];
      if (typeof prefix === 'string' && prefix !== '$') {
        const prefixScale = SI_PREFIX_SCALE[prefix.replace(/\./g, '').toUpperCase()];
        if (prefixScale !== undefined) componentScale = prefixScale;
      }
    }
  }

  return value * componentScale;
}

function extractProjectedCRS(
  entity: IfcEntity,
  resolveEntity?: (id: number) => IfcEntity | undefined,
): ProjectedCRS {
  // IfcProjectedCRS attributes (IFC4):
  // [0] Name (IfcLabel)
  // [1] Description (OPTIONAL IfcText)
  // [2] GeodeticDatum (OPTIONAL IfcIdentifier)
  // [3] VerticalDatum (OPTIONAL IfcIdentifier)
  // [4] MapProjection (OPTIONAL IfcIdentifier)
  // [5] MapZone (OPTIONAL IfcIdentifier)
  // [6] MapUnit (OPTIONAL IfcNamedUnit)

  // Resolve MapUnit reference to determine actual unit + scale
  let mapUnit: string | undefined;
  let mapUnitScale: number | undefined;
  const mapUnitRef = getReference(entity.attributes[6]);
  if (mapUnitRef) {
    mapUnit = 'METRE'; // default if we can't resolve
    mapUnitScale = 1;
    if (resolveEntity) {
      const unitEntity = resolveEntity(mapUnitRef);
      if (unitEntity) {
        // MapUnit is an IfcNamedUnit, which is IfcSIUnit OR
        // IfcConversionBasedUnit. Attribute 2 means something different in
        // each: `Prefix` on the SI unit, `Name` on the conversion-based one.
        // Reading slot 2 as a prefix unconditionally means a foot-based
        // MapUnit ('FOOT' is not an SI prefix) misses every lookup and falls
        // through to the METRE/1.0 default — so a georeference in feet reads
        // back 3.28x wrong, silently. ifc-lite's own exporter writes exactly
        // that IFCCONVERSIONBASEDUNIT form for FOOT and US SURVEY FOOT
        // (packages/export/src/step-georeferencing.ts), and no fixture ever
        // set a non-metre map unit, so the round trip only ever saw METRE.
        if ((unitEntity.type ?? '').toUpperCase() === 'IFCCONVERSIONBASEDUNIT') {
          // IFCCONVERSIONBASEDUNIT: [0] Dimensions, [1] UnitType, [2] Name,
          // [3] ConversionFactor (IfcMeasureWithUnit)
          const rawName = getString(unitEntity.attributes?.[2]);
          const name = rawName?.replace(/^'|'$/g, '').trim().toUpperCase();
          // The name table first (it carries the exact defined ratios, e.g.
          // the US survey foot's 1200/3937), then the file's own declared
          // conversion factor for a unit name we do not know.
          const scale = (name ? CONVERSION_BASED_UNIT_FACTORS[name] : undefined)
            ?? resolveMeasureWithUnit(unitEntity.attributes?.[3], resolveEntity);
          if (scale !== undefined && Number.isFinite(scale) && scale > 0) {
            mapUnitScale = scale;
            if (name) mapUnit = name;
          }
        } else {
          // IFCSIUNIT: [0] Dimensions, [1] UnitType, [2] Prefix, [3] Name
          const prefix = unitEntity.attributes?.[2];
          if (prefix != null && prefix !== '$' && typeof prefix === 'string') {
            const prefixStr = prefix.replace(/\./g, '').toUpperCase();
            const prefixScale = SI_PREFIX_SCALE[prefixStr];
            if (prefixScale !== undefined) {
              mapUnitScale = prefixScale;
              mapUnit = prefixStr === 'MILLI' ? 'MILLIMETRE' : prefixStr + 'METRE';
            }
          }
          // No prefix → base METRE → scale = 1
        }
      }
    }
  }
  // If mapUnitRef is absent → mapUnit stays undefined, mapUnitScale stays undefined
  // → per IFC spec, MapConversion uses the project's length unit

  return {
    id: entity.expressId,
    name: getString(entity.attributes[0]) || '',
    description: getString(entity.attributes[1]),
    geodeticDatum: getString(entity.attributes[2]),
    verticalDatum: getString(entity.attributes[3]),
    mapProjection: getString(entity.attributes[4]),
    mapZone: getString(entity.attributes[5]),
    mapUnit,
    mapUnitScale,
  };
}
