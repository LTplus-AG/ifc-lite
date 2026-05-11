/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  extractGeoreferencingOnDemand,
  extractLengthUnitScale,
  type GeoreferenceInfo,
  type IfcDataStore,
  type MapConversion,
  type ProjectedCRS,
} from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';

export interface GeorefMutationDataLike {
  projectedCRS?: Partial<ProjectedCRS>;
  mapConversion?: Partial<MapConversion>;
}

export interface EffectiveGeoreference extends GeoreferenceInfo {
  hasGeoreference: true;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale: number;
}

/**
 * Compute the effective horizontal scale to apply to viewer-space coordinates
 * (which are already in metres) when transforming through IfcMapConversion.
 *
 * Per the IFC schema, IfcMapConversion.Scale converts LOCAL ENGINEERING
 * coordinates (in the project's length unit) to MAP coordinates (in the map
 * CRS unit). For a typical file with mm project units and m map units, the
 * Scale attribute is 0.001.
 *
 * The IFC formula is:
 *   E_map_units = Eastings + (X_local * absc - Y_local * ordi) * Scale
 *
 * To produce metres for proj4, we multiply by mapUnitScale; and X_local can be
 * recovered from the metre-converted geometry as X_metres / lengthUnitScale.
 * Substituting:
 *   E_metres = mapUnitScale * Eastings
 *            + (mapUnitScale * Scale / lengthUnitScale)
 *              * (X_metres * absc - Y_metres * ordi)
 *
 * So when geometry has already been converted to metres (as ifc-lite does),
 * the effective horizontal scale is (Scale * mapUnitScale) / lengthUnitScale.
 * For files where Scale is set per IFC spec to bridge the unit difference
 * (Scale = lengthUnitScale / mapUnitScale), this evaluates to 1.0 and the
 * geometry passes through unchanged. Applying the raw Scale would otherwise
 * double-scale and shrink/expand the model — see issue #595.
 */
export function getEffectiveHorizontalScale(
  ifcMapConversionScale: number | undefined,
  mapUnitScale: number,
  lengthUnitScale: number,
): number {
  const scale = ifcMapConversionScale ?? 1.0;
  const lus = lengthUnitScale > 0 ? lengthUnitScale : 1;
  const mus = mapUnitScale > 0 ? mapUnitScale : 1;
  return (scale * mus) / lus;
}

export interface ScaleUnitMismatch {
  /** Effective horizontal scale applied to viewer-space (metre) geometry. */
  effectiveScale: number;
  /** Raw IfcMapConversion.Scale (or 1 if absent). */
  rawScale: number;
  /** Map unit → metres factor (e.g. 1 for METRE, 0.001 for MILLIMETRE). */
  mapUnitScale: number;
  /** Project length unit → metres factor. */
  lengthUnitScale: number;
  /**
   * Scale value the file would need for the IFC formula to map local→map
   * coordinates without any extra scaling (i.e. lengthUnitScale / mapUnitScale).
   */
  expectedScale: number;
}

/**
 * Detect when IfcMapConversion.Scale is inconsistent with the project and map
 * units. Per the IFC schema, Scale × mapUnitScale should equal lengthUnitScale
 * (i.e. effectiveScale = 1.0). A deviation usually means the authoring tool
 * forgot to set Scale to bridge a unit difference (e.g. mm project + m map
 * with Scale=1.0). Files like this render at the wrong size in any tool that
 * follows the schema strictly — see issue #595.
 *
 * Returns null when the values are consistent (within 0.5% of 1.0); otherwise
 * returns the diagnostic data so callers can surface a warning.
 */
export function detectScaleUnitMismatch(
  ifcMapConversionScale: number | undefined,
  mapUnitScale: number | undefined,
  lengthUnitScale: number | undefined,
): ScaleUnitMismatch | null {
  const lus = lengthUnitScale && lengthUnitScale > 0 ? lengthUnitScale : 1;
  const mus = mapUnitScale && mapUnitScale > 0 ? mapUnitScale : 1;
  const rawScale = ifcMapConversionScale ?? 1.0;
  const effectiveScale = (rawScale * mus) / lus;
  if (Math.abs(effectiveScale - 1) <= 0.005) return null;
  return {
    effectiveScale,
    rawScale,
    mapUnitScale: mus,
    lengthUnitScale: lus,
    expectedScale: lus / mus,
  };
}

