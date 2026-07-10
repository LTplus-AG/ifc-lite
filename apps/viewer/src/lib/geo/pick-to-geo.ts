/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Convert a picked viewer-space point (Y-up metres) into projected map
 * coordinates (Eastings / Northings / orthogonal Height, in the CRS map
 * unit) using the anchor model's effective IfcMapConversion +
 * IfcProjectedCRS.
 *
 * All conversions go through `viewerDeltaToProjectedDelta` /
 * `metersToMapUnits`, which are unit- and IfcMapConversion.Scale-aware.
 * Do NOT swap in the parser's `transformToWorld`: it assumes local coords
 * in map units and is ~1000x off for mm-unit projects whose geometry the
 * viewer already converted to metres.
 *
 * Height is the authored orthogonal height in the map CRS — no vertical
 * datum transform is applied in the browser.
 */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import {
  getMapUnitScale,
  metersToMapUnits,
  viewerDeltaToProjectedDelta,
} from './cesium-placement';
import {
  hasStandardGeoreferencing,
  type EffectiveGeoreference,
} from './effective-georef';
import { totalYupOffset } from './ifc-origin';

/** Effective georef narrowed to the fields the projection math requires. */
export type UsableEffectiveGeoref = EffectiveGeoreference & {
  mapConversion: MapConversion;
  projectedCRS: ProjectedCRS;
};

/**
 * True when the georef can meaningfully place a picked point in a projected
 * CRS: a real IfcMapConversion + named IfcProjectedCRS. Excludes the
 * synthesised `siteLocation` source (legacy EPSG:4326 lat/lon from IfcSite),
 * whose degree-based offsets would produce misleading E/N/H output.
 */
export function hasUsableMapGeoref(
  georef: EffectiveGeoreference | null | undefined,
): georef is UsableEffectiveGeoref {
  return Boolean(georef && hasStandardGeoreferencing(georef));
}

export interface ProjectedPoint {
  /** Eastings in the CRS map unit (e.g. mm when MapUnit is MILLIMETRE). */
  eastings: number;
  /** Northings in the CRS map unit. */
  northings: number;
  /** Authored orthogonal height in the CRS map unit (no datum transform). */
  height: number;
  /** CRS identifier, e.g. "EPSG:32760". */
  crsName: string;
}

/**
 * Viewer-space (Y-up) position where the model's IFC (0,0,0) sits.
 * Synchronous equivalent of `computeIfcOriginViewerPosition`'s `'self'`
 * branch — valid for a standalone model or the federation ANCHOR model
 * (federated vertices are re-baked into the anchor frame, so picked points
 * must always be converted through the anchor's georef and origin).
 */
export function ifcOriginViewerPoint(
  coordinateInfo?: CoordinateInfo,
): { x: number; y: number; z: number } {
  const off = totalYupOffset(coordinateInfo);
  return { x: -off.x, y: -off.y, z: -off.z };
}

/**
 * Project a picked viewer point (Y-up metres) into the map CRS.
 *
 * @param point        Picked position in viewer space (Y-up metres).
 * @param georef       Anchor model's effective georef (map conversion + CRS).
 * @param originViewer Viewer position of the anchor's IFC (0,0,0) — see
 *                     {@link ifcOriginViewerPoint}.
 */
export function viewerPointToProjected(
  point: { x: number; y: number; z: number },
  georef: UsableEffectiveGeoref,
  originViewer: { x: number; y: number; z: number },
): ProjectedPoint {
  const { mapConversion, projectedCRS, lengthUnitScale } = georef;
  const delta = viewerDeltaToProjectedDelta(
    point.x - originViewer.x,
    point.z - originViewer.z,
    mapConversion,
    projectedCRS,
    lengthUnitScale,
  );
  return {
    eastings: mapConversion.eastings + delta.eastings,
    northings: mapConversion.northings + delta.northings,
    height: mapConversion.orthogonalHeight
      + metersToMapUnits(point.y - originViewer.y, projectedCRS, lengthUnitScale),
    crsName: projectedCRS.name,
  };
}

/**
 * Decimal places giving roughly millimetre resolution in the CRS map unit:
 * 3 decimals for a metre CRS, 0 for a millimetre CRS, clamped to [0, 3].
 */
export function mapCoordinateDecimals(
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
): number {
  const metresPerMapUnit = getMapUnitScale(projectedCRS, lengthUnitScale);
  const decimals = Math.ceil(Math.log10(metresPerMapUnit * 1000));
  return Math.min(3, Math.max(0, decimals));
}
