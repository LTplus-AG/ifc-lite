/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Convert a picked viewer-space point (Y-up, metres) into projected
 * Eastings / Northings / Height using a model's effective IfcMapConversion.
 *
 * This is the inverse of the placement math the Cesium editor already uses: it
 * reuses {@link viewerDeltaToProjectedDelta} and {@link metersToMapUnits} so the
 * XYZ readout, the basepoint overlay, and the Cesium bridge all agree on the
 * unit- and rotation-aware transform (XAxisAbscissa/Ordinate rotation, Scale,
 * and — critically — the millimetre-vs-metre map-unit scaling that sample
 * models rely on; see #595 and the `resolveMapUnitToMetreScale` heuristic).
 *
 * Given the viewer position of the model's IFC (0,0,0) (`originViewer`), a
 * point P relates to the projected frame as:
 *
 *   d          = P - originViewer                     (viewer-space metres)
 *   (ΔE, ΔN)   = viewerDeltaToProjectedDelta(d.x, d.z) (map units, rotated/scaled)
 *   E          = MapConversion.Eastings  + ΔE
 *   N          = MapConversion.Northings + ΔN
 *   H          = MapConversion.OrthogonalHeight + metersToMapUnits(d.y)
 *
 * Values are returned in the projected CRS's authored MAP UNIT (the same unit
 * as the stored MapConversion offsets — millimetres for the bundled sample),
 * so `E/N/H` for the origin equal the file's MapConversion values exactly. The
 * height is the authored orthogonal height above the CRS vertical datum; there
 * is no in-browser vertical-datum transform (matches ifc-origin.ts).
 *
 * The rotation sign convention matches rust/core/src/georef.rs `local_to_map`.
 */

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { hasStandardGeoreferencing, type EffectiveGeoreference } from './effective-georef';
import { metersToMapUnits, viewerDeltaToProjectedDelta } from './cesium-placement';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * An {@link EffectiveGeoreference} narrowed to one that carries a usable
 * map-conversion georeference (a projected CRS name plus a MapConversion, and
 * not a bare IfcSite lat/lon).
 */
export type MapGeoreference = EffectiveGeoreference & {
  mapConversion: MapConversion;
  projectedCRS: ProjectedCRS;
};

/**
 * Projected coordinate of a picked point, in the CRS's authored map unit.
 */
export interface ProjectedPoint {
  /** Easting offset from the CRS origin, in the map unit (as authored). */
  eastings: number;
  /** Northing offset from the CRS origin, in the map unit (as authored). */
  northings: number;
  /** Orthogonal height above the vertical datum, in the map unit. */
  height: number;
  /** Projected CRS identifier, e.g. `"EPSG:32760"`. */
  crsName: string;
}

/**
 * True when `eff` carries a map-conversion georeference the XYZ readout can use:
 * a projected CRS name plus a MapConversion, and NOT a bare IfcSite lat/lon
 * (`source === 'siteLocation'`), which has no projected frame to place a point
 * in. Delegates to {@link hasStandardGeoreferencing} so the guard never drifts
 * from the rest of the georef stack.
 */
export function hasUsableMapGeoref(
  eff: EffectiveGeoreference | null | undefined,
): eff is MapGeoreference {
  return hasStandardGeoreferencing(eff ?? null);
}

/**
 * Project a picked viewer point into the CRS of `eff`. `originViewer` is the
 * viewer-space position of `eff`'s model IFC (0,0,0) — for the federation
 * anchor (or a standalone model) that is `-totalYupOffset(coordinateInfo)`,
 * computable synchronously (no proj4 hop).
 */
export function viewerPointToProjected(
  point: Vec3,
  eff: MapGeoreference,
  originViewer: Vec3,
): ProjectedPoint {
  const { mapConversion, projectedCRS, lengthUnitScale } = eff;
  const dx = point.x - originViewer.x;
  const dy = point.y - originViewer.y;
  const dz = point.z - originViewer.z;

  const delta = viewerDeltaToProjectedDelta(
    dx,
    dz,
    mapConversion,
    projectedCRS,
    lengthUnitScale,
  );

  return {
    eastings: mapConversion.eastings + delta.eastings,
    northings: mapConversion.northings + delta.northings,
    height: mapConversion.orthogonalHeight + metersToMapUnits(dy, projectedCRS, lengthUnitScale),
    crsName: projectedCRS.name,
  };
}
