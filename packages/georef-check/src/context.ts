/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The values every detector derives from the same facts, computed once: which
 * source places the model, the unit scales, the resolved CRS and the
 * positions in metres.
 */

import { builtInExtent, resolveCrs, type ResolvedCrs } from './crs.js';
import type {
  CrsCatalogEntry,
  CrsFact,
  DiagnoseOptions,
  FieldChange,
  GeorefFacts,
  OperationFact,
  Vec2,
  Vec3,
} from './types.js';

/**
 * A map anchor this far from the local origin is at projected-CRS magnitude.
 * Same value as the viewer's MAP_ABSOLUTE_MIN_ANCHOR_METERS (map-absolute.ts),
 * so the two agree on what "map coordinates" means.
 */
export const MAP_MAGNITUDE_METRES = 100_000;

export interface DiagnosisContext {
  facts: GeorefFacts;
  options: DiagnoseOptions;
  /** The operation that places the model (parser winner rule), if any. */
  operation?: OperationFact;
  /** The CRS that goes with it (or the only CRS declared). */
  crs?: CrsFact;
  resolved?: ResolvedCrs;
  catalogEntry?: CrsCatalogEntry;
  /** Project length unit, metres per unit. */
  lengthScale: number;
  /**
   * Metres per map unit. One value when MapUnit is set. When it is unset,
   * readers disagree (project unit vs the CRS's unit), so every plausible
   * reading is listed and detectors that call something a defect require it
   * under all of them.
   */
  mapScales: number[];
  /** True when MapUnit is set. */
  mapUnitKnown: boolean;
  /** Site origin, metres (horizontal only). */
  siteOriginMetres?: Vec2;
  /** Each sampled coordinate family's median, metres (horizontal only), never pooled. */
  geometryMedians: GeometryMedian[];
}

export interface GeometryMedian {
  family: 'cartesianPoints' | 'pointLists';
  metres: Vec2;
}

/** At least {@link MAP_MAGNITUDE_METRES} from the local origin. */
export function atMapMagnitude(v: Vec2 | undefined): v is Vec2 {
  return !!v && Math.hypot(v.x, v.y) >= MAP_MAGNITUDE_METRES;
}

/** The coordinate families whose own median is at map magnitude. */
export function farGeometry(ctx: Pick<DiagnosisContext, 'geometryMedians'>): GeometryMedian[] {
  return ctx.geometryMedians.filter((g) => atMapMagnitude(g.metres));
}

/**
 * Reproject map metres (easting first) to WGS84 through the injected
 * reprojector. Undefined when none is injected, the CRS is unknown to it, it
 * returns a non-finite value, or it throws (the reason is kept for `skipped`).
 */
