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
import {
  detectScaleUnitMismatch,
  getEffectiveHorizontalScale,
  inferMapUnitScale,
  type ScaleUnitMismatch,
} from './geo-scale';

export {
  detectScaleUnitMismatch,
  getEffectiveHorizontalScale,
  inferMapUnitScale,
  type ScaleUnitMismatch,
} from './geo-scale';

export interface GeorefMutationDataLike {
  projectedCRS?: Partial<ProjectedCRS>;
  mapConversion?: Partial<MapConversion>;
}

export interface EffectiveGeoreference extends GeoreferenceInfo {
  hasGeoreference: true;
  coordinateInfo?: CoordinateInfo;
  lengthUnitScale: number;
}

export function hasStandardGeoreferencing(
  georef: Pick<GeoreferenceInfo, 'source' | 'projectedCRS' | 'mapConversion'> | null | undefined,
): boolean {
  return Boolean(
    georef
    && georef.source !== 'siteLocation'
    && georef.projectedCRS?.name
    && georef.mapConversion
    // PR #1965 review: presence alone isn't enough -- a malformed
    // IfcMapConversion with a NaN eastings/northings/orthogonalHeight must
    // not pass this gate. `hasUsableMapGeoref` (pick-to-geo.ts) delegates
    // here for the XYZ readout and federation-alignment gate, so this
    // finiteness check protects both, not just the DXF underlay path.
    // `orthogonalHeight` joins eastings/northings here (2nd PR #1965 review
    // round) because every consumer reads it straight through with no
    // fallback -- `viewerPointToProjected` (pick-to-geo.ts) adds it directly
    // into the returned height, and `federationAlign.ts`'s `hC`/`hS`/`ifcZr`
    // computations multiply it by the map-unit scale and add it to the IFC Z
    // used to align two models. A NaN here has nowhere to go but straight
    // into Z.
    && Number.isFinite(georef.mapConversion.eastings)
    && Number.isFinite(georef.mapConversion.northings)
    && Number.isFinite(georef.mapConversion.orthogonalHeight)
    // Scale and the XAxisAbscissa/XAxisOrdinate axis pair are DELIBERATELY
    // NOT part of this finiteness gate, unlike orthogonalHeight above. The
    // DXF export/underlay path (`dxfExportGeoref.ts`'s
    // `resolveGeorefLinearParams`) already substitutes finite fallbacks for
    // exactly this case -- Scale=0/NaN/negative becomes 1, a degenerate or
    // non-finite axis becomes the no-rotation default (1, 0) -- specifically
    // so a malformed Scale/axis still renders the DXF underlay somewhere
    // rather than disabling it outright (see that file's "GUARD PHILOSOPHY"
    // header comment). `selectAnchorGeoref` (useAnchorGeoreference.ts) gates
    // anchor selection through this same function, so adding Scale/axis here
    // would make `hasUsableMapGeoref` reject that model as an anchor before
    // `resolveGeorefLinearParams` ever gets a chance to apply its fallback --
    // turning a georeference that currently renders (via the fallback) into
    // one that's silently disabled instead. `orthogonalHeight` has no such
    // downstream fallback anywhere, which is why it's guarded here and
    // Scale/axis are not.
    //
    // This does leave `federationAlign.ts`'s `getAxis()` and
    // `getEffectiveHorizontalScale()` reading a NaN Scale or axis pair
    // without an equivalent fallback (unlike the DXF path) -- a real gap,
    // but a pre-existing one this gate change doesn't widen, and fixing it
    // belongs in that file's own math, not in loosening/tightening this
    // shared presence gate.
  );
}

