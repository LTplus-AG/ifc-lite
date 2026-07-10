/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve a model's georeference and build a Google Earth KMZ. Shared by the
 * Location panel's "Google Earth" button and the menubar "Export KMZ" entry so
 * both go through one georef → WGS84 → COLLADA KMZ path (#1427).
 */

import { extractGeoreferencingOnDemand, extractLengthUnitScale, type IfcDataStore, type ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { GeorefMutationData } from '@/store/slices/mutationSlice';
import { getMapUnitScale } from './cesium-placement';
import { mergeMapConversion, mergeProjectedCRS } from './effective-georef';
import { reprojectToLatLon } from './reproject';
import { buildKmz, type KmzAltitudeMode } from './kmz-exporter';
import { suggestAbsoluteAltitudeForKmz } from './kmz-altitude-hint';

/** True if the data store carries usable georeferencing (so a KMZ export can run). */
export function modelHasGeoreference(dataStore: IfcDataStore | null | undefined): boolean {
  if (!dataStore) return false;
  return extractGeoreferencingOnDemand(dataStore)?.hasGeoreference === true;
}

export interface BuildKmzInput {
  geometryResult: GeometryResult;
  dataStore: IfcDataStore;
  /** Pending georef edits for this model (store `georefMutations.get(modelId)`). */
  mutations?: GeorefMutationData;
  /** Display name / file stem. */
  name: string;
  /**
   * KML vertical placement (#1427). `'clampToGround'` (default) rests the model on
   * the terrain — the robust choice that can never float; `'absolute'` honours the
   * model's OrthogonalHeight as a true MSL elevation. Omit for ground.
   */
  altitudeMode?: KmzAltitudeMode;
}

/** Why a KMZ build could not run (for a precise UI message). */
export type KmzBuildError = 'not-georeferenced' | 'unprojectable' | 'no-geometry';

/**
 * KML `<altitude>`: metres MSL of the model ORIGIN (ignored under clampToGround).
 * OrthogonalHeight is authored in map units, not metres — a mm-CRS file was
 * placed 1000x off — and when the wasm RTC rebase fired it subtracted its offset
 * from every mesh Z the COLLADA exporter later bakes, so fold `rtc.z` back in.
 * Mirrors `computeIfcOriginHeight` (cesium-placement.ts), minus the model-centre
 * term: the .dae keeps geometry Z, whereas the Cesium GLB is re-centred.
 */
export function computeKmzAltitude(
  orthogonalHeight: number | undefined,
  crs: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
  coordinateInfo: CoordinateInfo | undefined,
): number {
  const mapScale = getMapUnitScale(crs, lengthUnitScale);
  return (orthogonalHeight ?? 0) * mapScale + (coordinateInfo?.wasmRtcOffset?.z ?? 0);
}

/**
 * Whether the KMZ dialog should hint at "True elevation (MSL)" for this model:
 * true when the geometry's minimum Z is implausibly high for a local datum
 * while the (merged) map conversion carries ~no OrthogonalHeight - i.e. the
 * elevation is baked into geometry Z, so the clampToGround default would pin
 * project zero to the terrain and float the building by that Z (#1427
 * follow-up). Resolves the georef exactly like {@link buildKmzForModel}
 * (mutations merged, map-unit scaled); cheap after the first call per store.
 */
export function kmzSuggestsAbsoluteAltitude(
  input: Pick<BuildKmzInput, 'geometryResult' | 'dataStore' | 'mutations'>,
): boolean {
  const info = extractGeoreferencingOnDemand(input.dataStore);
  const scale = extractLengthUnitScale(input.dataStore.source, input.dataStore.entityIndex) ?? 1;
  const conversion = mergeMapConversion(info?.mapConversion, input.mutations?.mapConversion);
  const crs = mergeProjectedCRS(info?.projectedCRS, input.mutations?.projectedCRS, scale);
  return suggestAbsoluteAltitudeForKmz(input.geometryResult.coordinateInfo, conversion, crs, scale);
}

/**
 * Resolve a model's (merged) georeference to WGS84 and build a Google Earth KMZ
 * (a COLLADA model + KML placement). Returns the KMZ bytes, or a `KmzBuildError`
 * string when the model isn't georeferenced or its location can't be projected.
 */
export async function buildKmzForModel(input: BuildKmzInput): Promise<Uint8Array | KmzBuildError> {
  if (!input.geometryResult.meshes?.length) return 'no-geometry';
  const info = extractGeoreferencingOnDemand(input.dataStore);
  const scale = extractLengthUnitScale(input.dataStore.source, input.dataStore.entityIndex) ?? 1;
  // Apply pending georef edits BEFORE deciding the model is unreferenced: a model
  // whose only georeference comes from unsaved edits (mutations) has no extracted
  // `hasGeoreference`, but the merged conversion/CRS still place it. The merged
  // result is the source of truth — gate on it, not on the on-disk info (#1427).
  const conversion = mergeMapConversion(info?.mapConversion, input.mutations?.mapConversion);
  const crs = mergeProjectedCRS(info?.projectedCRS, input.mutations?.projectedCRS, scale);
  if (!conversion || !crs) return 'not-georeferenced';
  const latLon = await reprojectToLatLon(conversion, crs, input.geometryResult.coordinateInfo, scale);
  if (!latLon) return 'unprojectable';
  return buildKmz({
    latLon,
    altitude: computeKmzAltitude(
      conversion.orthogonalHeight,
      crs,
      scale,
      input.geometryResult.coordinateInfo,
    ),
    xAxisAbscissa: conversion.xAxisAbscissa,
    xAxisOrdinate: conversion.xAxisOrdinate,
    meshes: input.geometryResult.meshes as MeshData[],
    name: input.name,
    altitudeMode: input.altitudeMode,
  });
}
