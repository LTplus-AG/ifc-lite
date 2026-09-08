/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve a model's georeference and build a Google Earth KMZ. Shared by the
 * Location panel's "Google Earth" button and the menubar "Export KMZ" entry so
 * both go through one georef → WGS84 → COLLADA KMZ path (#1427).
 */

import { extractGeoreferencingOnDemand, extractLengthUnitScale, type IfcDataStore, type MapConversion, type ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { GeorefMutationData } from '@/store/slices/mutationSlice';
import { getMapUnitScale } from './cesium-placement';
import { mergeMapConversion, mergeProjectedCRS, resolveEpsetMapUnitScale } from './effective-georef';
import { resolveMapUnitToMetreScale } from './geo-scale';
import { withInstancedMeshes, type InstancedModelRange } from '../../utils/instancedExport.js';
import { effectiveMapConversionForGeometry } from './map-absolute';
import { reprojectToLatLon } from './reproject';
import { buildKmz, type KmzAltitudeMode, type KmzProcessor } from './kmz-exporter';
import { suggestAbsoluteAltitudeForKmz } from './kmz-altitude-hint';

/** True if the data store carries usable georeferencing (so a KMZ export can run). */
export function modelHasGeoreference(dataStore: IfcDataStore | null | undefined): boolean {
  if (!dataStore) return false;
  return extractGeoreferencingOnDemand(dataStore)?.hasGeoreference === true;
}

export interface BuildKmzInput {
  geometryResult: GeometryResult;
  /** This model's global-id bracket, or `null` when it is provably the only model
   *  loaded — see {@link ResolvedKmzGeorefInput.instancedModelRange}. */
  instancedModelRange: InstancedModelRange | null;
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
  // `mergeProjectedCRS` alone doesn't know the georeference's `source`, so an
  // IFC2x3 `ePSet_MapConversion` file with no explicit ePset MapUnit leaves
  // `mapUnitScale` undefined here -- which `resolveMapUnitToMetreScale`
  // (inside `suggestAbsoluteAltitudeForKmz`) then reads as "treat offsets as
  // metres" instead of the buildingSMART convention (project length unit).
  // `getEffectiveGeoreference` applies this same correction; this function
  // built its own merge via `extractGeoreferencingOnDemand` and previously
  // didn't (matches the #2859 fix applied to `GeoreferencingPanel.tsx`).
  if (crs) crs.mapUnitScale = resolveEpsetMapUnitScale(info?.source, crs.mapUnitScale, scale);
  return suggestAbsoluteAltitudeForKmz(input.geometryResult.coordinateInfo, conversion, crs, scale);
}

/**
 * KML `<heading>` (via xAxisAbscissa/xAxisOrdinate) for a model's COLLADA
 * asset — routed through the same map-absolute guard (#2526) that
 * {@link reprojectToLatLon} already applies to the PIN position.
 *
 * The .dae geometry the KMZ embeds is whatever the guard determines: for a
 * map-absolute file, the mesh vertices are already map-axis-aligned (that is
 * the guard's whole premise — geometry sits at the absolute coordinate with
 * no conversion needed on top), so the heading must be the identity axis
 * too, not the authored (repeated-anchor) rotation. Passing the authored
 * axis here would correctly place the model (via the guarded position) and
 * then rotate its already-aligned geometry by the very rotation the guard
 * exists to suppress.
 */
export function resolveKmzHeading(
  conversion: MapConversion,
  crs: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
  coordinateInfo: CoordinateInfo | undefined,
): { xAxisAbscissa?: number; xAxisOrdinate?: number } {
  const mapScale = resolveMapUnitToMetreScale(crs?.mapUnitScale, lengthUnitScale);
  const effective = effectiveMapConversionForGeometry(conversion, mapScale, coordinateInfo);
  return { xAxisAbscissa: effective.xAxisAbscissa, xAxisOrdinate: effective.xAxisOrdinate };
}

/**
 * A georeference that has ALREADY been merged with pending edits — what a panel
 * holding `mergedConversion`/`mergedCRS` props has in hand, and what
 * {@link buildKmzForModel} produces after extracting from the data store.
 */
export interface ResolvedKmzGeorefInput {
  /** Merged `IfcMapConversion`. Passed AUTHORED; the map-absolute guard is applied here. */
  conversion: MapConversion;
  /** Merged `IfcProjectedCRS`. */
  crs: ProjectedCRS;
  /** From the model's `GeometryResult` (bounds + RTC offset). */
  coordinateInfo: CoordinateInfo | undefined;
  /** IFC project length unit to metres. */
  lengthUnitScale: number;
  /**
   * The model's geometry. Deliberately NOT a mesh array: the COMPLETE set is
   * derived here via `withInstancedMeshes`, because `geometryResult.meshes`
   * omits every GPU-instanced occurrence and a caller passing it directly
   * exported a model with its repeated geometry missing (#2577) — the same way
   * both call sites once passed a raw conversion and skipped the placement
   * corrections. There is no way to hand in a pre-flattened list.
   */
  geometryResult: GeometryResult;
  /**
   * This model's global-id bracket (`{ idOffset, maxExpressId }`), used to scope
   * `getAllInstancedMeshData()`'s unfiltered (all-loaded-models) output down to
   * just this model's occurrences — GPU instancing stopped being primary-only on
   * 2026-08-06 (#2255), so a federated model can carry instanced entities too, and
   * without this bracket a federation of N models would splice every other
   * model's instanced occurrences into this one's KMZ. `null` only when this is
   * provably the sole model loaded (nothing else to wrongly include) — same
   * argument the glTF/IFC exporters pass.
   */
  instancedModelRange: InstancedModelRange | null;
  /** Display name / file stem. */
  name: string;
  altitudeMode?: KmzAltitudeMode;
}

/**
 * THE place a georeference becomes a KMZ placement. Every surface that exports
 * a KMZ goes through here, and none of them computes lat/lon, altitude or
 * heading itself.
 *
 * That is the whole point of the function existing (#2526 follow-up). The
 * Location panel's "Google Earth" button used to call {@link buildKmz}
 * directly with `mapConversion.xAxisAbscissa/xAxisOrdinate` and a raw
 * `mapConversion.orthogonalHeight`, while the Export KMZ dialog went through
 * `buildKmzForModel`. So the dialog got the map-absolute guard, the map-unit
 * altitude scaling and the RTC Z fold-back, and the panel beside it got none
 * of the three — same model, same button label, two different files, no type
 * error and no failing test to say so. A map-absolute file (#2526) exported
 * from the panel came out rotated by the very axis the guard exists to
 * suppress AND sunk by its whole site elevation.
 *
 * Callers hand over the AUTHORED (merged) conversion and get the corrected
 * placement back; there is deliberately no way to pass a pre-guarded one, so
 * a call site cannot opt out of the correction by accident.
 *
 * `createProcessor` is the same wasm seam {@link buildKmz} takes, forwarded so
 * tests can drive this end to end without the engine.
 */
export async function buildKmzForResolvedGeoref(
  input: ResolvedKmzGeorefInput,
  createProcessor?: () => KmzProcessor,
): Promise<Uint8Array | KmzBuildError> {
  const meshes = withInstancedMeshes(input.geometryResult, input.instancedModelRange).meshes as MeshData[];
  if (!meshes.length) return 'no-geometry';
  const { conversion, crs, coordinateInfo, lengthUnitScale } = input;
  const latLon = await reprojectToLatLon(conversion, crs, coordinateInfo, lengthUnitScale);
  if (!latLon) return 'unprojectable';
  const heading = resolveKmzHeading(conversion, crs, lengthUnitScale, coordinateInfo);
  const opts = {
    latLon,
    altitude: computeKmzAltitude(conversion.orthogonalHeight, crs, lengthUnitScale, coordinateInfo),
    xAxisAbscissa: heading.xAxisAbscissa,
    xAxisOrdinate: heading.xAxisOrdinate,
    meshes,
    name: input.name,
    altitudeMode: input.altitudeMode,
  };
  return createProcessor ? buildKmz(opts, createProcessor) : buildKmz(opts);
}

/**
 * Resolve a model's (merged) georeference to WGS84 and build a Google Earth KMZ
 * (a COLLADA model + KML placement). Returns the KMZ bytes, or a `KmzBuildError`
 * string when the model isn't georeferenced or its location can't be projected.
 *
 * Extraction + merge only; the placement itself is
 * {@link buildKmzForResolvedGeoref}'s, shared with the Location panel.
 */
export async function buildKmzForModel(
  input: BuildKmzInput,
  createProcessor?: () => KmzProcessor,
): Promise<Uint8Array | KmzBuildError> {
  // No flat-mesh guard here: `meshes` can be empty while the model still has
  // geometry, because every occurrence is GPU-instanced. Gating on it would
  // report "no geometry" for a model that exports fine — the same
  // flat-list-is-not-the-model mistake this function was fixed for (#2577).
  // `buildKmzForResolvedGeoref` makes that call against the COMPLETE set.
  const info = extractGeoreferencingOnDemand(input.dataStore);
  const scale = extractLengthUnitScale(input.dataStore.source, input.dataStore.entityIndex) ?? 1;
  // Apply pending georef edits BEFORE deciding the model is unreferenced: a model
  // whose only georeference comes from unsaved edits (mutations) has no extracted
  // `hasGeoreference`, but the merged conversion/CRS still place it. The merged
  // result is the source of truth — gate on it, not on the on-disk info (#1427).
  const conversion = mergeMapConversion(info?.mapConversion, input.mutations?.mapConversion);
  const crs = mergeProjectedCRS(info?.projectedCRS, input.mutations?.projectedCRS, scale);
  if (!conversion || !crs) return 'not-georeferenced';
  // Same ePset MapUnit correction `getEffectiveGeoreference` applies (see
  // `kmzSuggestsAbsoluteAltitude` above) -- without it, a millimetre IFC2x3
  // project whose only georeference is `ePset_MapConversion` (no explicit
  // MapUnit) exports every eastings/northings/orthogonalHeight value scaled
  // by 1 instead of 0.001: the reprojected pin lands ~1000x away from the
  // model, and `computeKmzAltitude`'s altitude is 1000x too high.
  crs.mapUnitScale = resolveEpsetMapUnitScale(info?.source, crs.mapUnitScale, scale);
  return buildKmzForResolvedGeoref({
    conversion,
    crs,
    coordinateInfo: input.geometryResult.coordinateInfo,
    lengthUnitScale: scale,
    geometryResult: input.geometryResult,
    instancedModelRange: input.instancedModelRange,
    name: input.name,
    altitudeMode: input.altitudeMode,
  }, createProcessor);
}