export function supportsStandardGeoreferencing(
  schemaVersion: string | undefined,
  georef: Pick<GeoreferenceInfo, 'source' | 'projectedCRS' | 'mapConversion'> | null | undefined,
): boolean {
  if (hasStandardGeoreferencing(georef)) return true;
  // Any extracted IfcProjectedCRS / IfcMapConversion makes editing useful,
  // regardless of the declared schema. IFC2X3 files commonly carry these
  // via extensions; once we've parsed them, surface the full editor instead
  // of hiding behind a schema-version notice that contradicts what the
  // properties panel already shows for the same entities.
  if (
    georef
    && georef.source !== 'siteLocation'
    && (georef.projectedCRS?.name || georef.mapConversion)
  ) {
    return true;
  }
  return !schemaVersion?.toUpperCase().includes('2X3');
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
  // A CLEARED MapUnit is an ABSENT MapUnit, not an unparseable one.
  //
  // The panel's MapUnit editor is a `<select>` whose first option has an empty
  // value, and `commitEdit` deliberately permits an empty commit for selects
  // (`if (!trimmed && !hint.isSelect) return;`). So `''` reaches here as an
  // edit. `''` is not `undefined`, so it took the edited branch, and
  // `inferMapUnitScale('', lengthUnitScale)` returns the FALLBACK — the
  // project's length-unit scale.
  //
  // That is precisely the reading `resolveMapUnitToMetreScale` exists to
  // reject: its doc says "when no explicit MapUnit is set, treat the offsets
  // as metres", because surveying pipelines emit metre offsets regardless of
  // the project unit. So clearing the field opted the user INTO the failure
  // the heuristic was written to avoid — for a millimetre project, a 1000×
  // under-scale that flings the model outside the CRS's valid range.
  //
  // Passing `undefined` as the fallback for an empty string routes it to the
  // absent path (scale 1). A non-empty but unparseable MapUnit keeps today's
  // length-unit fallback.
  const mapUnitScale = mutations?.mapUnit !== undefined
    ? inferMapUnitScale(mapUnit, mapUnit ? lengthUnitScale : undefined)
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

/**
 * `?? 0` alone lets a malformed `IfcMapConversion` (or a bad mutation edit)
 * pass a NaN eastings/northings/orthogonalHeight straight through -- PR #1965
 * review: `mergeMapConversion` used to do exactly that, and the NaN then
 * poisons every point `dxfExportGeoref.ts`'s forward/inverse transform
 * touches, permanently (the corrupted value can land in the DXF underlay's
 * stored `placement`, which survives toggling "georeferenced" back off --
 * see `resolveGeorefLinearParams` and `dxfUnderlayDrawingBounds`). Falls
 * back to 0 exactly like `?? 0` already did for the "missing" case, just
 * extended to the "present but non-finite" case too.
 */
function finiteOr0(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
    eastings: finiteOr0(mutations?.eastings ?? original?.eastings),
    northings: finiteOr0(mutations?.northings ?? original?.northings),
    orthogonalHeight: finiteOr0(mutations?.orthogonalHeight ?? original?.orthogonalHeight),
    xAxisAbscissa: mutations?.xAxisAbscissa ?? original?.xAxisAbscissa,
    xAxisOrdinate: mutations?.xAxisOrdinate ?? original?.xAxisOrdinate,
    scale: mutations?.scale ?? original?.scale,
  };
}

/**
 * The buildingSMART IFC2x3 `ePset_MapConversion` convention stores
 * Eastings/Northings in the project length unit — there is no MapUnit in the
 * ePset. So an ePSet-sourced georef with no explicit MapUnit must scale its
 * offsets by the project length-unit → metres factor.
 *
 * Without this, the "absent MapUnit ⇒ treat offsets as metres" heuristic in
 * {@link resolveMapUnitToMetreScale} reads millimetre offsets as metres and
 * flings the model ~1000× outside the CRS valid range (e.g. RD easting
 * 160073528 mm read as 160073 km → reprojection returns null and Cesium can't
 * place the model). Only applies when MapUnit hasn't been set/edited
 * (mapUnitScale still undefined) — an explicit MapUnit always wins.
 */
export function resolveEpsetMapUnitScale(
  source: GeoreferenceInfo['source'] | undefined,
  mapUnitScale: number | undefined,
  lengthUnitScale: number,
): number | undefined {
  if (source === 'ePSetMapConversion' && mapUnitScale === undefined) {
    return lengthUnitScale;
  }
  return mapUnitScale;
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
  if (projectedCRS) {
    // ePset_MapConversion offsets are in the project length unit (no MapUnit).
    projectedCRS.mapUnitScale = resolveEpsetMapUnitScale(
      original?.source,
      projectedCRS.mapUnitScale,
      lengthUnitScale,
    );
  }
  const mapConversion = mergeMapConversion(original?.mapConversion, mutations?.mapConversion);

  if (!projectedCRS && !mapConversion) return null;
  return {
    hasGeoreference: true,
    projectedCRS,
    mapConversion,
    coordinateInfo,
    lengthUnitScale,
    source: original?.source,
    transformMatrix: original?.transformMatrix,
  };
}