export function inferMapUnitScale(mapUnit: string | undefined, fallback?: number): number | undefined {
  if (!mapUnit) return fallback;
  const normalized = mapUnit.toUpperCase();
  if (normalized.includes('US') && (normalized.includes('SURVEY') || normalized.includes('FTUS'))) {
    return 0.3048006096;
  }
  if (normalized.includes('FOOT') || normalized.includes('FEET')) return 0.3048;
  if (normalized.includes('MILLI')) return 0.001;
  if (normalized.includes('CENTI')) return 0.01;
  if (normalized.includes('DECI')) return 0.1;
  if (normalized.includes('KILO')) return 1000;
  if (normalized.includes('METRE') || normalized.includes('METER')) return 1;
  return fallback;
}

export function getIfcLengthUnitScale(dataStore: IfcDataStore | null | undefined): number {
  if (!dataStore?.source?.length || !dataStore.entityIndex) return 1;
  return extractLengthUnitScale(dataStore.source, dataStore.entityIndex);
}

export function mergeProjectedCRS(
  original: ProjectedCRS | undefined,
  mutations: Partial<ProjectedCRS> | undefined,
  lengthUnitScale: number,
): ProjectedCRS | undefined {
  if (!original && !mutations) return undefined;
  const mapUnit = mutations?.mapUnit ?? original?.mapUnit;
  const mapUnitScale = mutations?.mapUnit !== undefined
    ? inferMapUnitScale(mapUnit, lengthUnitScale)
    : original?.mapUnitScale ?? inferMapUnitScale(mapUnit, undefined);
  return {
    id: original?.id ?? 0,
    name: (mutations?.name ?? original?.name ?? '') as string,
    description: mutations?.description ?? original?.description,
    geodeticDatum: mutations?.geodeticDatum ?? original?.geodeticDatum,
    verticalDatum: mutations?.verticalDatum ?? original?.verticalDatum,
    mapProjection: mutations?.mapProjection ?? original?.mapProjection,
    mapZone: mutations?.mapZone ?? original?.mapZone,
    mapUnit,
    mapUnitScale,
  };
}

export function mergeMapConversion(
  original: MapConversion | undefined,
  mutations: Partial<MapConversion> | undefined,
): MapConversion | undefined {
  if (!original && !mutations) return undefined;
  return {
    id: original?.id ?? 0,
    sourceCRS: original?.sourceCRS ?? 0,
    targetCRS: original?.targetCRS ?? 0,
    eastings: (mutations?.eastings ?? original?.eastings ?? 0) as number,
    northings: (mutations?.northings ?? original?.northings ?? 0) as number,
    orthogonalHeight: (mutations?.orthogonalHeight ?? original?.orthogonalHeight ?? 0) as number,
    xAxisAbscissa: mutations?.xAxisAbscissa ?? original?.xAxisAbscissa,
    xAxisOrdinate: mutations?.xAxisOrdinate ?? original?.xAxisOrdinate,
    scale: mutations?.scale ?? original?.scale,
  };
}

export function getEffectiveGeoreference(
  dataStore: IfcDataStore | null | undefined,
  coordinateInfo?: CoordinateInfo,
  mutations?: GeorefMutationDataLike,
): EffectiveGeoreference | null {
  if (!dataStore) return null;
  const original = extractGeoreferencingOnDemand(dataStore);
  const lengthUnitScale = getIfcLengthUnitScale(dataStore);
  const projectedCRS = mergeProjectedCRS(
    original?.projectedCRS,
    mutations?.projectedCRS,
    lengthUnitScale,
  );
  const mapConversion = mergeMapConversion(original?.mapConversion, mutations?.mapConversion);

  if (!projectedCRS && !mapConversion) return null;
  return {
    hasGeoreference: true,
    projectedCRS,
    mapConversion,
    coordinateInfo,
    lengthUnitScale,
    transformMatrix: original?.transformMatrix,
  };
}
