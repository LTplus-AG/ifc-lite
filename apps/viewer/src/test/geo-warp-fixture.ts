/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared inputs for the GeoWarp tests: the PROJ oracle's 20 km grid lines as
 * an `IfcRigidOperation` model, and the stated geoid plane the oracle used.
 */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import PROJ_ORACLE from '../lib/geo/__fixtures__/proj-oracle.json' with { type: 'json' };
import type { EnuFrame } from '../lib/geo/geo-ecef.js';
import { createGeoMapping, type GeoMapping, type GeoWarpOrigin } from '../lib/geo/geo-warp.js';

export type WarpCase = (typeof PROJ_ORACLE.warp)[number];

/**
 * The rigid operation's local origin sits this far (IFC metres) from the
 * oracle anchor, so local and map coordinates differ and the offset is used.
 */
export const RIGID_OFFSET = { x: 1234.5, y: -678.25 };

/** The oracle's geoid plane about its anchor: N = n0 + perDegLat·Δlat + perDegLon·Δlon. */
export function geoidPlane(anchor: { lat: number; lon: number }) {
  const g = PROJ_ORACLE.warpGeoid;
  return (lat: number, lon: number) => g.n0 + g.perDegLat * (lat - anchor.lat) + g.perDegLon * (lon - anchor.lon);
}

/** Viewer coordinates of a grid point: IFC (dE + ox, dN + oy, H) → viewer (x, z up, −y). */
export const gridViewer = (p: { dE: number; dN: number; H: number }) =>
  [p.dE + RIGID_OFFSET.x, p.H, -(p.dN + RIGID_OFFSET.y)] as const;

/** The oracle line as an IfcRigidOperation model whose box is the line's own. */
export function rigidLine(c: WarpCase): {
  mapConversion: MapConversion;
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'>;
  coordinateInfo: CoordinateInfo;
} {
  const xs = c.points.map((p) => gridViewer(p)[0]);
  const ys = c.points.map((p) => p.H);
  const zs = c.points.map((p) => gridViewer(p)[2]);
  const shiftedBounds = {
    min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
    max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
  };
  return {
    mapConversion: {
      id: 1, sourceCRS: 2, targetCRS: 3, operation: 'rigidOperation',
      eastings: c.anchor.E - RIGID_OFFSET.x, northings: c.anchor.N - RIGID_OFFSET.y, orthogonalHeight: 0,
    },
    projectedCRS: { mapUnitScale: 1 },
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, shiftedBounds, originalBounds: shiftedBounds, hasLargeCoordinates: false },
  };
}

/** An anchor-ENU point back to ECEF through the frame (compared with PROJ's ECEF). */
export function ecefOf(frame: EnuFrame, enu: ArrayLike<number>): number[] {
  const out = [0, 0, 0];
  frame.toEcef(enu[0], enu[1], enu[2], out);
  return out;
}

export const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The anchor exactly as PROJ placed it, as `computeCesiumModelOrigin` returns it for `rigidLine`. */
export function rigidOrigin(c: WarpCase): GeoWarpOrigin {
  return {
    longitude: c.anchor.lon, latitude: c.anchor.lat, height: c.anchor.h, ifcOriginHeight: c.anchor.H,
    easting: c.anchor.E, northing: c.anchor.N, scaleX: 1, scaleY: 1, scaleZ: 1,
    combinedScaleFactor: 1, gridSource: 'rigidOperation',
  };
}

/** `rigidLine` through the exact mapping, with the oracle's geoid plane. */
export function rigidMapping(c: WarpCase): GeoMapping {
  const m = createGeoMapping({ ...rigidLine(c), projDef: c.proj4, origin: rigidOrigin(c), geoid: geoidPlane(c.anchor) });
  if (!m) throw new Error(`no mapping for ${c.case}`);
  return m;
}
