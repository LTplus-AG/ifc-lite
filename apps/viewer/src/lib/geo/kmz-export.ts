/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve a model's georeference and build a Google Earth KMZ. Shared by the
 * Location panel's "Google Earth" button and the menubar "Export KMZ" entry so
 * both go through one georef → WGS84 → COLLADA KMZ path (#1427).
 */

import { extractGeoreferencingOnDemand, extractLengthUnitScale, type IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { GeorefMutationData } from '@/store/slices/mutationSlice';
import { mergeMapConversion, mergeProjectedCRS } from './effective-georef';
import { reprojectToLatLon } from './reproject';
import { buildKmz, type KmzAltitudeMode } from './kmz-exporter';

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
    altitude: conversion.orthogonalHeight ?? 0,
    xAxisAbscissa: conversion.xAxisAbscissa,
    xAxisOrdinate: conversion.xAxisOrdinate,
    meshes: input.geometryResult.meshes as MeshData[],
    name: input.name,
    altitudeMode: input.altitudeMode,
  });
}