export function toWgs84(
  ctx: DiagnosisContext,
  code: number,
  e: number,
  n: number,
): { latitude: number; longitude: number } | { error: string } | undefined {
  const reprojector = ctx.options.reprojector;
  if (!reprojector) return undefined;
  let lonLat: readonly number[] | undefined;
  try {
    lonLat = reprojector.toWgs84(code, [e, n]);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return undefined;
  return { longitude: lonLat[0], latitude: lonLat[1] };
}

/** The parser's winner rule: IFC4 entities that claim georeferencing, else the ePSet. */
function effectiveSource(facts: GeorefFacts): { operation?: OperationFact; crs?: CrsFact } {
  const entities = facts.entities;
  const entitiesClaim = !!entities?.operation || (!!entities?.crs && entities.crs.name.trim() !== '');
  if (entitiesClaim) return { operation: entities?.operation, crs: entities?.crs };
  if (facts.ePSet?.operation || facts.ePSet?.crs) return { operation: facts.ePSet.operation, crs: facts.ePSet.crs };
  // A nameless (WKT-only or blank) entity CRS still scales a conversion.
  return { crs: entities?.crs };
}

/** Metres per unit of the CRS's own axes, when known: catalogue, else built-in (UTM and LV grids are metre). */
export function crsUnitScale(ctx: Pick<DiagnosisContext, 'resolved' | 'catalogEntry'>): number | undefined {
  if (ctx.catalogEntry?.unitScale !== undefined) return ctx.catalogEntry.unitScale;
  if (ctx.resolved && builtInExtent(ctx.resolved.code)) return 1;
  return undefined;
}

export function buildContext(facts: GeorefFacts, options: DiagnoseOptions): DiagnosisContext {
  const { operation, crs } = effectiveSource(facts);
  const resolved = resolveCrs(crs, options.crsCatalog);
  const catalogEntry = resolved ? options.crsCatalog?.lookup(resolved.code) : undefined;
  const lengthScale = facts.lengthUnitScale > 0 && Number.isFinite(facts.lengthUnitScale) ? facts.lengthUnitScale : 1;
  const mapUnitKnown = crs?.mapUnitScale !== undefined && crs.mapUnitScale > 0;
  let mapScales: number[];
  if (mapUnitKnown && crs?.mapUnitScale) {
    mapScales = [crs.mapUnitScale];
  } else {
    const fromCrs = crsUnitScale({ resolved, catalogEntry }) ?? 1;
    mapScales = fromCrs === lengthScale ? [fromCrs] : [fromCrs, lengthScale];
  }
  const horizontal = (v: Vec3 | undefined): Vec2 | undefined =>
    v ? { x: v.x * lengthScale, y: v.y * lengthScale } : undefined;
  const geometryMedians: GeometryMedian[] = [];
  for (const family of ['cartesianPoints', 'pointLists'] as const) {
    const metres = horizontal(facts.coordinates?.geometry?.[family]?.median);
    if (metres) geometryMedians.push({ family, metres });
  }
  return {
    facts,
    options,
    operation,
    crs,
    resolved,
    catalogEntry,
    lengthScale,
    mapScales,
    mapUnitKnown,
    siteOriginMetres: horizontal(facts.coordinates?.siteOrigin),
    geometryMedians,
  };
}

export function isIfc2x3(schemaVersion: string): boolean {
  return schemaVersion.toUpperCase().startsWith('IFC2X');
}

/** The EXPRESS (or ePSet property) name of an operation field. */
export function operationAttribute(op: OperationFact, field: 'eastings' | 'northings' | 'orthogonalHeight'): string {
  if (op.source === 'IfcRigidOperation') {
    return { eastings: 'FirstCoordinate', northings: 'SecondCoordinate', orthogonalHeight: 'Height' }[field];
  }
  return { eastings: 'Eastings', northings: 'Northings', orthogonalHeight: 'OrthogonalHeight' }[field];
}

/** True for an IFC4X3 IfcMapConversionScaled (the only reading that carries FactorX/Y/Z, all mandatory there). */
export function isScaledConversion(op: OperationFact): boolean {
  return op.source === 'IfcMapConversion' && (op.factorX !== undefined || op.factorY !== undefined || op.factorZ !== undefined);
}

/** A change to the operation entity (or ePSet), named by its concrete EXPRESS type. */
export function operationChange(op: OperationFact, attribute: string, value: FieldChange['value']): FieldChange {
  const entity = isScaledConversion(op) ? 'IfcMapConversionScaled' : op.source;
  return { entity, entityId: op.entityId, attribute, value };
}

/** A change to the CRS entity (or ePSet); a new IfcProjectedCRS when the file has none. */
export function crsChange(crs: CrsFact | undefined, attribute: string, value: FieldChange['value'], ePSet = false): FieldChange {
  if (!crs) return { entity: ePSet ? 'ePSet_ProjectedCRS' : 'IfcProjectedCRS', attribute, value };
  return { entity: crs.source, entityId: crs.entityId, attribute, value };
}

/** The horizontal rotation of an operation in degrees (anticlockwise from map east), or undefined when it is not a usable direction. */
export function rotationDegrees(op: OperationFact): number | undefined {
  const a = op.xAxisAbscissa ?? 1;
  const b = op.xAxisOrdinate ?? 0;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.hypot(a, b) === 0) return undefined;
  return (Math.atan2(b, a) * 180) / Math.PI;
}

export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
