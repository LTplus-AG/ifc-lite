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
